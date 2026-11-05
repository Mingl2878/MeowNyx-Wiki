package main

import (
	"context"
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestBattleActionFieldsValidAndBounds(t *testing.T) {
	cases := []BattleEvent{
		{Kind: "skill", Phase: "executed", SkillClass: "ordinary", ExecIndex: domainInt(0)},
		{Kind: "skill", Phase: "interrupted", SkillClass: "response", SkillID: 187},
		{Kind: "skill", Phase: "executed", SkillClass: "response", Label: "有效预防"},
		{Kind: "effect", Phase: "executed", SkillClass: "passive", Label: "壮胆"},
		{Kind: "resource", Phase: "executed", SkillClass: "system", HPChange: domainInt(-2147483648), HPAfter: domainInt(0), EnergyChange: domainInt(2147483647), EnergyAfter: domainInt(2147483647)},
		{Kind: "damage", HPChange: domainInt(0), HPAfter: domainInt(2147483647)},
		{Kind: "heal", HPChange: domainInt(2147483647), HPAfter: domainInt(0)},
		{Kind: "note", Phase: "unknown", Lifecycle: "enter"},
		{Kind: "note", Phase: "unknown", Lifecycle: "round_start"},
		{Kind: "note", Phase: "unknown", Lifecycle: "finish", ExecIndex: domainInt(1000000000)},
		{Kind: "form", Phase: "executed", Form: &BattleFormChange{ExecIndex: 0}, ExecIndex: domainInt(0)},
		{Kind: "form", Phase: "executed", Form: &BattleFormChange{ExecIndex: 1000000000}},
		{Kind: "note", Label: strings.Repeat("a", 256)},
	}
	for _, input := range cases {
		if err := battleValidateActionFields(&input); err != nil {
			t.Errorf("valid event %+v: %v", input, err)
		}
	}
	e := BattleEvent{Kind: "effect", Label: "safe\x00\x01label\n\ttext"}
	if err := battleValidateActionFields(&e); err != nil || e.Label != "safelabel\n\ttext" {
		t.Fatalf("label sanitizer: %q %v", e.Label, err)
	}
}

func TestBattleActionFieldsRejectInvalidMetadata(t *testing.T) {
	cases := map[string]BattleEvent{
		"negative execution":       {ExecIndex: domainInt(-1)},
		"large execution":          {ExecIndex: domainInt(1000000001)},
		"underflow delta":          {Kind: "resource", HPChange: domainInt(-2147483649)},
		"overflow delta":           {Kind: "resource", EnergyChange: domainInt(2147483648)},
		"negative HP after":        {Kind: "damage", HPAfter: domainInt(-1)},
		"negative energy after":    {Kind: "resource", EnergyAfter: domainInt(-1)},
		"overflow HP after":        {Kind: "heal", HPAfter: domainInt(2147483648)},
		"overflow energy after":    {Kind: "resource", EnergyAfter: domainInt(2147483648)},
		"unknown lifecycle":        {Kind: "note", Phase: "unknown", Lifecycle: "start"},
		"lifecycle on skill":       {Kind: "skill", Phase: "unknown", Lifecycle: "enter"},
		"executed lifecycle":       {Kind: "note", Phase: "executed", Lifecycle: "enter"},
		"lifecycle actor":          {Kind: "note", Phase: "unknown", Lifecycle: "enter", Actor: "m1"},
		"lifecycle target":         {Kind: "note", Phase: "unknown", Lifecycle: "enter", Target: "e1"},
		"lifecycle skill":          {Kind: "note", Phase: "unknown", Lifecycle: "enter", SkillID: 1},
		"lifecycle protocol skill": {Kind: "note", Phase: "unknown", Lifecycle: "enter", ProtocolSkillID: "1"},
		"lifecycle class":          {Kind: "note", Phase: "unknown", Lifecycle: "enter", SkillClass: "passive"},
		"lifecycle zero amount":    {Kind: "note", Phase: "unknown", Lifecycle: "enter", Amount: domainFloat(0)},
		"lifecycle zero stacks":    {Kind: "note", Phase: "unknown", Lifecycle: "enter", Stacks: domainInt(0)},
		"lifecycle HP":             {Kind: "note", Phase: "unknown", Lifecycle: "enter", HPChange: domainInt(0)},
		"lifecycle energy":         {Kind: "note", Phase: "unknown", Lifecycle: "enter", EnergyAfter: domainInt(0)},
		"interrupted effect":       {Kind: "effect", Phase: "interrupted"},
		"interrupted damage":       {Kind: "skill", Phase: "interrupted", Amount: domainFloat(0)},
		"interrupted stacks":       {Kind: "skill", Phase: "interrupted", Stacks: domainInt(0)},
		"interrupted HP":           {Kind: "skill", Phase: "interrupted", HPAfter: domainInt(0)},
		"interrupted energy":       {Kind: "skill", Phase: "interrupted", EnergyChange: domainInt(0)},
		"unknown skill class":      {Kind: "skill", SkillClass: "trait"},
		"passive cast":             {Kind: "skill", SkillClass: "passive"},
		"system cast":              {Kind: "skill", SkillClass: "system"},
		"passive canonical skill":  {Kind: "effect", SkillClass: "passive", SkillID: 1},
		"system canonical skill":   {Kind: "resource", SkillClass: "system", SkillID: 1},
		"ordinary effect":          {Kind: "effect", SkillClass: "ordinary"},
		"response damage":          {Kind: "damage", SkillClass: "response"},
		"HP on skill":              {Kind: "skill", HPChange: domainInt(0)},
		"energy on heal":           {Kind: "heal", EnergyChange: domainInt(0)},
		"damage positive HP":       {Kind: "damage", HPChange: domainInt(1)},
		"heal negative HP":         {Kind: "heal", HPChange: domainInt(-1)},
		"long label":               {Label: strings.Repeat("x", 257)},
		"form HP":                  {Kind: "form", Form: &BattleFormChange{}, HPAfter: domainInt(0)},
		"form energy":              {Kind: "form", Form: &BattleFormChange{}, EnergyAfter: domainInt(0)},
		"form lifecycle":           {Kind: "form", Form: &BattleFormChange{}, Lifecycle: "enter"},
		"form index mismatch":      {Kind: "form", Form: &BattleFormChange{ExecIndex: 1}, ExecIndex: domainInt(0)},
		"form index bounds":        {Kind: "form", Form: &BattleFormChange{ExecIndex: -1}},
	}
	for name, e := range cases {
		t.Run(name, func(t *testing.T) {
			if err := battleValidateActionFields(&e); err == nil {
				t.Fatal("accepted invalid action metadata")
			}
		})
	}
	if err := battleValidateActionFields(nil); err == nil {
		t.Fatal("accepted nil event")
	}
}

func TestBattleActionFieldsMergeSymmetricAndExplicitZero(t *testing.T) {
	fields := []struct {
		name string
		set  func(*BattleEvent)
	}{
		{"execIndex", func(e *BattleEvent) { e.ExecIndex = domainInt(0) }},
		{"lifecycle", func(e *BattleEvent) { e.Lifecycle = "round_start" }},
		{"skillClass", func(e *BattleEvent) { e.SkillClass = "response" }},
		{"label", func(e *BattleEvent) { e.Label = "地刺" }},
		{"hpChange", func(e *BattleEvent) { e.HPChange = domainInt(0) }},
		{"hpAfter", func(e *BattleEvent) { e.HPAfter = domainInt(0) }},
		{"energyChange", func(e *BattleEvent) { e.EnergyChange = domainInt(0) }},
		{"energyAfter", func(e *BattleEvent) { e.EnergyAfter = domainInt(0) }},
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
				if err := battleMergeActionFields(&a, &b); err != nil || !reflect.DeepEqual(a, want) || !reflect.DeepEqual(b, want) {
					t.Fatalf("symmetric fill: %+v %+v %v", a, b, err)
				}
			}
		})
	}
	a := BattleEvent{SkillClass: "unknown", Phase: "selection", SkillID: 1, Amount: domainFloat(0)}
	b := BattleEvent{SkillClass: "response", Phase: "executed", SkillID: 2, Amount: domainFloat(5)}
	if err := battleMergeActionFields(&a, &b); err != nil || a.SkillClass != "response" || b.SkillClass != "response" {
		t.Fatal("unknown classification did not refine", err)
	}
	if a.Phase != "selection" || b.Phase != "executed" || a.SkillID != 1 || b.SkillID != 2 || *a.Amount != 0 || *b.Amount != 5 {
		t.Fatal("metadata helper changed core facts")
	}
}

