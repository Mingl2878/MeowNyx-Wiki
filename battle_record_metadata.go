package main

import (
	"errors"
	"reflect"
	"strings"
)

// Speed observations are explicit normalized declarations with traceable action
// references. Static skill metadata and unknown ordering modifiers cannot create
// one. The UI derives candidate configurations without writing them into pets.
type BattleSpeedObservation struct {
	ID                      string   `json:"id"`
	Round                   int      `json:"round"`
	MeEvent                 string   `json:"meEvent"`
	EnemyEvent              string   `json:"enemyEvent"`
	MeMonsterID             int      `json:"meMonsterId"`
	EnemyMonsterID          int      `json:"enemyMonsterId"`
	MeLevel                 int      `json:"meLevel"`
	EnemyLevel              int      `json:"enemyLevel"`
	MeSpeed                 int      `json:"meSpeed"`
	MePriority              *int     `json:"mePriority"`
	EnemyPriority           *int     `json:"enemyPriority"`
	First                   string   `json:"first"`
	Conditions              string   `json:"conditions"`
	PrioritiesVerified      bool     `json:"prioritiesVerified"`
	SpeedConditionsVerified bool     `json:"speedConditionsVerified"`
	Evidence                []string `json:"evidence"`
}

func battlePetSpeedValid(p BattlePet) error {
	for _, n := range []*int{p.Speed, p.SpeedMin, p.SpeedMax} {
		if n != nil && (*n < 1 || *n > 1000000) {
			return errors.New("invalid recorded speed")
		}
	}
	if p.SpeedMin != nil && p.SpeedMax != nil && *p.SpeedMin > *p.SpeedMax {
		return errors.New("invalid recorded speed range")
	}
	if p.Speed != nil && ((p.SpeedMin != nil && *p.Speed < *p.SpeedMin) || (p.SpeedMax != nil && *p.Speed > *p.SpeedMax)) {
		return errors.New("recorded speed outside declared range")
	}
	return nil
}
func battleMetadataExecutionIndex(e BattleEvent) (int, bool) {
	if e.ExecIndex != nil {
		return *e.ExecIndex, true
	}
	if e.Kind == "form" && e.Form != nil {
		return e.Form.ExecIndex, true
	}
	return 0, false
}
func battleEventBefore(a, b BattleEvent) bool {
	if a.Round != b.Round {
		return a.Round < b.Round
	}
	if a.Seq != b.Seq {
		return a.Seq < b.Seq
	}
	ai, aok := battleMetadataExecutionIndex(a)
	bi, bok := battleMetadataExecutionIndex(b)
	return aok && bok && ai < bi
}
func battleSpeciesAt(r *BattleRecord, e BattleEvent) int {
	id := 0
	for _, p := range r.Sides[e.Side].Pets {
		if p.InstanceID == e.Actor {
			id = p.MonsterID
			break
		}
	}
	var latest *BattleEvent
	for i := range r.Events {
		f := &r.Events[i]
		if f.Kind == "form" && f.Phase == "executed" && f.Side == e.Side && f.Actor == e.Actor && f.Form != nil && battleEventBefore(*f, e) && (latest == nil || battleEventBefore(*latest, *f)) {
			latest = f
		}
	}
	if latest != nil {
		id = latest.Form.ToMonsterID
	}
	return id
}
func battleDisplayMetadataValid(r *BattleRecord) error {
	if r.DurationSeconds != nil && (*r.DurationSeconds < 0 || *r.DurationSeconds > 31536000) {
		return errors.New("invalid battle duration")
	}
	events := map[string]BattleEvent{}
	for _, e := range r.Events {
		events[e.ID] = e
	}
	seen := map[string]BattleSpeedObservation{}
	pairs := map[string]bool{}
	clean := []BattleSpeedObservation{}
	for _, o := range r.SpeedObservations {
		if !battleID(o.ID, true) || o.Round < 1 || o.Round > 1000000 || (r.Rounds > 0 && o.Round > r.Rounds) || !battleID(o.MeEvent, true) || !battleID(o.EnemyEvent, true) || o.MeEvent == o.EnemyEvent {
			return errors.New("invalid speed observation identity")
		}
		if o.MeLevel < 1 || o.MeLevel > 99 || o.EnemyLevel < 1 || o.EnemyLevel > 99 || o.MeSpeed < 1 || o.MeSpeed > 1000000 || o.MeMonsterID < 1 || o.EnemyMonsterID < 1 {
			return errors.New("invalid speed observation values")
		}
		if !o.PrioritiesVerified || !o.SpeedConditionsVerified || o.MePriority == nil || o.EnemyPriority == nil || *o.MePriority != *o.EnemyPriority || *o.MePriority < -1000000 || *o.MePriority > 1000000 {
			return errors.New("unverified speed-order conditions")
		}
		var err error
		o.Conditions, err = battleText(o.Conditions, 128)
		if err != nil || strings.TrimSpace(o.Conditions) == "" {
			return errors.New("speed condition identity required")
		}
		if len(o.Evidence) == 0 || len(o.Evidence) > 16 {
			return errors.New("speed observation evidence required")
		}
		for i, s := range o.Evidence {
			o.Evidence[i], err = battleText(s, 512)
			if err != nil || strings.TrimSpace(o.Evidence[i]) == "" {
				return errors.New("invalid speed observation evidence")
			}
		}
		me, mok := events[o.MeEvent]
		enemy, eok := events[o.EnemyEvent]
		if !mok || !eok || me.Side != "me" || enemy.Side != "enemy" || me.Round != o.Round || enemy.Round != o.Round {
			return errors.New("speed observation has wrong action references")
		}
		for _, e := range []BattleEvent{me, enemy} {
			if e.Kind != "skill" || e.Phase != "executed" || e.SkillClass != "ordinary" || e.ExecIndex == nil {
				return errors.New("speed observation requires executed ordinary actions")
			}
		}
		if battleSpeciesAt(r, me) != o.MeMonsterID || battleSpeciesAt(r, enemy) != o.EnemyMonsterID {
			return errors.New("speed observation species does not match action-time form")
		}
		if (o.First == "me" && !battleEventBefore(me, enemy)) || (o.First == "enemy" && !battleEventBefore(enemy, me)) || !battleOneOf(o.First, "me", "enemy") {
			return errors.New("speed observation first actor conflicts with action order")
		}
		if old, ok := seen[o.ID]; ok {
			if !reflect.DeepEqual(old, o) {
				return errors.New("conflicting speed observation ID")
			}
			continue
		}
		pair := o.MeEvent + "\x00" + o.EnemyEvent
		if pairs[pair] {
			return errors.New("duplicate speed action pair")
		}
		pairs[pair] = true
		seen[o.ID] = o
		clean = append(clean, o)
	}
	if r.SpeedObservations != nil {
		r.SpeedObservations = clean
	}
	return nil
}
func battleMergeDisplayMetadata(a *BattleRecord, b BattleRecord) error {
	if err := battleMergeKnown(&a.DurationSeconds, b.DurationSeconds); err != nil {
		return err
	}
	ids := map[string]BattleSpeedObservation{}
	for _, o := range a.SpeedObservations {
		ids[o.ID] = o
	}
	for _, o := range b.SpeedObservations {
		if old, ok := ids[o.ID]; ok {
			if !reflect.DeepEqual(old, o) {
				return errors.New("conflicting speed observation ID")
			}
		} else {
			a.SpeedObservations = append(a.SpeedObservations, o)
			ids[o.ID] = o
		}
	}
	return nil
}
