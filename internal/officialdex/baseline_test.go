package officialdex

import (
	"testing"
	"xhmwiki/internal/sourcebaseline"
)

func observationEntries(p *Proposal) map[string]sourcebaseline.Entry {
	out := map[string]sourcebaseline.Entry{}
	for _, o := range p.SourceObservations {
		out[sourcebaseline.Key(o.Entity, o.Identity, o.Field)] = o.Entry
	}
	return out
}
func TestSourceObservationsCoverEveryCurrentChoiceGroup(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{"小猫": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "source": "默认"}}}})
	p := proposal(t, local, fixtureSource(t, object{"101": fixtureDetail(1, "小猫", "")}))
	fields := map[string]bool{}
	for _, o := range p.SourceObservations {
		fields[o.Entity+":"+o.Field] = true
	}
	for _, field := range []string{"identity", "evolution", "leader_form", "learning", "evolution_stage", "type_ids", "data_note", "trait", "entity", "stats.hp", "stats.phy_atk", "stats.mag_atk", "stats.phy_def", "stats.mag_def", "stats.speed"} {
		if !fields["monster:"+field] {
			t.Fatal("missing monster group", field)
		}
	}
	for _, field := range []string{"identity", "entity", "description", "type_id", "category", "energy_cost", "power", "season"} {
		if !fields["skill:"+field] {
			t.Fatal("missing skill group", field)
		}
	}
	if !fields["catalog:image_policy"] {
		t.Fatal("missing image policy")
	}
}
func TestSourceObservationsAreIndependentOfLocalSuppressionAndTypeAvailability(t *testing.T) {
	monster := fixtureMonster(1, 1, "小猫", "default")
	move := fixtureMove(3, "冲撞", 60)
	local := fixtureLocal(t, []any{monster}, []any{move}, object{"小猫": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "source": "默认"}}}})
	src := fixtureSource(t, object{"101": fixtureDetail(1, "小猫", "")})
	a := observationEntries(proposal(t, local, src))
	monster["base_hp"] = 999
	move["power_formula"] = "local-protected"
	move["power"] = nil
	changed := fixtureLocal(t, []any{monster}, []any{move}, object{"小猫": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "source": "默认"}}}})
	typ := fixtureType()
	typ["localized"] = object{"zh": "本地未知属性"}
	changed.Types = jsonBytes(t, []any{typ})
	b := observationEntries(proposal(t, changed, src))
	if len(a) != len(b) {
		t.Fatal("local validity changed source entry count")
	}
	for key, value := range a {
		if !sourcebaseline.Equal(value.Value, b[key].Value) {
			t.Fatalf("local context changed normalized source %s", key)
		}
	}
}
func TestSourceNormalizationIgnoresFormattingLearningOrderAndDuplicateRows(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{"小猫": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "source": "默认"}}}})
	detail := fixtureDetail(1, "小猫", "")
	a := observationEntries(proposal(t, local, fixtureSource(t, object{"101": detail})))
	detail["te"] = "官方\n特性说明"
	skill := asObject(asObject(detail["sk"])["s"].([]any)[0])
	skill["ef"] = "新\n描述"
	skill["pw"] = "075"
	skill["ec"] = "02"
	asObject(detail["sk"])["s"] = []any{skill, clone(skill)}
	b := observationEntries(proposal(t, local, fixtureSource(t, object{"101": detail})))
	for key, value := range a {
		if !sourcebaseline.Equal(value.Value, b[key].Value) {
			t.Fatalf("format-only change changed normalized source %s", key)
		}
	}
}
func TestBaselineDiagnosticsNeverSuppressStructuralOrIdentityProblems(t *testing.T) {
	for _, i := range []Issue{{Severity: "blocking", Code: "anything"}, {Severity: "warning", Code: "invalid_field"}, {Severity: "review", Code: "reviewed_identity_crosscheck_failed"}, {Severity: "review", Code: "unknown_type"}, {Severity: "warning", Code: "source_relationship_cycle"}} {
		if BaselineIssueSuppressible(i) {
			t.Fatal("unsafe diagnostic can be acknowledged", i)
		}
	}
}