func TestBattleActionFieldsMergeConflictsAreAtomic(t *testing.T) {
	pairs := [][2]BattleEvent{
		{{ExecIndex: domainInt(0)}, {ExecIndex: domainInt(1)}},
		{{Lifecycle: "enter"}, {Lifecycle: "finish"}},
		{{SkillClass: "ordinary"}, {SkillClass: "response"}},
		{{Label: "甲"}, {Label: "乙"}},
		{{HPChange: domainInt(0)}, {HPChange: domainInt(-1)}},
		{{HPAfter: domainInt(0)}, {HPAfter: domainInt(1)}},
		{{EnergyChange: domainInt(0)}, {EnergyChange: domainInt(1)}},
		{{EnergyAfter: domainInt(0)}, {EnergyAfter: domainInt(1)}},
	}
	for _, pair := range pairs {
		for _, reverse := range []bool{false, true} {
			a, b := pair[0], pair[1]
			if reverse {
				a, b = b, a
			}
			// A later string conflict must not commit an earlier pointer enrichment.
			if a.ExecIndex == nil && b.ExecIndex == nil {
				b.ExecIndex = domainInt(0)
			}
			beforeA, beforeB := a, b
			if err := battleMergeActionFields(&a, &b); err == nil {
				t.Fatal("accepted conflicting known fields")
			}
			if !reflect.DeepEqual(a, beforeA) || !reflect.DeepEqual(b, beforeB) {
				t.Fatal("failed merge mutated input")
			}
		}
	}
	a, b := BattleEvent{}, BattleEvent{HPChange: domainInt(0)}
	if err := battleMergeActionFields(&a, &b); err != nil {
		t.Fatal(err)
	}
	*a.HPChange = 5
	if *b.HPChange != 0 {
		t.Fatal("merged metadata pointers alias")
	}
	if err := battleMergeActionFields(nil, &b); err == nil {
		t.Fatal("accepted nil merge")
	}
}

