package main

// Independently authored from named ZoneBattle messages and our offline
// reconstruction/enrichment scripts. This file contains no RKPP decoder code.
import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const battleLiveSource = "rkpp-live-v1"
const battleLiveMaxPending = 128

var errBattleLive = errors.New("invalid or conflicting supported battle message")

// BattleStreamAssembler owns only bounded, allowlisted in-memory battle facts.
// One instance represents one ordered relay/archive stream; it does no I/O.
// Push is serialized and a rejected frame never partially changes its state.
type BattleStreamAssembler struct {
	mu          sync.Mutex
	active      string
	aliasActive string // opening-anchored query window; cleared by conflicting context
	states      map[string]*battleLiveState
}
type battleLiveState struct {
	Record       BattleRecord
	Open         bool
	Finished     bool
	Events       map[string]BattleEvent
	Links        map[string]battleLiveLink
	Costs        map[string]battleLiveCost
	Sync         map[string]battleLiveSync
	SideCodes    map[int]string    // protocol battle sides, never account identities
	Bindings     map[string]string // exact observed runtime -> configuration pairs
	SkillAliases map[string]string // round/caster/runtime -> original runtime, identity only
	Last         [32]byte
}
type battleLiveLink struct {
	Group, Ref int
	Head       bool
	Source     string
}
type battleLiveCost struct {
	Round, Seq, Index int
	Actor, Skill      string
	Config            string
	Cost              *int
}
type battleLiveSync struct{ HPChange, HPAfter, EnergyChange, EnergyAfter, Damage *int }

func NewBattleStreamAssembler() *BattleStreamAssembler {
	return &BattleStreamAssembler{states: map[string]*battleLiveState{}}
}

