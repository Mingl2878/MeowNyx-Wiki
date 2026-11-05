package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"strings"
)

// This adapter was independently authored against the JSON shapes inspected in
// rkpp_relay.py:_build_event, rkpp_io.py:build_opcode_summary,
// rkpp_analyzer.py:_summarize/_attach_row_summary and
// rkpp_proto_battle.py:extract_1316_enter/131a_round_start/132c_finish.
// No protocol decoder implementation is included or copied.
const battleRKPPWarning = "RKPP partial import: named-schema team pets and round performs can be retained, but Wiki-ID mappings, complete capture coverage, leads, outcome, rank, IV/nature units, growth and inference constraints are unverified; lifecycle-only summaries do not expose usable rosters/actions."
const battleCanonicalWarning = "Normalized completeness and evidence are importer declarations, not independently verified game facts."

// DecodeBattleImport accepts canonical records and bounded JSON/NDJSON frames.
// Malformed canonical data is an atomic error. Unsupported raw frames are
// reported without echoing any payload, credentials, account IDs or packet data.
func DecodeBattleImport(data []byte) ([]BattleRecord, []string, error) {
	issues := []string{}
	if len(data) == 0 || len(data) > BattleMaxImportBytes {
		return nil, issues, errors.New("import is empty or exceeds 16 MiB")
	}
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}))
	frames := [][]byte{}
	if json.Valid(data) {
		frames = append(frames, data)
	} else {
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			line = bytes.TrimSpace(line)
			if len(line) == 0 {
				continue
			}
			if len(line) > 2<<20 {
				return nil, issues, errors.New("NDJSON frame exceeds 2 MiB")
			}
			frames = append(frames, line)
			if len(frames) > BattleMaxEvents {
				return nil, issues, errors.New("too many import frames")
			}
		}
	}
	records := []BattleRecord{}
	slots := map[string]int{}
	seenFrames := 0
	addIssue := func(s string) {
		if !battleOneOf(s, issues...) && len(issues) < 128 {
			issues = append(issues, s)
		}
	}
	var consume func(any, int) error
	consume = func(value any, depth int) error {
		if depth > 4 {
			return errors.New("nested import envelopes are not supported")
		}
		if items, ok := value.([]any); ok {
			for _, item := range items {
				if err := consume(item, depth+1); err != nil {
					return err
				}
			}
			return nil
		}
		obj, ok := value.(map[string]any)
		if !ok {
			addIssue("Unsupported non-object frame skipped.")
			return nil
		}
		if items, has := obj["records"]; has {
			version, ok := obj["version"].(json.Number)
			if !ok || version.String() != "1" {
				return errors.New("unsupported import envelope version")
			}
			a, ok := items.([]any)
			if !ok {
				return errors.New("records must be an array")
			}
			return consume(a, depth+1)
		}
		seenFrames++
		if seenFrames > BattleMaxEvents {
			return errors.New("too many import frames")
		}
		var r BattleRecord
		canonical := obj["id"] != nil && (obj["sides"] != nil || obj["events"] != nil || obj["version"] != nil)
		if canonical {
			// Exact JSON tag whitelist, including nested maps/structs. Unknown fields
			// cannot reach stored JSON (case aliases are deliberately not accepted).
			v, err := battleWhitelist(obj, reflect.TypeOf(r), 0)
			if err != nil {
				return err
			}
			b, err := json.Marshal(v)
			if err != nil {
				return errors.New("invalid normalized JSON")
			}
			if err = json.Unmarshal(b, &r); err != nil {
				return errors.New("invalid normalized field type or number")
			}
			if err = ValidateBattleRecord(&r); err != nil {
				return err
			}
			battleIssue(&r, battleCanonicalWarning)
			addIssue(battleCanonicalWarning)
		} else {
			var err error
			r, ok, err = battleAdaptRKPP(obj)
			if err != nil {
				return err
			}
			if !ok {
				addIssue("Unsupported RKPP/raw frame skipped: no supported battle lifecycle schema with an explicit safe battle ID. Profiles, raw packets, orphan actions and move frames are not imported.")
				return nil
			}
			if err = ValidateBattleRecord(&r); err != nil {
				return err
			}
			addIssue(battleRKPPWarning)
		}
		if i, exists := slots[r.ID]; exists {
			merged, err := MergeBattleRecord(records[i], r)
			if err != nil {
				return err
			}
			records[i] = merged
		} else {
			if len(records) >= BattleMaxRecords {
				return errors.New("too many battles in one import")
			}
			slots[r.ID] = len(records)
			records = append(records, r)
		}
		return nil
	}
	for i, frame := range frames {
		v, err := battleReadJSON(frame)
		if err != nil {
			return nil, issues, fmt.Errorf("invalid JSON frame %d: %s", i+1, err.Error())
		}
		if err = consume(v, 0); err != nil {
			return nil, issues, err
		}
	}
	if len(records) == 0 {
		return nil, issues, errors.New("no supported battle records; use normalized version 1 JSON or supported RKPP lifecycle summaries (raw profile/action decoding is unsupported)")
	}
	return records, issues, nil
}