func TestBattleNamedSigned32ExactNumbers(t *testing.T) {
	valid := []struct {
		value any
		want  int
	}{
		{json.Number("18446744073709551501"), -115},
		{json.Number("18446744071562067968"), -2147483648},
		{json.Number("18446744073709551615"), -1},
		{json.Number("2147483647"), 2147483647},
		{json.Number("-2147483648"), -2147483648},
		{json.Number("0"), 0}, {"18446744073709551501", -115}, {"-115", -115},
		{int(-115), -115}, {int8(-115), -115}, {int16(-115), -115}, {int32(-115), -115}, {int64(-115), -115},
		{uint(115), 115}, {uint8(115), 115}, {uint16(115), 115}, {uint32(115), 115}, {uint64(18446744073709551501), -115},
		{float32(-115), -115}, {float64(-115), -115}, {float64(0), 0},
	}
	for _, tc := range valid {
		got, err := battleNamedSigned32(tc.value)
		if err != nil || got != tc.want {
			t.Errorf("%T(%v): got %d, %v; want %d", tc.value, tc.value, got, err, tc.want)
		}
	}
	var object map[string]any
	decoder := json.NewDecoder(strings.NewReader(`{"hp_change":18446744073709551501}`))
	decoder.UseNumber()
	if err := decoder.Decode(&object); err != nil {
		t.Fatal(err)
	}
	if n, err := battleNamedSigned32(object["hp_change"]); err != nil || n != -115 {
		t.Fatal(n, err)
	}
}

