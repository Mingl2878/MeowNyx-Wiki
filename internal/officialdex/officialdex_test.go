package officialdex

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func jsonBytes(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func fixtureType() object {
	return object{"id": 1, "name": "Normal", "localized": object{"zh": "普通"}, "vulnerable_to": []any{"Fighting"}, "resistant_to": []any{"Ghost"}, "image": "keep/type.png"}
}
func fixtureMonster(id, dex int, name, form string) object {
	m := object{"id": id, "dex_number": dex, "localized": object{"zh": object{"name": name}}, "form": form, "main_type": fixtureType(), "sub_type": nil, "default_legacy_type": fixtureType(), "trait": object{"localized": object{"zh": object{"name": "本地特性", "description": "本地特性说明"}}}, "evolution_stage": "高级形态", "learnset_mode": "own", "image": "keep/portrait.png", "season": "local", "custom": object{"stay": true}}
	for _, p := range statFields {
		m[p[1]] = 50
	}
	return m
}
func fixtureMove(id int, name string, power any) object {
	return object{"id": id, "localized": object{"zh": object{"name": name, "description": "旧描述"}}, "power": power, "move_category": "Physical Attack", "energy_cost": 1, "move_type": fixtureType(), "season": "S0"}
}
func fixtureSkill(name, power string) object {
	return object{"nm": name, "tp": "物攻", "el": "普通", "ec": "2", "pw": power, "ef": "新描述", "lv": "99"}
}
func fixtureDetail(dex int, name, form string) object {
	full := name
	if form != "" {
		full += "（" + form + "）"
	}
	return object{"n": fmt.Sprintf("NO.%03d", dex), "nm": name, "fn": full, "f": form, "e": "普通", "e2": "", "s": "最终形态", "hp": 100, "atk": 101, "matk": 102, "df": 103, "mdf": 104, "spd": 105, "rt": 615, "tn": "官方特性", "te": "官方特性说明", "img": "a/i/explicit.png?v=abcd", "evo": []any{}, "forms": []any{}, "sk": object{"s": []any{fixtureSkill("冲撞", "75")}, "b": []any{}, "t": []any{}}}
}
func fixtureSource(t *testing.T, details object) []byte {
	l := []any{}
	for _, id := range keys(details) {
		d := asObject(details[id])
		var i int
		fmt.Sscan(id, &i)
		l = append(l, object{"i": i, "n": d["n"], "nm": d["nm"], "fn": d["fn"], "f": d["f"]})
	}
	return jsonBytes(t, object{"d": details, "l": l, "e": []any{"普通"}, "_em": object{"普通": "a/e/type.png?v=ab"}, "_skm": object{"冲撞": "a/s/move.png?v=ab"}})
}
func fixtureLocal(t *testing.T, monsters []any, moves []any, wiki object) LegacyFiles {
	return LegacyFiles{jsonBytes(t, monsters), jsonBytes(t, moves), jsonBytes(t, []any{fixtureType()}), jsonBytes(t, wiki)}
}
func proposal(t *testing.T, l LegacyFiles, src []byte) *Proposal {
	t.Helper()
	p, e := BuildProposal(l, src)
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func decodeArray(t *testing.T, b []byte) []any {
	t.Helper()
	v, e := decode(b)
	if e != nil {
		t.Fatal(e)
	}
	return v.([]any)
}
func decodeObject(t *testing.T, b []byte) object {
	t.Helper()
	v, e := decode(b)
	if e != nil {
		t.Fatal(e)
	}
	return asObject(v)
}
func findID(t *testing.T, b []byte, id int) object {
	t.Helper()
	for _, v := range decodeArray(t, b) {
		m := asObject(v)
		if idOf(m) == id {
			return m
		}
	}
	t.Fatalf("missing id %d", id)
	return nil
}
func hasIssue(p *Proposal, code string) bool {
	for _, i := range p.Issues {
		if i.Code == code {
			return true
		}
	}
	return false
}

func TestConflictingSourceID619DoesNotOverwriteLocalAndSkips9001(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(619, 0, "冥古龙", "default"), fixtureMonster(9001, 0, "木桩", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	d := fixtureDetail(464, "布灵", "")
	p := proposal(t, local, fixtureSource(t, object{"619": d}))
	if localName(findID(t, p.Files.Monsters, 619)) != "冥古龙" || localName(findID(t, p.Files.Monsters, 9001)) != "木桩" {
		t.Fatal("stable IDs were overwritten")
	}
	m := findID(t, p.Files.Monsters, 620)
	if localName(m) != "布灵" || text(asObject(m["_source_ref"])["id"]) != "619" {
		t.Fatal("new ID/source reference mismatch")
	}
	if m["image"] != "" {
		t.Fatal("invented image filename")
	}
	if !hasIssue(p, "local_only_monster") {
		t.Fatal("local-only not reported")
	}
}

func TestFullFormAndRomanAliasesMatchWithoutMergingDifferentForms(t *testing.T) {
	m1 := fixtureMonster(40, 145, "权杖-Ⅱ", "default")
	m2 := fixtureMonster(41, 12, "板板壳", "Original")
	m3 := fixtureMonster(42, 12, "板板壳", "被污染的样子")
	local := fixtureLocal(t, []any{m1, m2, m3}, []any{fixtureMove(3, "冲撞", 60)}, object{"权杖_II": object{"monster_id": 40, "skills": []any{}, "image": "old.png"}})
	p := proposal(t, local, fixtureSource(t, object{"88": fixtureDetail(145, "权杖II", ""), "89": fixtureDetail(12, "板板壳", "本来的样子"), "90": fixtureDetail(12, "板板壳", "被污染的样子")}))
	if p.Stats.MatchedMonsters != 3 || p.Stats.AddedMonsters != 0 {
		t.Fatalf("wrong identity stats %+v issues=%+v", p.Stats, p.Issues)
	}
	if text(asObject(findID(t, p.Files.Monsters, 42)["_source_ref"])["id"]) != "90" {
		t.Fatal("forms crossed")
	}
	w := decodeObject(t, p.Files.Wiki)
	e := asObject(w["权杖-Ⅱ"])
	if e == nil || len(e["aliases"].([]any)) == 0 {
		t.Fatal("alias not retained")
	}
	p2 := proposal(t, p.Files, fixtureSource(t, object{"88": fixtureDetail(145, "权杖II", ""), "89": fixtureDetail(12, "板板壳", "本来的样子"), "90": fixtureDetail(12, "板板壳", "被污染的样子")}))
	if len(p2.Changes) != 0 {
		t.Fatalf("second import changed data: %+v", p2.Changes)
	}
}

func TestMissingAndIllegalFieldsNeverBecomeZeroOrEmpty(t *testing.T) {
	m := fixtureMonster(10, 1, "小猫", "default")
	m["sub_type"] = object{"id": 88, "localized": object{"zh": "旧副属性"}}
	d := fixtureDetail(1, "小猫", "")
	delete(d, "hp")
	d["atk"] = "bad"
	delete(d, "e2")
	d["tn"] = nil
	delete(d, "sk")
	l := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{"小猫": object{"monster_id": 10, "skills": []any{object{"name": "冲撞", "source": "传说", "desc": "旧描述", "type": "物攻", "element": "普通"}}}})
	p := proposal(t, l, fixtureSource(t, object{"1": d}))
	got := findID(t, p.Files.Monsters, 10)
	for _, f := range []string{"base_hp", "base_phy_atk", "sub_type", "trait"} {
		if f == "trait" {
			if text(field(got, "trait.localized.zh.name")) != "本地特性" {
				t.Fatal("missing trait became empty")
			}
			continue
		}
		if !equal(got[f], m[f]) {
			t.Fatalf("missing %s overwritten", f)
		}
	}
	if !hasIssue(p, "incomplete_learnset") || !hasIssue(p, "invalid_field") {
		t.Fatal("missing fields not reported")
	}
}

func TestSameNameDifferentSourceMoveDefinitionsRejectAllUpdates(t *testing.T) {
	d1, d2 := fixtureDetail(1, "小猫", ""), fixtureDetail(2, "小狗", "")
	asObject(d2["sk"])["s"] = []any{fixtureSkill("冲撞", "999")}
	l := fixtureLocal(t, []any{fixtureMonster(10, 1, "小猫", "default"), fixtureMonster(11, 2, "小狗", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, l, fixtureSource(t, object{"1": d1, "2": d2}))
	got := findID(t, p.Files.Moves, 3)
	if !equal(got, fixtureMove(3, "冲撞", 60)) || !hasIssue(p, "move_definition_conflict") {
		t.Fatal("conflicting move was updated")
	}
	if len(decodeObject(t, p.Files.Wiki)) != 0 {
		t.Fatal("conflicting learning was added")
	}
}

func TestOfficialLearningRemovesAbsentRelationsButPreservesMaster(t *testing.T) {
	d := fixtureDetail(1, "小猫", "")
	asObject(d["sk"])["s"] = []any{fixtureSkill("冲撞", "80"), fixtureSkill("新招", "45")}
	asObject(d["sk"])["b"] = []any{fixtureSkill("冲撞", "80")}
	l := fixtureLocal(t, []any{fixtureMonster(10, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60), fixtureMove(9, "本地独有", 90)}, object{"小猫": object{"monster_id": 10, "image": "keep/wiki.png", "skills": []any{object{"name": "本地独有", "source": "传说", "desc": "旧说明"}, object{"name": "冲撞", "source": "默认", "desc": "过时", "type": "状态", "element": "错"}}}})
	p := proposal(t, l, fixtureSource(t, object{"1": d}))
	w := asObject(decodeObject(t, p.Files.Wiki)["小猫"])
	rows := w["skills"].([]any)
	if len(rows) != 3 || text(asObject(rows[0])["source"]) != "默认" || text(asObject(rows[1])["name"]) != "新招" || text(asObject(rows[2])["source"]) != "血脉" {
		t.Fatalf("official order/source lost: %+v", rows)
	}
	if text(asObject(rows[0])["desc"]) != "新描述" || text(asObject(rows[0])["type"]) != "物攻" || text(asObject(rows[0])["element"]) != "普通" {
		t.Fatal("wiki did not follow master")
	}
	if !hasIssue(p, "local_only_move") || hasIssue(p, "local_learning_preserved") {
		t.Fatal("master preservation and authorized relation correction confused")
	}
	if localName(findID(t, p.Files.Moves, 9)) != "本地独有" {
		t.Fatal("removing learning relation deleted master move")
	}
	if !bytes.Equal(l.Types, p.Files.Types) {
		t.Fatal("types rewritten")
	}
	if text(w["image"]) != "keep/wiki.png" {
		t.Fatal("image overwritten")
	}
	if n, _ := integer(findID(t, p.Files.Moves, 3)["power"]); n != 80 {
		t.Fatal("ordinary power not updated")
	}
}

func TestInheritNeverPollutesTargetAndSourceEmptyNeverClearsOwn(t *testing.T) {
	own := fixtureMonster(10, 1, "小猫", "default")
	inherit := fixtureMonster(11, 2, "小狗", "default")
	inherit["learnset_mode"] = "inherit"
	inherit["learnset_inherits_from_id"] = 10
	d1, d2 := fixtureDetail(1, "小猫", ""), fixtureDetail(2, "小狗", "")
	asObject(d1["sk"])["s"] = []any{}
	asObject(d2["sk"])["s"] = []any{fixtureSkill("新招", "45")}
	l := fixtureLocal(t, []any{own, inherit}, []any{fixtureMove(3, "冲撞", 60)}, object{"小猫": object{"monster_id": 10, "skills": []any{object{"name": "冲撞", "source": "默认"}}}, "小狗": object{"monster_id": 11, "skills": []any{}}})
	p := proposal(t, l, fixtureSource(t, object{"1": d1, "2": d2}))
	m := findID(t, p.Files.Monsters, 11)
	if m["learnset_mode"] != "own" || m["learnset_inherits_from_id"] != nil {
		t.Fatal("real difference did not detach only child")
	}
	w := decodeObject(t, p.Files.Wiki)
	if len(asObject(w["小猫"])["skills"].([]any)) != 1 || len(asObject(w["小狗"])["skills"].([]any)) != 1 {
		t.Fatal("parent cleared or complete child table missing")
	}
	if hasIssue(p, "inherited_learnset_difference") || !hasIssue(p, "empty_official_learnset") {
		t.Fatal("authorized learning change or empty-source protection incorrect")
	}
}

func TestSpecialPowerAndRuleProtection(t *testing.T) {
	for _, test := range []struct {
		id      int
		name    string
		power   any
		formula any
	}{{35, "魔能爆", 1, "energy"}, {19, "彗星", 240, nil}, {195, "鸣沙陷阱", 60, "phy_def_diff"}, {358, "闪击", 60, "speed_diff"}, {10, "吨位压制", 0, nil}, {70, "以重制重", 0, nil}, {376, "砂糖弹球", 0, nil}, {800, "自定义特殊", "?", nil}, {801, "规则特技", 1, "custom"}} {
		t.Run(test.name, func(t *testing.T) {
			m := fixtureMove(test.id, test.name, test.power)
			m["power_formula"] = test.formula
			m["rule"] = object{"preserve": true}
			d := fixtureDetail(1, "小猫", "")
			asObject(d["sk"])["s"] = []any{fixtureSkill(test.name, "100")}
			l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{m}, object{})
			p := proposal(t, l, fixtureSource(t, object{"8": d}))
			got := findID(t, p.Files.Moves, test.id)
			if !equal(got["power"], m["power"]) || !equal(got["power_formula"], m["power_formula"]) || !equal(got["rule"], m["rule"]) {
				t.Fatal("special power or rule overwritten")
			}
			if description(got) != "新描述" || !hasIssue(p, "special_rule_description_changed") {
				t.Fatal("changed rule description not reported")
			}
		})
	}
}

func TestExcludedFieldsAndDeterministicIdempotence(t *testing.T) {
	d := fixtureDetail(1, "小猫", "")
	for _, key := range []string{"w", "h", "desc", "loc", "nick", "egg", "gender", "si", "lv"} {
		d[key] = "DO_NOT_IMPORT"
	}
	m := fixtureMonster(1, 1, "小猫", "default")
	m["data_status"] = "placeholder"
	m["default_level"] = 99
	m["loc"] = "local extension"
	l := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	src := fixtureSource(t, object{"99": d})
	p := proposal(t, l, src)
	p2 := proposal(t, p.Files, src)
	if len(p2.Changes) != 0 || !bytes.Equal(p.Files.Monsters, p2.Files.Monsters) || !bytes.Equal(p.Files.Moves, p2.Files.Moves) || !bytes.Equal(p.Files.Wiki, p2.Files.Wiki) {
		t.Fatalf("not idempotent: %+v", p2.Changes)
	}
	if strings.Contains(string(p.Files.Monsters), "DO_NOT_IMPORT") || strings.Contains(string(p.Files.Wiki), "\"lv\"") {
		t.Fatal("excluded fields imported")
	}
	got := findID(t, p.Files.Monsters, 1)
	if got["season"] != "local" || got["data_status"] != "placeholder" || got["loc"] != "local extension" {
		t.Fatal("local extension lost")
	}
	p3 := proposal(t, l, src)
	if !equal(p.Changes, p3.Changes) || !equal(p.Issues, p3.Issues) || !equal(p.Images, p3.Images) {
		t.Fatal("nondeterministic report")
	}
}

func TestStrictJSONSchemaFailures(t *testing.T) {
	l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	for _, src := range []string{"<html>failure</html>", "{}", "[]", "{\"d\":{},\"d\":{}}", "{\"d\":{},\"l\":[],\"e\":[]}", "null", "{} {}", "{\"l\":[{}],\"d\":{\"1\":[]},\"e\":[\"普通\"]}"} {
		if p, e := BuildProposal(l, []byte(src)); e == nil || p != nil {
			t.Fatalf("accepted invalid source %q", src)
		}
	}
}
func TestImageURLTrustAndLocalImagesPreserved(t *testing.T) {
	for _, raw := range []string{"https://evil.example/a/i/x.png", "//evil.example/x.png", "a/i/../../secret.png", "a/i/%2e%2e/x.png", "a/i/%252e%252e.png", "a/i/x.png#fragment", "a/i/x.png?next=http://evil", "a/i/x.jpg", "https://static.gamecenter.qq.com@evil.example/x.png", "a/i/x.png?v=ab&v=cd"} {
		if _, e := TrustedImageURL(raw, "monster"); e == nil {
			t.Fatalf("accepted unsafe URL %s", raw)
		}
	}
	if _, e := TrustedImageURL("a/i/小猫.png?v=abcdef", "monster"); e != nil {
		t.Fatal(e)
	}
}
func TestAliasConflictAbortsAndMissingNumberDoesNotMap(t *testing.T) {
	m := fixtureMonster(1, 1, "权杖-Ⅱ", "default")
	l := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{"权杖-Ⅱ": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "desc": "甲"}}}, "权杖_II": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "desc": "乙"}}}})
	if p, e := BuildProposal(l, fixtureSource(t, object{"8": fixtureDetail(1, "权杖II", "")})); e == nil || p != nil {
		t.Fatal("alias conflict accepted")
	}
	m = fixtureMonster(1, 0, "小猫", "default")
	l = fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, l, fixtureSource(t, object{"8": fixtureDetail(1, "小猫", "")}))
	if p.Stats.MatchedMonsters != 0 || p.Stats.AddedMonsters != 0 || !hasIssue(p, "identity_crosscheck_failed") {
		t.Fatal("unknown number was inferred")
	}
}
