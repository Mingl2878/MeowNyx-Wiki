package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func battleStateTestBool(v bool) *bool { return &v }

func TestBattleStateFieldsValidAndBounds(t *testing.T) {
	cases := []BattleEvent{
		{},
		{Kind: "damage", HPMax: domainInt(1), HPAfter: domainInt(0)},
		{Kind: "heal", HPMax: domainInt(2147483647), HPAfter: domainInt(2147483647)},
		{Kind: "resource", HPMax: domainInt(500)},
		{Kind: "skill", Phase: "executed", EnergyCost: domainInt(0)},
		{Kind: "skill", Phase: "interrupted", EnergyCost: domainInt(2147483647)},
		{Kind: "effect", SkillClass: "system", Phase: "executed", EnergyCost: domainInt(0)},
		{Kind: "effect", SkillClass: "system", Phase: "interrupted", EnergyCost: domainInt(1)},
		{Kind: "resource", Phase: "executed", Side: "me", Actor: "m1", StateStage: "initial", Round: 0, StateActive: battleStateTestBool(false), HPMax: domainInt(500), HPAfter: domainInt(50)},
		{Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e1", StateStage: "snapshot", Round: 1, StateActive: battleStateTestBool(true)},
		{Kind: "resource", Phase: "executed", Side: "me", Actor: "m1", StateStage: "entry", Round: 5},
	}
	for i, event := range cases {
		before := event
		if err := battleValidateStateFields(&event); err != nil {
			t.Errorf("valid case %d: %v", i, err)
		}
		if !reflect.DeepEqual(event, before) {
			t.Errorf("validation changed event %d", i)
		}
	}
}

func TestBattleStateFieldsRejectInvalidMeasurements(t *testing.T) {
	cases := map[string]BattleEvent{
		"zero max":               {Kind: "resource", HPMax: domainInt(0)},
		"negative max":           {Kind: "resource", HPMax: domainInt(-1)},
		"overflow max":           {Kind: "damage", HPMax: domainInt(2147483648)},
		"max on skill":           {Kind: "skill", HPMax: domainInt(500)},
		"max on effect":          {Kind: "effect", HPMax: domainInt(500)},
		"max on note":            {Kind: "note", HPMax: domainInt(500)},
		"max on form":            {Kind: "form", HPMax: domainInt(500)},
		"HP exceeds max":         {Kind: "resource", HPMax: domainInt(1), HPAfter: domainInt(2)},
		"negative cost":          {Kind: "skill", Phase: "executed", EnergyCost: domainInt(-1)},
		"overflow cost":          {Kind: "skill", Phase: "executed", EnergyCost: domainInt(2147483648)},
		"cost on resource":       {Kind: "resource", Phase: "executed", SkillClass: "system", EnergyCost: domainInt(0)},
		"cost on damage":         {Kind: "damage", Phase: "executed", EnergyCost: domainInt(0)},
		"cost on passive":        {Kind: "effect", Phase: "executed", SkillClass: "passive", EnergyCost: domainInt(0)},
		"cost on untyped effect": {Kind: "effect", Phase: "executed", EnergyCost: domainInt(0)},
		"cost on preview":        {Kind: "skill", Phase: "preview", EnergyCost: domainInt(0)},
		"cost on selection":      {Kind: "skill", Phase: "selection", EnergyCost: domainInt(0)},
		"cost phase unknown":     {Kind: "skill", Phase: "unknown", EnergyCost: domainInt(0)},
		"cost phase absent":      {Kind: "skill", EnergyCost: domainInt(0)},
	}
	for name, event := range cases {
		t.Run(name, func(t *testing.T) {
			before := event
			if err := battleValidateStateFields(&event); err == nil {
				t.Fatal("accepted invalid state measurement")
			}
			if !reflect.DeepEqual(event, before) {
				t.Fatal("invalid validation mutated event")
			}
		})
	}
	if err := battleValidateStateFields(nil); err == nil {
		t.Fatal("accepted nil event")
	}
}

func TestBattleStateFieldsStageAndActiveConstraints(t *testing.T) {
	valid := BattleEvent{Kind: "resource", Phase: "executed", Side: "me", Actor: "m1", StateStage: "initial", StateActive: battleStateTestBool(false)}
	cases := map[string]func(*BattleEvent){
		"unknown stage":          func(e *BattleEvent) { e.StateStage = "round_start" },
		"whitespace stage":       func(e *BattleEvent) { e.StateStage = " initial" },
		"stage on skill":         func(e *BattleEvent) { e.Kind = "skill" },
		"stage on damage":        func(e *BattleEvent) { e.Kind = "damage" },
		"stage on heal":          func(e *BattleEvent) { e.Kind = "heal" },
		"stage on effect":        func(e *BattleEvent) { e.Kind = "effect" },
		"stage preview":          func(e *BattleEvent) { e.Phase = "preview" },
		"stage interrupted":      func(e *BattleEvent) { e.Phase = "interrupted" },
		"stage unknown phase":    func(e *BattleEvent) { e.Phase = "unknown" },
		"stage absent phase":     func(e *BattleEvent) { e.Phase = "" },
		"stage unknown side":     func(e *BattleEvent) { e.Side = "unknown" },
		"stage absent side":      func(e *BattleEvent) { e.Side = "" },
		"stage invalid side":     func(e *BattleEvent) { e.Side = "team3" },
		"stage absent actor":     func(e *BattleEvent) { e.Actor = "" },
		"stage malformed actor":  func(e *BattleEvent) { e.Actor = " m1" },
		"initial positive round": func(e *BattleEvent) { e.Round = 1 },
		"initial negative round": func(e *BattleEvent) { e.Round = -1 },
		"snapshot zero round":    func(e *BattleEvent) { e.StateStage = "snapshot" },
		"snapshot negative":      func(e *BattleEvent) { e.StateStage = "snapshot"; e.Round = -1 },
		"entry zero round":       func(e *BattleEvent) { e.StateStage = "entry" },
		"entry negative round":   func(e *BattleEvent) { e.StateStage = "entry"; e.Round = -1 },
		"active false no stage":  func(e *BattleEvent) { e.StateStage = "" },
		"active true no stage":   func(e *BattleEvent) { e.StateStage = ""; e.StateActive = battleStateTestBool(true) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			event := valid
			change(&event)
			if err := battleValidateStateFields(&event); err == nil {
				t.Fatal("accepted invalid stage/active fields")
			}
		})
	}
	for _, stage := range []string{"initial", "snapshot", "entry"} {
		event := valid
		event.StateStage = stage
		event.StateActive = nil
		if stage != "initial" {
			event.Round = 1
		}
		if err := battleValidateStateFields(&event); err != nil || event.StateActive != nil {
			t.Fatalf("stage inferred active state: %+v %v", event, err)
		}
	}
}