func TestBattleNamedSigned32RejectsAmbiguousAndLossyValues(t *testing.T) {
	invalid := []any{
		nil, true, []any{1}, map[string]any{"value": 1},
		json.Number("4294967181"), uint32(4294967181), uint64(4294967181), "4294967181",
		json.Number("2147483648"), json.Number("-2147483649"), int64(2147483648), int64(-2147483649),
		json.Number("18446744071562067967"), json.Number("18446744073709551616"),
		json.Number("9223372036854775808"), uint64(1) << 63,
		json.Number("1.0"), json.Number("1e0"), "1.5", " 1", "1 ", "+1", "01", "-01", "", "-", "-0", json.Number("-0"),
		math.Copysign(0, -1), float64(9007199254740992), float64(18446744073709551501),
		float64(1.5), math.Inf(1), math.Inf(-1), math.NaN(),
	}
	for _, value := range invalid {
		if _, err := battleNamedSigned32(value); err == nil {
			t.Errorf("accepted ambiguous %T(%v)", value, value)
		}
	}
}

func TestBattleActionFieldsModelRoundTripAndUsage(t *testing.T) {
	r := domainFixture("action-metadata-roundtrip")
	r.Events[0].SkillClass = "ordinary"
	r.Events[1].SkillClass = "ordinary"
	r.Events = append(r.Events,
		BattleEvent{ID: "response", Round: 2, Seq: 3, Kind: "skill", Phase: "executed", Side: "me", Actor: "m1", SkillID: 21, SkillClass: "response", ExecIndex: domainInt(0)},
		BattleEvent{ID: "interrupted", Round: 3, Seq: 4, Kind: "skill", Phase: "interrupted", Side: "me", Actor: "m1", SkillID: 22, SkillClass: "ordinary", Label: "过山车"},
		BattleEvent{ID: "passive", Round: 3, Seq: 5, Kind: "effect", Phase: "executed", Side: "enemy", Actor: "e2", SkillClass: "passive", Label: "壮胆"},
		BattleEvent{ID: "system", Round: 3, Seq: 6, Kind: "resource", Phase: "executed", Side: "enemy", Actor: "e2", SkillClass: "system", Label: "聚能", EnergyChange: domainInt(0), EnergyAfter: domainInt(5)},
		BattleEvent{ID: "damage", Round: 3, Seq: 7, Kind: "damage", Phase: "executed", Side: "me", Actor: "m1", Target: "e1", TargetSide: "enemy", SkillID: 21, Amount: domainFloat(642), HPChange: domainInt(-340), HPAfter: domainInt(0)},
		BattleEvent{ID: "heal", Round: 3, Seq: 8, Kind: "heal", Phase: "executed", Side: "me", Actor: "m1", Amount: domainFloat(195), HPChange: domainInt(195), HPAfter: domainInt(295)},
		BattleEvent{ID: "lifecycle", Round: 3, Seq: 9, Kind: "note", Phase: "unknown", Side: "unknown", Lifecycle: "finish"},
	)
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	decoded, _, err := DecodeBattleImport(domainEncode(t, r))
	if err != nil || len(decoded) != 1 {
		t.Fatal(decoded, err)
	}
	if !reflect.DeepEqual(r.Events, decoded[0].Events) {
		t.Fatal("canonical round trip lost timeline metadata")
	}
	s := backendService(t)
	backendImport(t, s, r)
	saved, err := s.Record(context.Background(), r.ID)
	if err != nil || !reflect.DeepEqual(r.Events, saved.Events) {
		t.Fatal("isolated database round trip lost metadata", err)
	}
	match := battleStatMatch(saved)
	if !reflect.DeepEqual(match.casts["me"][1], map[int]int{20: 1, 21: 1}) {
		t.Fatalf("non-skill or interrupted event counted: %+v", match.casts)
	}
	if match.appeared["enemy"][3] {
		t.Fatal("passive/resource actor became appeared")
	}
	stats := BuildBattleStats([]BattleRecord{saved}, nil)
	if len(stats.SelfSkills) != 2 {
		t.Fatalf("unexpected skill usages: %+v", stats.SelfSkills)
	}
	for _, skill := range stats.SelfSkills {
		if skill.Casts != 1 || skill.TotalCasts != 2 {
			t.Fatalf("inflated usage denominator: %+v", skill)
		}
	}
}