// Reject duplicate object keys, deeply nested structures and oversized token
// sets before normalizing. Decoder.UseNumber avoids any float64 ID conversion.
func battleReadJSON(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	budget := 1000000
	var read func(int) (any, error)
	read = func(depth int) (any, error) {
		budget--
		if budget < 0 || depth > 48 {
			return nil, errors.New("JSON structural limit exceeded")
		}
		token, err := d.Token()
		if err != nil {
			return nil, errors.New("malformed JSON")
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return token, nil
		}
		switch delim {
		case '{':
			m := map[string]any{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return nil, errors.New("malformed object")
				}
				key, ok := k.(string)
				if !ok {
					return nil, errors.New("invalid object key")
				}
				if _, exists := m[key]; exists {
					return nil, errors.New("duplicate JSON object key")
				}
				v, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				m[key] = v
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return nil, errors.New("malformed object")
			}
			return m, nil
		case '[':
			a := []any{}
			for d.More() {
				v, err := read(depth + 1)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return nil, errors.New("malformed array")
			}
			return a, nil
		}
		return nil, errors.New("unexpected JSON delimiter")
	}
	v, err := read(0)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON content")
	}
	return v, nil
}

func battleIdentifier(v any) (string, error) {
	if s, ok := v.(string); ok {
		if !battleID(s, true) {
			return "", errors.New("invalid identifier")
		}
		return s, nil
	}
	if n, ok := v.(json.Number); ok {
		i, err := strconv.ParseUint(n.String(), 10, 64)
		if err != nil || i > 9007199254740991 {
			return "", errors.New("unsafe numeric identifier; provide a decimal string")
		}
		return strconv.FormatUint(i, 10), nil
	}
	return "", errors.New("identifier must be a string or safe integer")
}
func battleWhitelist(v any, t reflect.Type, depth int) (any, error) {
	if depth > 32 {
		return nil, errors.New("normalized structure exceeds depth limit")
	}
	if v == nil {
		return nil, nil
	}
	if t.Kind() == reflect.Pointer {
		return battleWhitelist(v, t.Elem(), depth+1)
	}
	switch t.Kind() {
	case reflect.Struct:
		obj, ok := v.(map[string]any)
		if !ok {
			return nil, errors.New("expected normalized object")
		}
		out := map[string]any{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			key := strings.Split(f.Tag.Get("json"), ",")[0]
			val, has := obj[key]
			if !has {
				continue
			}
			if f.Type.Kind() == reflect.String && battleOneOf(key, "id", "instanceId", "protocolId", "protocolSkillId", "lead", "actor", "target") && val != nil && val != "" {
				s, err := battleIdentifier(val)
				if err != nil {
					return nil, err
				}
				out[key] = s
				continue
			}
			clean, err := battleWhitelist(val, f.Type, depth+1)
			if err != nil {
				return nil, err
			}
			out[key] = clean
		}
		return out, nil
	case reflect.Map:
		obj, ok := v.(map[string]any)
		if !ok {
			return nil, errors.New("expected normalized map")
		}
		if len(obj) > 32 {
			return nil, errors.New("normalized map exceeds limit")
		}
		out := map[string]any{}
		for k, val := range obj {
			clean, err := battleWhitelist(val, t.Elem(), depth+1)
			if err != nil {
				return nil, err
			}
			out[k] = clean
		}
		return out, nil
	case reflect.Slice:
		a, ok := v.([]any)
		if !ok {
			return nil, errors.New("expected normalized array")
		}
		if len(a) > BattleMaxEvents {
			return nil, errors.New("normalized array exceeds limit")
		}
		out := []any{}
		for _, val := range a {
			clean, err := battleWhitelist(val, t.Elem(), depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, clean)
		}
		return out, nil
	}
	return v, nil
}