func TestBattleStateFieldsMergeSymmetricAndKnownZeroFalse(t *testing.T) {
	fields := []struct {
		name string
		set  func(*BattleEvent)
	}{
		{"hpMax", func(e *BattleEvent) { e.HPMax = domainInt(500) }},
		{"energyCost", func(e *BattleEvent) { e.EnergyCost = domainInt(0) }},
		{"stateStage", func(e *BattleEvent) { e.StateStage = "initial" }},
		{"stateActive", func(e *BattleEvent) { e.StateActive = battleStateTestBool(false) }},
	}
	for _, field := range fields {
		t.Run(field.name, func(t *testing.T) {
			for _, reverse := range []bool{false, true} {
				a, b := BattleEvent{}, BattleEvent{}
				field.set(&b)
				want := b
				if reverse {
					a, b = b, a
				}
				if err := battleMergeStateFields(&a, &b); err != nil || !reflect.DeepEqual(a, want) || !reflect.DeepEqual(b, want) {
					t.Fatalf("symmetric fill failed: %+v %+v %v", a, b, err)
				}
			}
		})
	}
	a := BattleEvent{ID: "left", Kind: "skill", Phase: "executed", SkillID: 351, Actor: "m1", HPAfter: domainInt(50), HPMax: domainInt(500), EnergyCost: domainInt(0)}
	b := BattleEvent{ID: "right", Kind: "resource", Phase: "selection", SkillID: 74, Actor: "e1", HPAfter: domainInt(100), StateStage: "snapshot", StateActive: battleStateTestBool(false)}
	beforeA, beforeB := a, b
	if err := battleMergeStateFields(&a, &b); err != nil {
		t.Fatal(err)
	}
	for _, event := range []BattleEvent{a, b} {
		if *event.HPMax != 500 || *event.EnergyCost != 0 || event.StateStage != "snapshot" || *event.StateActive {
			t.Fatal("metadata not symmetrically enriched")
		}
	}
	// The metadata helper is not a whole-event merger or gameplay rule engine.
	a.HPMax, a.EnergyCost, a.StateStage, a.StateActive = beforeA.HPMax, beforeA.EnergyCost, beforeA.StateStage, beforeA.StateActive
	b.HPMax, b.EnergyCost, b.StateStage, b.StateActive = beforeB.HPMax, beforeB.EnergyCost, beforeB.StateStage, beforeB.StateActive
	if !reflect.DeepEqual(a, beforeA) || !reflect.DeepEqual(b, beforeB) {
		t.Fatal("state merger changed unrelated event facts")
	}
}