// Pending counts unfinished recognized battles, never pending frames.
func (a *BattleStreamAssembler) Pending() int {
	if a == nil {
		return 0
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for _, s := range a.states {
		if !s.Finished {
			n++
		}
	}
	return n
}

// Push accepts RKPP envelopes with opcode/opencode/opcode_hex and named JSON
// content (object or JSON string). Recognized pending and replay frames return
// accepted=true, even when no finalized record is emitted. Only matching explicit
// ZoneBattleFinishNotify finalizes; previews, timeouts and is_battle_finished do not.
func (a *BattleStreamAssembler) Push(frame []byte) (records []BattleRecord, accepted bool, err error) {
	if a == nil {
		return nil, false, errBattleLive
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(frame) == 0 || len(frame) > BattleMaxImportBytes {
		return nil, false, errBattleLive
	}
	raw, e := battleReadJSON(bytes.TrimSpace(bytes.TrimPrefix(frame, []byte{0xef, 0xbb, 0xbf}))) // strict duplicate/depth checks + Decoder.UseNumber
	if e != nil {
		return nil, false, errBattleLive
	}
	if canonical, valid := battleLiveCanonicalShape(raw, 0); canonical {
		if !valid {
			return nil, true, errBattleLive
		}
		records, _, e := DecodeBattleImport(frame)
		if e != nil {
			return nil, true, errBattleLive
		}
		return records, true, nil // caller-declared canonical records; keep original Source
	}
	obj := battleObject(raw)
	if obj == nil {
		return nil, false, nil
	}
	op, body, recognized, e := battleLiveEnvelope(obj)
	if e != nil {
		return nil, recognized, errBattleLive
	}
	if !recognized {
		return nil, false, nil
	}
	if op == 0x1316 && body["is_reconnect"] != nil {
		reconnect, ok := body["is_reconnect"].(bool)
		if !ok {
			return nil, true, errBattleLive
		}
		if reconnect {
			return nil, true, nil
		} // a current reconnect snapshot is not initial metadata
	}
	if body["perform_cmd"] != nil && battleObject(body["perform_cmd"]) == nil {
		return nil, true, errBattleLive
	}
	// Query items are identity evidence only, never commands or a settlement.
	if op == 0x1336 {
		return nil, true, a.skillAliasQuery(body)
	}
	// These are command selections, acknowledgements or non-primary previews,
	// not execution evidence. In particular their settle_info is never a finish.
	switch op {
	case 0x1316, 0x131a, 0x1324, 0x132c:
	default:
		return nil, true, nil
	}
	var id string
	switch op {
	case 0x1316:
		id, e = battleLiveID(battleObject(body["init_info"])["battle_id"], true)
	case 0x131a:
		id, e = battleLiveID(battleObject(body["state_info"])["battle_id"], true)
	case 0x132c:
		id, e = battleLiveID(battleObject(body["settle_info"])["battle_id"], true)
	case 0x1324:
		if body["battle_id"] != nil {
			id, e = battleLiveID(body["battle_id"], true)
		} else {
			id = a.active
		}
	}
	if e != nil {
		return nil, true, errBattleLive
	}
	if id == "" {
		return nil, true, nil
	} // orphan ID-less execution is never guessed
	if op == 0x1324 && a.active != "" && id != a.active {
		return nil, true, errBattleLive
	}
	if a.states == nil {
		a.states = map[string]*battleLiveState{}
	}
	prev := a.states[id]
	if prev == nil && len(a.states) >= battleLiveMaxPending {
		return nil, true, errors.New("battle stream capacity exceeded; start a fresh bounded stream")
	}
	s := battleLiveNewState(id)
	if prev != nil {
		s, e = battleLiveCloneState(prev)
		if e != nil {
			return nil, true, errBattleLive
		}
	}
	active := a.active
	switch op {
	case 0x1316:
		info := battleObject(body["init_info"])
		if e = s.opening(info, body); e == nil {
			s.Open = true
			active = id
		}
	case 0x131a:
		info := battleObject(body["state_info"])
		var round, seq int
		round, e = battleLiveInt(info["round"], 0, 1000000, false)
		if e == nil {
			seq, e = battleLiveInt(info["data_seq_num"], 0, 1000000000, false)
		}
		if e == nil {
			e = s.lifecycle("round_start", round, seq)
		}
		if e == nil {
			e = s.command(battleObject(body["perform_cmd"]))
		}
	case 0x1324:
		e = s.command(battleObject(body["perform_cmd"]))
	case 0x132c:
		e = s.settlement(battleObject(body["settle_info"]), body)
		if e == nil {
			s.Finished = true
			e = s.lifecycle("finish", s.Record.Rounds, 0)
		}
		if active == id {
			active = ""
		}
	}
	if e != nil {
		return nil, true, errBattleLive
	}
	// Finished-state complements are emitted only on the next matching finish,
	// not on replay opening/round notifications.
	if op == 0x132c && s.Open && s.Finished {
		r, e := s.finalize()
		if e != nil {
			return nil, true, errBattleLive
		}
		b, e := json.Marshal(r)
		if e != nil {
			return nil, true, errBattleLive
		}
		sum := sha256.Sum256(b)
		if sum != s.Last {
			records = []BattleRecord{r}
			s.Last = sum
		}
	}
	// Only committed frames affect query association. An unrelated explicit
	// round/finish breaks an ID-less query's opening window even if that other
	// battle is already finished; it must not silently fall back to this one.
	if a.active != "" && id != a.active || active == "" {
		a.aliasActive = ""
	}
	if op == 0x1316 {
		a.aliasActive = id
	}
	a.states[id] = s
	a.active = active
	return records, true, nil
}

var battleLiveNames = map[int]string{
	0x1316: "ZoneBattleEnterNotify", 0x131a: "ZoneBattleRoundStartNotify", 0x1324: "ZoneBattlePerformStartNotify", 0x132c: "ZoneBattleFinishNotify",
	0x13f3: "ZoneBattlePrePlayNotify", 0x13fc: "ZoneBattlePvpPerformStartNotify", 0x1322: "ZoneBattleCmdSyncNotify",
	0x1306: "ZoneBattleLoadFinishRsp", 0x1314: "ZoneBattleRoundFlowFinishRsp", 0x130c: "ZoneBattleCmdPushbackRsp", 0x130a: "ZoneBattleSupplyPetRsp",
	0x1336: "ZoneBattleRoundOpQueryRsp", 0x13f9: "ZoneBattlePkAgainNotify", 0x133a: "ZoneBattlePlayerExitRsp", 0x132f: "ZoneBattlePlayerRunawayRsp",
}

func battleLiveEnvelope(obj map[string]any) (int, map[string]any, bool, error) {
	op := 0
	invalid := false
	supportedSeen := false
	metas := []map[string]any{obj}
	if battleObject(obj["summary_obj"]) != nil {
		metas = append(metas, battleObject(obj["record"]))
	}
	for _, m := range metas {
		for _, k := range []string{"opcode", "opencode", "opcode_hex"} {
			if m[k] == nil {
				continue
			}
			n, e := battleOpcode(m[k])
			if e != nil {
				invalid = true
				continue
			}
			if op != 0 && op != n {
				invalid = true
			}
			op = n
			supportedSeen = supportedSeen || battleLiveNames[n] != ""
		}
	}
	named := 0
	for _, k := range []string{"meaning", "message_name", "proto_name"} {
		if name, ok := obj[k].(string); ok {
			for n, v := range battleLiveNames {
				if name == v {
					named = n
				}
			}
		}
	}
	if op == 0 {
		op = named
	}
	recognized := supportedSeen || named != 0 || battleLiveNames[op] != ""
	if !recognized {
		return 0, nil, false, nil
	}
	if invalid || named != 0 && named != op {
		return op, nil, true, errBattleLive
	}
	for _, k := range []string{"content", "decoded_json", "summary_json", "summary_obj"} {
		v := obj[k]
		if v == nil || v == "" {
			continue
		}
		if text, ok := v.(string); ok {
			if len(text) > BattleMaxImportBytes {
				return op, nil, true, errBattleLive
			}
			var e error
			v, e = battleReadJSON([]byte(text))
			if e != nil {
				return op, nil, true, errBattleLive
			}
		}
		m := battleObject(v)
		if m == nil {
			return op, nil, true, errBattleLive
		}
		return op, m, true, nil
	}
	return op, nil, true, errBattleLive
}
func battleLiveNewState(id string) *battleLiveState {
	return &battleLiveState{Record: BattleRecord{Version: 1, ID: "rkpp:" + id, Source: battleLiveSource, Mode: "unknown", Outcome: "unknown", Sides: map[string]BattleSide{"me": {Pets: []BattlePet{}}, "enemy": {Pets: []BattlePet{}}}, Quality: BattleQuality{Roster: map[string]bool{}, Lead: map[string]bool{}}, Issues: []string{"Named primary battle facts retained; unsupported effects, growth, hidden profiles and action coverage remain unknown."}}, Events: map[string]BattleEvent{}, Links: map[string]battleLiveLink{}, Costs: map[string]battleLiveCost{}, Sync: map[string]battleLiveSync{}, SideCodes: map[int]string{}, Bindings: map[string]string{}, SkillAliases: map[string]string{}}
}
func battleLiveCloneState(s *battleLiveState) (*battleLiveState, error) {
	b, e := json.Marshal(s)
	if e != nil {
		return nil, e
	}
	out := new(battleLiveState)
	if e = json.Unmarshal(b, out); e != nil {
		return nil, e
	}
	return out, nil
}
func battleLiveID(v any, required bool) (string, error) {
	if v == nil && !required {
		return "", nil
	}
	text := ""
	switch n := v.(type) {
	case json.Number:
		text = n.String()
	case string:
		text = n
	default:
		return "", errBattleLive
	}
	if text == "" || strings.Trim(text, "0123456789") != "" {
		return "", errBattleLive
	}
	n, e := strconv.ParseUint(text, 10, 64)
	if e != nil || required && n == 0 {
		return "", errBattleLive
	}
	if n == 0 {
		return "", nil
	}
	return strconv.FormatUint(n, 10), nil
}
func battleLivePetID(v any, required bool) (string, error) {
	id, e := battleLiveID(v, required)
	if e != nil || id == "" {
		return id, e
	}
	n, e := strconv.ParseUint(id, 10, 32)
	if e != nil {
		return "", errBattleLive
	}
	return strconv.FormatUint(n, 10), nil
}
func battleLiveInt(v any, lo, hi int, required bool) (int, error) {
	if v == nil && !required {
		return 0, nil
	}
	n, ok := v.(json.Number)
	if !ok {
		return 0, errBattleLive
	}
	i, e := strconv.ParseInt(n.String(), 10, 64)
	if e != nil || i < int64(lo) || i > int64(hi) {
		return 0, errBattleLive
	}
	return int(i), nil
}
func battleLiveSigned(v any) (int, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, errBattleLive
	}
	i, e := strconv.ParseInt(n.String(), 10, 64)
	if e != nil {
		u, er := strconv.ParseUint(n.String(), 10, 64)
		if er != nil || u < 1<<63 {
			return 0, errBattleLive
		}
		i = int64(u)
	}
	if i < -1<<31 || i > 1<<31-1 {
		return 0, errBattleLive
	}
	return int(i), nil
}
func battleLiveEnum(v any) (int, error) {
	if m := battleObject(v); m != nil {
		v = m["value"]
	}
	return battleLiveInt(v, 0, 1<<31-1, true)
}
func battleLiveArray(v any, limit int) ([]any, error) { return battleNamedArray(v, limit) }
func battleLivePtr(v any, lo, hi int) (*int, error) {
	if v == nil {
		return nil, nil
	}
	n, e := battleLiveInt(v, lo, hi, true)
	if e != nil {
		return nil, e
	}
	return &n, nil
}
func battleLiveTime(v any) (string, error) {
	if v == nil {
		return "", nil
	}
	n, e := battleLiveInt(v, 1, 1<<32-1, true)
	if e != nil {
		return "", e
	}
	return time.Unix(int64(n), 0).UTC().Format(time.RFC3339), nil
}
func (s *battleLiveState) actor(id string) string {
	if id == "" {
		return "unknown"
	}
	side := "unknown"
	for name, team := range s.Record.Sides {
		for _, p := range team.Pets {
			if p.InstanceID == id {
				if side != "unknown" {
					return "unknown"
				}
				side = name
			}
		}
	}
	return side
}
func (s *battleLiveState) key(round, seq, index int, kind, target string) string {
	return fmt.Sprintf("%s:live:%d:%d:%d:%s:%s", s.Record.ID, round, seq, index, kind, target)
}
func (s *battleLiveState) put(e BattleEvent) error {
	if old, ok := s.Events[e.ID]; ok {
		if er := battleMergeKnown(&old, e); er != nil {
			return errBattleLive
		}
		s.Events[e.ID] = old
		return nil
	}
	if len(s.Events) >= BattleMaxEvents {
		return errBattleLive
	}
	s.Events[e.ID] = e
	return nil
}
func (s *battleLiveState) lifecycle(kind string, round, seq int) error {
	return s.put(BattleEvent{ID: s.key(round, seq, 0, kind, ""), Round: round, Seq: seq, Kind: "note", Phase: "unknown", Side: "unknown", Lifecycle: kind})
}
func (s *battleLiveState) finalize() (BattleRecord, error) {
	r, e := battleClone(s.Record)
	if e != nil {
		return r, e
	}
	r.Events = []BattleEvent{}
	for _, event := range s.Events {
		if event.Side == "unknown" && event.Actor != "" {
			event.Side = s.actor(event.Actor)
		}
		if event.TargetSide == "unknown" && event.Target != "" {
			event.TargetSide = s.actor(event.Target)
		}
		r.Events = append(r.Events, event)
	}
	sort.Slice(r.Events, func(i, j int) bool {
		a, b := r.Events[i], r.Events[j]
		if a.Round != b.Round {
			return a.Round < b.Round
		}
		if a.Seq != b.Seq {
			return a.Seq < b.Seq
		}
		ai, bi := 0, 0
		if a.ExecIndex != nil {
			ai = *a.ExecIndex
		}
		if b.ExecIndex != nil {
			bi = *b.ExecIndex
		}
		if ai != bi {
			return ai < bi
		}
		return a.ID < b.ID
	})
	// Events contain pointers; isolate them before deriving links/costs so neither
	// finalization nor caller mutations can affect the replay accumulator.
	r, e = battleClone(r)
	if e != nil {
		return r, e
	}
	if e = s.enrichFinal(&r); e != nil {
		return r, e
	}
	sort.Strings(r.Issues)
	// Validation mutates coverage for unmapped IDs. Validate an isolated copy;
	// Service.Import maps protocol identities before validating the emitted facts.
	checked, e := battleClone(r)
	if e != nil {
		return r, e
	}
	if e = ValidateBattleRecord(&checked); e != nil {
		return r, e
	}
	return r, nil
}