func battleObject(v any) map[string]any { m, _ := v.(map[string]any); return m }
func battleOpcode(v any) (int, error) {
	if v == nil {
		return 0, nil
	}
	s := ""
	switch x := v.(type) {
	case json.Number:
		s = x.String()
	case string:
		s = x
	default:
		return 0, errors.New("invalid RKPP opcode")
	}
	base := 10
	if strings.HasPrefix(strings.ToLower(s), "0x") {
		base = 16
		s = s[2:]
	}
	n, err := strconv.ParseUint(s, base, 16)
	if err != nil {
		return 0, errors.New("invalid RKPP opcode")
	}
	return int(n), nil
}
func battleAdaptRKPP(obj map[string]any) (BattleRecord, bool, error) {
	empty := BattleRecord{}
	opcode := 0
	metadata := []map[string]any{obj}
	// The analyzer return envelope has record.opcode + summary_obj, unlike
	// exported rows and relay frames. Only opcode metadata is read from record.
	if battleObject(obj["summary_obj"]) != nil && battleObject(obj["record"]) != nil {
		metadata = append(metadata, battleObject(obj["record"]))
	}
	for _, meta := range metadata {
		for _, k := range []string{"opcode", "opencode", "opcode_hex"} {
			if meta[k] == nil {
				continue
			}
			n, err := battleOpcode(meta[k])
			if err != nil {
				return empty, false, err
			}
			if opcode != 0 && opcode != n {
				return empty, false, errors.New("conflicting RKPP opcodes")
			}
			opcode = n
		}
	}
	expected := map[int]string{0x1316: "battle_enter", 0x131a: "round_start", 0x132c: "battle_finish"}[opcode]
	if expected == "" {
		return empty, false, nil
	}
	if kind, ok := obj["summary_kind"].(string); ok && kind != "" && kind != expected && kind != "schema_decoded" {
		return empty, false, errors.New("RKPP summary kind conflicts with opcode")
	}
	var content map[string]any
	// The relay's content prefers decoded_json over summary_json. Exported rows
	// carry those JSON strings directly. summary_obj is the analyzer return shape.
	for _, key := range []string{"content", "decoded_json", "summary_json", "summary_obj"} {
		raw := obj[key]
		if raw == nil || raw == "" {
			continue
		}
		if s, ok := raw.(string); ok {
			v, err := battleReadJSON([]byte(s))
			if err != nil {
				return empty, false, nil
			}
			raw = v
		}
		content = battleObject(raw)
		if content != nil {
			break
		}
	}
	if content == nil {
		return empty, false, nil
	}
	detail := battleObject(content["detail"])
	semantic := detail != nil
	if !semantic {
		detail = content
	}
	var idValue any
	if semantic {
		idValue = detail["battle_id"]
	} else {
		key := map[int]string{0x1316: "init_info", 0x131a: "state_info", 0x132c: "settle_info"}[opcode]
		idValue = battleObject(detail[key])["battle_id"]
	}
	if idValue == nil {
		return empty, false, nil
	}
	id, err := battleIdentifier(idValue)
	if err != nil {
		return empty, false, err
	}
	if id == "0" {
		return empty, false, nil
	}
	r := BattleRecord{Version: 1, ID: "rkpp:" + id, Mode: "unknown", Outcome: "unknown", Source: "rkpp-lifecycle", Sides: map[string]BattleSide{}, Issues: []string{battleRKPPWarning}}
	// captured_at is capture time, NOT battle start/end time. Numeric protocol
	// battle_start_time units are not independently verified and are not converted.
	at := ""
	if s, ok := obj["captured_at"].(string); ok && s != "" {
		at = s
		if err := battleTime(&at); err != nil {
			at = ""
			battleIssue(&r, "Capture timestamp lacks a valid RFC3339 timezone; omitted.")
		}
	}
	round := 0
	rv := detail["round"]
	if !semantic && opcode == 0x131a {
		rv = battleObject(detail["state_info"])["round"]
	}
	if rv != nil {
		n, ok := rv.(json.Number)
		if !ok {
			return empty, false, errors.New("invalid RKPP round")
		}
		i, e := strconv.Atoi(n.String())
		if e != nil || i < 0 || i > 1000000 {
			return empty, false, errors.New("invalid RKPP round")
		}
		round = i
	}
	// A lifecycle note contains useful verified structure but makes no gameplay
	// claims. Fixed identity deduplicates retransmission independent of row_index,
	// flow_id, transport seq or captured_at (all transport/account data is dropped).
	eventID := fmt.Sprintf("rkpp:%04x:%d", opcode, round)
	r.Events = []BattleEvent{{ID: eventID, Round: round, Kind: "note", Phase: "unknown", Side: "unknown", Text: "Observed RKPP " + expected + "; gameplay attribution unavailable."}}
	// Capture times can differ on replay; don't make them event identity or start/end.
	if at != "" {
		battleIssue(&r, "Capture time is available but is not asserted as battle start/end time.")
	}
	if !semantic && (opcode == 0x1316 || opcode == 0x131a) {
		stateKey := "init_info"
		if opcode == 0x131a {
			stateKey = "state_info"
		}
		if err := battleAdaptNamed(&r, battleObject(detail[stateKey]), battleObject(detail["perform_cmd"]), opcode == 0x1316); err != nil {
			return empty, false, err
		}
	}
	return r, true, nil
}