func TestBattleStateFieldsMergeConflictsAreAtomic(t *testing.T) {
	pairs := [][2]BattleEvent{
		{{HPMax: domainInt(500)}, {HPMax: domainInt(501)}},
		{{EnergyCost: domainInt(0)}, {EnergyCost: domainInt(1)}},
		{{StateStage: "initial"}, {StateStage: "snapshot"}},
		{{StateActive: battleStateTestBool(false)}, {StateActive: battleStateTestBool(true)}},
	}
	for i, pair := range pairs {
		for _, reverse := range []bool{false, true} {
			a, b := pair[0], pair[1]
			if reverse {
				a, b = b, a
			}
			// Earlier field fills must not leak through a later-field conflict.
			if a.HPMax == nil && b.HPMax == nil {
				b.HPMax = domainInt(500)
			}
			if a.EnergyCost == nil && b.EnergyCost == nil {
				a.EnergyCost = domainInt(0)
			}
			beforeA, beforeB := a, b
			if err := battleMergeStateFields(&a, &b); err == nil {
				t.Fatalf("accepted known conflict %d", i)
			}
			if !reflect.DeepEqual(a, beforeA) || !reflect.DeepEqual(b, beforeB) {
				t.Fatalf("failed merge %d partially committed", i)
			}
		}
	}
	value := BattleEvent{HPMax: domainInt(500), EnergyCost: domainInt(0), StateStage: "initial", StateActive: battleStateTestBool(false)}
	for _, pair := range [][2]*BattleEvent{{nil, &value}, {&value, nil}, {nil, nil}} {
		before := value
		if err := battleMergeStateFields(pair[0], pair[1]); err == nil || !reflect.DeepEqual(value, before) {
			t.Fatal("nil merge accepted or mutated nonnil event")
		}
	}
}

func TestBattleStateFieldsMergeDoesNotAliasPointers(t *testing.T) {
	for _, equalKnown := range []bool{false, true} {
		original := BattleEvent{HPMax: domainInt(500), EnergyCost: domainInt(0), StateStage: "initial", StateActive: battleStateTestBool(false)}
		a, b := BattleEvent{}, original
		if equalKnown {
			a = original
		}
		if err := battleMergeStateFields(&a, &b); err != nil {
			t.Fatal(err)
		}
		*a.HPMax, *a.EnergyCost, *a.StateActive = 600, 1, true
		if *b.HPMax != 500 || *b.EnergyCost != 0 || *b.StateActive || *original.HPMax != 500 || *original.EnergyCost != 0 || *original.StateActive {
			t.Fatal("merged state pointers alias input or the other result")
		}
	}
	a, b := BattleEvent{}, BattleEvent{}
	if err := battleMergeStateFields(&a, &b); err != nil || !reflect.DeepEqual(a, BattleEvent{}) || !reflect.DeepEqual(b, BattleEvent{}) {
		t.Fatal("absent values became zero measurements", err)
	}
}

