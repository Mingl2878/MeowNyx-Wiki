package officialdex

import (
	"bytes"
	"testing"

	canonical "xhmwiki/internal/catalog"
)

func TestTraitNotesPreserveLocalSuffixWithoutChangingOfficialText(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n", "\r"} {
		t.Run(newline, func(t *testing.T) {
			m := fixtureMonster(129, 1, "兽花蕾", "default")
			tail := "草：本地补充20%。" + newline + " 火：本地补充40%。 " + newline
			ensure(m, "trait", "localized", "zh")["description"] = " 官方 摘要 。 " + newline + tail
			d := fixtureDetail(1, "兽花蕾", "")
			d["te"] = "官方摘要。"
			local := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{})
			source := fixtureSource(t, object{"90": d})
			p := proposal(t, local, source)
			got := findID(t, p.Files.Monsters, 129)
			if got["_trait_notes"] != tail {
				t.Fatalf("local suffix changed: %#v", got["_trait_notes"])
			}
			if field(got, "trait.localized.zh.description") != d["te"] {
				t.Fatal("notes polluted authoritative Tencent trait description")
			}
			if !hasIssue(p, "local_trait_notes_preserved") {
				t.Fatal("local provenance not reported")
			}
			found := false
			for _, change := range p.Changes {
				if change.Entity == "monster" && change.ID == 129 && change.Field == "_trait_notes" && change.After == tail {
					found = true
				}
			}
			if !found {
				t.Fatal("notes preservation missing from field diff")
			}
			second := proposal(t, p.Files, source)
			if len(second.Changes) != 0 || !bytes.Equal(second.Files.Monsters, p.Files.Monsters) || hasIssue(second, "local_trait_notes_preserved") {
				t.Fatal("second import duplicated notes or changes")
			}
		})
	}
}

func TestTraitNotesKeepExistingNotesWithoutAppendingOrReplacing(t *testing.T) {
	for _, existing := range []string{"原有本地补充", "尾部补充", ""} {
		t.Run(existing, func(t *testing.T) {
			m := fixtureMonster(469, 1, "陨星虫", "default")
			m["_trait_notes"] = existing
			ensure(m, "trait", "localized", "zh")["description"] = "官方摘要。\n尾部补充"
			d := fixtureDetail(1, "陨星虫", "")
			d["te"] = "官方摘要。"
			p := proposal(t, fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{}), fixtureSource(t, object{"91": d}))
			got := findID(t, p.Files.Monsters, 469)
			if got["_trait_notes"] != existing || field(got, "trait.localized.zh.description") != "官方摘要。" {
				t.Fatal("existing notes overwritten, concatenated or inserted into official field")
			}
			for _, ch := range p.Changes {
				if ch.Field == "_trait_notes" {
					t.Fatal("existing notes should not be changed")
				}
			}
			if existing != "尾部补充" && !hasIssue(p, "local_trait_notes_conflict") {
				t.Fatal("different preexisting notes not surfaced for review")
			}
		})
	}
}

func TestTraitNotesRequireMatchingFirstLineAndNonemptySuffix(t *testing.T) {
	for _, old := range []string{"不同摘要。\n尾部补充", "官方摘要。", "官方摘要。\n \t\n"} {
		m := fixtureMonster(1, 1, "小猫", "default")
		ensure(m, "trait", "localized", "zh")["description"] = old
		d := fixtureDetail(1, "小猫", "")
		d["te"] = "官方摘要。"
		p := proposal(t, fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{}), fixtureSource(t, object{"1": d}))
		got := findID(t, p.Files.Monsters, 1)
		if _, exists := got["_trait_notes"]; exists {
			t.Fatalf("invented notes from %q", old)
		}
		if field(got, "trait.localized.zh.description") != "官方摘要。" {
			t.Fatal("official description not updated")
		}
	}
}

func TestTraitNotesSurviveCanonicalRoundTripAsMonsterExtension(t *testing.T) {
	typ := fixtureType()
	typ["vulnerable_to"] = []any{}
	typ["resistant_to"] = []any{}
	m := fixtureMonster(129, 1, "兽花蕾", "default")
	m["form_category"] = "无多形态"
	m["evolves_from_id"] = nil
	m["main_type"] = typ
	m["default_legacy_type"] = typ
	ensure(m, "trait", "localized", "zh")["description"] = "官方摘要。\n属性补充A\n属性补充B"
	move := fixtureMove(3, "冲撞", 60)
	move["move_type"] = typ
	move["base_combo"] = nil
	move["power_formula"] = nil
	local := LegacyFiles{Monsters: jsonBytes(t, []any{m}), Moves: jsonBytes(t, []any{move}), Types: jsonBytes(t, []any{typ}), Wiki: jsonBytes(t, object{"兽花蕾": object{"monster_id": 129, "image": "", "skills": []any{}}})}
	d := fixtureDetail(1, "兽花蕾", "")
	d["te"] = "官方摘要。"
	p := proposal(t, local, fixtureSource(t, object{"300": d}))
	c, err := canonical.ImportLegacy(canonical.LegacyFiles{Monsters: p.Files.Monsters, Moves: p.Files.Moves, Types: p.Files.Types, Wiki: p.Files.Wiki})
	if err != nil {
		t.Fatal(err)
	}
	round, err := canonical.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	got := findID(t, round.Monsters, 129)
	if got["_trait_notes"] != "属性补充A\n属性补充B" || field(got, "trait.localized.zh.description") != "官方摘要。" {
		t.Fatal("canonical projection lost or merged notes into source trait")
	}
	for _, trait := range c.Traits {
		if trait.Description != "官方摘要。" {
			t.Fatal("local notes became shared canonical trait text")
		}
	}
}