func TestBattleActionFieldsModelRejectsInvalidMetadata(t *testing.T) {
	for _, mutate := range []func(*BattleEvent){
		func(e *BattleEvent) { e.SkillClass = "passive" },
		func(e *BattleEvent) { e.HPChange = domainInt(0) },
		func(e *BattleEvent) { e.ExecIndex = domainInt(-1) },
		func(e *BattleEvent) { e.Label = strings.Repeat("x", 257) },
		func(e *BattleEvent) { e.Phase = "interrupted"; e.Amount = domainFloat(0) },
		func(e *BattleEvent) { e.Kind = "note"; e.Phase = "unknown"; e.Lifecycle = "enter" },
	} {
		r := domainFixture("invalid-action-metadata")
		mutate(&r.Events[0])
		if err := ValidateBattleRecord(&r); err == nil {
			t.Fatal("model validation bypassed action metadata rules")
		}
		if _, _, err := DecodeBattleImport(domainEncode(t, r)); err == nil {
			t.Fatal("canonical import bypassed action metadata rules")
		}
	}
}

func TestBattleActionFieldsLifecycleEnrichmentPreservesLegacyNote(t *testing.T) {
	old := domainFixture("lifecycle-enrichment")
	old.Events = []BattleEvent{{ID: "legacy-node", Round: 0, Seq: 0, Kind: "note", Phase: "unknown", Side: "unknown", Text: "Existing capture node"}}
	fresh := domainClone(t, old)
	fresh.Events[0].Lifecycle = "enter"
	for _, reverse := range []bool{false, true} {
		a, b := old, fresh
		if reverse {
			a, b = b, a
		}
		merged, err := MergeBattleRecord(a, b)
		if err != nil || !reflect.DeepEqual(merged.Events, fresh.Events) {
			t.Fatalf("legacy lifecycle enrichment changed event identity/text: %+v %v", merged.Events, err)
		}
		if merged.Quality.Actions {
			t.Fatal("lifecycle-only data claims complete gameplay actions")
		}
	}
}

func TestBattleActionFieldsModelMergeEnrichmentAndCoreConflicts(t *testing.T) {
	old := domainFixture("action-merge")
	old.Events = []BattleEvent{{ID: "damage", Round: 1, Seq: 1, Kind: "damage", Phase: "executed", Side: "me", Actor: "m1", Amount: domainFloat(115)}}
	fresh := domainClone(t, old)
	fresh.Events[0].ExecIndex = domainInt(0)
	fresh.Events[0].HPChange = domainInt(-115)
	fresh.Events[0].HPAfter = domainInt(0)
	for _, reverse := range []bool{false, true} {
		a, b := old, fresh
		if reverse {
			a, b = b, a
		}
		merged, err := MergeBattleRecord(a, b)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(merged.Events, fresh.Events) {
			t.Fatalf("event enrichment lost metadata: %+v", merged.Events)
		}
	}
	for _, mutate := range []func(*BattleEvent){
		func(e *BattleEvent) { e.HPAfter = domainInt(1) },
		func(e *BattleEvent) { e.Amount = domainFloat(114) },
		func(e *BattleEvent) { e.Phase = "preview" },
	} {
		changed := domainClone(t, fresh)
		mutate(&changed.Events[0])
		if _, err := MergeBattleRecord(fresh, changed); err == nil {
			t.Fatal("accepted conflicting existing event facts")
		}
	}
}