func TestBattleStateFieldsJSONPreservesMeasuredZeroFalse(t *testing.T) {
	original := BattleEvent{Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e2", StateStage: "initial", HPMax: domainInt(500), HPAfter: domainInt(0), StateActive: battleStateTestBool(false)}
	data := domainEncode(t, original)
	for _, field := range []string{`"hpMax":500`, `"hpAfter":0`, `"stateStage":"initial"`, `"stateActive":false`} {
		if !strings.Contains(string(data), field) {
			t.Fatalf("explicit field missing: %s", field)
		}
	}
	var decoded BattleEvent
	if err := json.Unmarshal(data, &decoded); err != nil || !reflect.DeepEqual(original, decoded) {
		t.Fatal("state JSON round trip changed measurements", err)
	}
	cost := BattleEvent{Kind: "skill", Phase: "executed", EnergyCost: domainInt(0)}
	if !strings.Contains(string(domainEncode(t, cost)), `"energyCost":0`) {
		t.Fatal("explicit zero cost omitted")
	}
	missing := string(domainEncode(t, BattleEvent{}))
	for _, field := range []string{"hpMax", "energyCost", "stateStage", "stateActive"} {
		if strings.Contains(missing, field) {
			t.Fatalf("absent %s written as known state", field)
		}
	}
	for _, bad := range []string{`{"hpMax":1.5}`, `{"hpMax":"500"}`, `{"energyCost":0.1}`, `{"energyCost":"0"}`, `{"stateActive":0}`, `{"stateActive":"false"}`, `{"stateStage":1}`} {
		if err := json.Unmarshal([]byte(bad), &decoded); err == nil {
			t.Fatalf("coerced invalid state JSON: %s", bad)
		}
	}
}

func TestBattleStateFieldsModelRoundTrip(t *testing.T) {
	r := domainFixture("state-fields-roundtrip")
	r.Events[0].EnergyCost = domainInt(0) // Direct measurement, not a base-cost rule.
	r.Events[1].EnergyCost = domainInt(2147483647)
	r.Events = append(r.Events,
		BattleEvent{ID: "initial-bench", Round: 0, Seq: 0, Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e2", StateStage: "initial", StateActive: battleStateTestBool(false), HPMax: domainInt(500), HPAfter: domainInt(50), EnergyAfter: domainInt(0)},
		BattleEvent{ID: "state-snapshot", Round: 2, Seq: 3, Kind: "resource", Phase: "executed", Side: "me", Actor: "m1", StateStage: "snapshot", StateActive: battleStateTestBool(true), HPMax: domainInt(500), HPAfter: domainInt(300)},
		BattleEvent{ID: "state-entry", Round: 2, Seq: 4, Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e1", StateStage: "entry", HPMax: domainInt(500), HPAfter: domainInt(250)},
		BattleEvent{ID: "observed-interrupted-cost", Round: 3, Seq: 5, Kind: "skill", Phase: "interrupted", Side: "me", Actor: "m1", SkillID: 492, EnergyCost: domainInt(8)},
		BattleEvent{ID: "observed-system-cost", Round: 3, Seq: 6, Kind: "effect", Phase: "executed", Side: "enemy", Actor: "e1", SkillClass: "system", EnergyCost: domainInt(0)},
	)
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	decoded, _, err := DecodeBattleImport(domainEncode(t, r))
	if err != nil || len(decoded) != 1 {
		t.Fatal("model round trip failed", err)
	}
	if !reflect.DeepEqual(r.Events, decoded[0].Events) || !reflect.DeepEqual(r.Quality, decoded[0].Quality) {
		t.Fatal("model round trip lost state facts or changed completeness")
	}
	if decoded[0].Sides["enemy"].Lead != "e1" || decoded[0].Sides["me"].Lead != "m1" {
		t.Fatal("state metadata changed lead")
	}
}

func TestBattleStateFieldsModelRejectsInvalidMetadata(t *testing.T) {
	for _, change := range []func(*BattleEvent){
		func(e *BattleEvent) { e.HPMax = domainInt(500) },
		func(e *BattleEvent) { e.EnergyCost = domainInt(-1) },
		func(e *BattleEvent) { e.EnergyCost = domainInt(0); e.Phase = "selection" },
		func(e *BattleEvent) { e.StateStage = "initial" },
		func(e *BattleEvent) { e.StateActive = battleStateTestBool(false) },
	} {
		r := domainFixture("invalid-state-fields")
		change(&r.Events[0])
		if err := ValidateBattleRecord(&r); err == nil {
			t.Fatal("model did not enforce state-field validation")
		}
	}
}

func TestBattleStateFieldsModelMergeEnrichmentAndConflict(t *testing.T) {
	base := BattleEvent{ID: "observed-cost", Kind: "skill", Phase: "executed", Side: "me", Actor: "m1", SkillID: 351}
	known := base
	known.EnergyCost = domainInt(0)
	for _, pair := range [][2]BattleEvent{{base, known}, {known, base}} {
		merged, err := battleMergeEvent(pair[0], pair[1])
		if err != nil || !reflect.DeepEqual(merged, known) {
			t.Fatal("model merge failed to enrich direct zero cost", err)
		}
	}
	conflict := known
	conflict.EnergyCost = domainInt(1)
	if _, err := battleMergeEvent(known, conflict); err == nil {
		t.Fatal("model merged contradictory measured skill costs")
	}
	base = BattleEvent{ID: "state-initial", Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e2"}
	known = base
	known.HPMax, known.StateStage, known.StateActive = domainInt(500), "initial", battleStateTestBool(false)
	for _, pair := range [][2]BattleEvent{{base, known}, {known, base}} {
		merged, err := battleMergeEvent(pair[0], pair[1])
		if err != nil || !reflect.DeepEqual(merged, known) {
			t.Fatal("model merge failed to enrich observed bench state", err)
		}
	}
	conflict = known
	conflict.StateActive = battleStateTestBool(true)
	if _, err := battleMergeEvent(known, conflict); err == nil {
		t.Fatal("model merged contradictory measured active state")
	}
}

func TestBattleStateFieldsModelRequiresRosterActor(t *testing.T) {
	for _, actor := range []string{"outside-roster", "m1", ""} {
		r := domainFixture("state-roster-validation")
		r.Events = append(r.Events, BattleEvent{ID: "state", Kind: "resource", Phase: "executed", Side: "enemy", Actor: actor, StateStage: "initial", StateActive: battleStateTestBool(false)})
		if err := ValidateBattleRecord(&r); err == nil {
			t.Fatalf("state actor %q outside declared enemy roster was accepted", actor)
		}
	}
}

func TestBattleStateFieldsDoNotInferLeadAppearanceOrCompleteness(t *testing.T) {
	r := domainFixture("state-is-not-combat-evidence")
	r.Quality.Actions = false
	for _, side := range []string{"me", "enemy"} {
		s := r.Sides[side]
		s.Lead = ""
		r.Sides[side] = s
		r.Quality.Lead[side] = false
	}
	r.Events = []BattleEvent{
		{ID: "initial-active", Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e2", StateStage: "initial", StateActive: battleStateTestBool(true), HPMax: domainInt(500)},
		{ID: "entry-observed", Round: 1, Seq: 1, Kind: "resource", Phase: "executed", Side: "me", Actor: "m1", StateStage: "entry", StateActive: battleStateTestBool(true)},
	}
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	if r.Quality.Actions || r.Quality.Lead["me"] || r.Quality.Lead["enemy"] || r.Sides["me"].Lead != "" || r.Sides["enemy"].Lead != "" {
		t.Fatal("state measurements promoted action completeness or lead")
	}
	match := battleStatMatch(r)
	if match.appeared["enemy"][3] {
		t.Fatal("changed the legacy enemy appearance cohort")
	}
	if !match.appeared["me"][1] {
		t.Fatal("explicit active entry must remain usable by observed own-skill statistics")
	}
}
