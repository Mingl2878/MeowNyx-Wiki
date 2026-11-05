package officialdex

import (
	"strings"
	"testing"
)

func TestRejectSourceMarkupWithoutCleaningDefinitions(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	for _, bad := range []string{"<img src=x onerror=alert(1)>", "\" onmouseover=alert(1) x=\"", "' onclick=alert(1) '", "` onload=alert(1)", "&lt;script&gt;evil&lt;/script&gt;", "&#x3c;script&#62;evil", "&#34;onclick=evil", "名字\x00注入"} {
		t.Run(bad, func(t *testing.T) {
			d := fixtureDetail(1, "小猫", "")
			d["tn"] = bad
			d["te"] = bad
			skill := fixtureSkill("冲撞", "100")
			skill["ef"] = bad
			asObject(d["sk"])["s"] = []any{skill}
			p := proposal(t, local, fixtureSource(t, object{"90": d}))
			got := findID(t, p.Files.Monsters, 1)
			if text(field(got, "trait.localized.zh.name")) != "本地特性" || text(field(got, "trait.localized.zh.description")) != "本地特性说明" {
				t.Fatal("suspicious trait was persisted or cleaned")
			}
			if !equal(findID(t, p.Files.Moves, 3), fixtureMove(3, "冲撞", 60)) {
				t.Fatal("suspicious skill updated")
			}
			if !hasIssue(p, "invalid_field") || !hasIssue(p, "invalid_move") {
				t.Fatal("suspicious text not reported")
			}
		})
	}
}
func TestSuspiciousNameRefusesIdentityAndReportDoesNotEchoMarkup(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	bad := `<img src=x onerror=evil>`
	p := proposal(t, local, fixtureSource(t, object{"1": fixtureDetail(1, "小猫", ""), "2": fixtureDetail(2, bad, "")}))
	if p.Stats.AddedMonsters != 0 {
		t.Fatal("markup name allocated local ID")
	}
	for _, issue := range p.Issues {
		if strings.Contains(issue.Name, "<") {
			t.Fatal("unsafe name echoed into review")
		}
	}
	if strings.Contains(string(p.Files.Monsters), "onerror") {
		t.Fatal("source markup persisted")
	}
}
func TestChineseQuotesAndDescriptionNewlinesRemainLiteral(t *testing.T) {
	d := fixtureDetail(1, "小猫", "")
	d["tn"] = "“国王”的威严"
	d["te"] = "第一行\n第二行【状态】+20%。"
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, local, fixtureSource(t, object{"1": d}))
	got := findID(t, p.Files.Monsters, 1)
	if field(got, "trait.localized.zh.name") != d["tn"] || field(got, "trait.localized.zh.description") != d["te"] {
		t.Fatal("legitimate punctuation was cleaned")
	}
}
func TestWhitespaceOnlySpecialDescriptionDoesNotTriggerRuleReview(t *testing.T) {
	m := fixtureMove(35, "魔能爆", 1)
	m["power_formula"] = "energy"
	ensure(m, "localized", "zh")["description"] = "造成魔伤，使用能量。"
	d := fixtureDetail(1, "小猫", "")
	s := fixtureSkill("魔能爆", "100")
	s["ef"] = "造成魔伤， 使用 能量 。"
	asObject(d["sk"])["s"] = []any{s}
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{m}, object{})
	p := proposal(t, local, fixtureSource(t, object{"1": d}))
	if hasIssue(p, "special_rule_description_changed") {
		t.Fatal("whitespace treated as rule change")
	}
}
