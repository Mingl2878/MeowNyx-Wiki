package officialdex

import (
	"fmt"
	"strings"
	"testing"

	canonical "xhmwiki/internal/catalog"
)

func canonicalFixture(t *testing.T, monsters, moves []any, wiki object) LegacyFiles {
	t.Helper()
	typ := fixtureType()
	typ["vulnerable_to"], typ["resistant_to"] = []any{}, []any{}
	for _, v := range monsters {
		m := asObject(v)
		m["main_type"], m["default_legacy_type"] = clone(typ), clone(typ)
		if _, exists := m["evolves_from_id"]; !exists {
			m["evolves_from_id"] = nil
		}
		if m["form_category"] == nil {
			m["form_category"] = "无多形态"
		}
	}
	for _, v := range moves {
		m := asObject(v)
		m["move_type"] = clone(typ)
		for _, key := range []string{"base_combo", "power_formula"} {
			if _, exists := m[key]; !exists {
				m[key] = nil
			}
		}
	}
	return LegacyFiles{jsonBytes(t, monsters), jsonBytes(t, moves), jsonBytes(t, []any{typ}), jsonBytes(t, wiki)}
}

func importProposal(t *testing.T, p *Proposal) *canonical.Catalog {
	t.Helper()
	c, err := canonical.ImportLegacy(canonical.LegacyFiles{Monsters: p.Files.Monsters, Moves: p.Files.Moves, Types: p.Files.Types, Wiki: p.Files.Wiki})
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func exportCanonical(t *testing.T, c *canonical.Catalog) LegacyFiles {
	t.Helper()
	f, err := canonical.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	return LegacyFiles{f.Monsters, f.Moves, f.Types, f.Wiki}
}
func canonicalMonster(t *testing.T, c *canonical.Catalog, id int) canonical.Monster {
	t.Helper()
	for _, m := range c.Monsters {
		if m.ID == id {
			return m
		}
	}
	t.Fatalf("missing canonical monster %d", id)
	return canonical.Monster{}
}
func hasAlias(aliases []string, wanted string) bool {
	for _, alias := range aliases {
		if alias == wanted {
			return true
		}
	}
	return false
}

func TestReviewedTwelveMigrationsPreserveCanonicalAliasesAndParents(t *testing.T) {
	monsters, wiki, details := []any{}, object{}, object{}
	parents := map[int]int{}
	for i, r := range reviewedIdentities {
		m := fixtureMonster(r.localID, r.dex, r.oldName, r.oldForm)
		m["form_category"] = r.category
		m["aliases"] = []any{fmt.Sprintf("怪兽旧别名%d", i)}
		monsters = append(monsters, m)
		wiki[displayName(m)] = object{"monster_id": r.localID, "aliases": []any{fmt.Sprintf("Wiki旧别名%d", i)}, "skills": []any{object{"name": "冲撞", "source": "传说"}}}
		if r.category == "主形态" {
			child := fixtureMonster(2000+i, r.dex, r.oldName, "合成变体")
			child["form_category"], child["main_form_name"] = "变体形态", r.oldForm
			child["learnset_mode"], child["learnset_inherits_from_id"] = "inherit", r.localID
			monsters = append(monsters, child)
			wiki[displayName(child)] = object{"monster_id": idOf(child), "skills": []any{}}
			parents[idOf(child)] = r.localID
		}
		details[r.sourceID] = fixtureDetail(r.dex, r.name, r.form)
	}
	local := canonicalFixture(t, monsters, []any{fixtureMove(3, "冲撞", 60)}, wiki)
	source := fixtureSource(t, details)
	p := proposal(t, local, source)
	if p.HasBlockingIssues() || p.Stats.MatchedMonsters != 12 || p.Stats.AddedMonsters != 0 {
		t.Fatalf("reviewed identity failed: %+v / %+v", p.Stats, p.Issues)
	}
	c := importProposal(t, p)
	for i, r := range reviewedIdentities {
		m := canonicalMonster(t, c, r.localID)
		old := fixtureMonster(r.localID, r.dex, r.oldName, r.oldForm)
		if m.Name != r.name || m.Form != r.newForm() || !hasAlias(m.Aliases, r.oldName) || !hasAlias(m.Aliases, fmt.Sprintf("怪兽旧别名%d", i)) || !hasAlias(m.Aliases, fmt.Sprintf("Wiki旧别名%d", i)) {
			t.Fatalf("name/form/bare aliases lost for %+v: %+v", r, m)
		}
		if displayName(old) != displayName(findID(t, p.Files.Monsters, r.localID)) && !hasAlias(m.Aliases, displayName(old)) {
			t.Fatalf("old full name lost: %+v", m)
		}
	}
	for child, parent := range parents {
		if got := canonicalMonster(t, c, child).MainFormID; got != parent {
			t.Fatalf("parent ID changed: child %d => %d, want %d", child, got, parent)
		}
	}
	for _, input := range []LegacyFiles{p.Files, exportCanonical(t, c)} {
		second := proposal(t, input, source)
		if len(second.Changes) != 0 || second.Stats.AddedMonsters != 0 || second.HasBlockingIssues() {
			t.Fatalf("reviewed migration not idempotent: %+v / %+v", second.Changes, second.Issues)
		}
	}
}

func TestReviewedIdentityCrossChecksEverySourceAndLocalCoordinate(t *testing.T) {
	r := reviewedIdentities[0]
	for _, coordinate := range []string{"source_id", "source_name", "source_dex", "source_form", "local_id", "local_name", "local_dex", "local_form", "local_category", "local_mixed_state"} {
		t.Run(coordinate, func(t *testing.T) {
			m := fixtureMonster(r.localID, r.dex, r.oldName, r.oldForm)
			m["form_category"] = r.category
			d := fixtureDetail(r.dex, r.name, r.form)
			sourceID := r.sourceID
			switch coordinate {
			case "source_id":
				sourceID = "777"
			case "source_name":
				d = fixtureDetail(r.dex, "未审核名", r.form)
			case "source_dex":
				d = fixtureDetail(777, r.name, r.form)
			case "source_form":
				d = fixtureDetail(r.dex, r.name, "未审核形态")
			case "local_id":
				m["id"] = 777
			case "local_name":
				ensure(m, "localized", "zh")["name"] = "未审核名"
			case "local_dex":
				m["dex_number"] = 777
			case "local_form":
				m["form"] = "未审核形态"
			case "local_category":
				m["form_category"] = "无多形态"
			case "local_mixed_state":
				// Renames with different names must not accept old-name/new-form hybrids.
				r = reviewedIdentities[7]
				m = fixtureMonster(r.localID, r.dex, "加尔", r.newForm())
				m["form_category"] = r.category
				d = fixtureDetail(r.dex, r.name, r.form)
				sourceID = r.sourceID
			}
			local := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{})
			p := proposal(t, local, fixtureSource(t, object{sourceID: d}))
			if p.Stats.MatchedMonsters != 0 || p.Stats.AddedMonsters != 0 || !equal(m, findID(t, p.Files.Monsters, idOf(m))) {
				t.Fatalf("unchecked coordinate %s: %+v %+v", coordinate, p.Stats, p.Issues)
			}
		})
	}
	// Identical form words outside the review record are not normalized globally.
	local := fixtureLocal(t, []any{fixtureMonster(700, 700, "其他冬鸟", "冬天的样子")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, local, fixtureSource(t, object{"700": fixtureDetail(700, "其他冬鸟", "本来的样子")}))
	if p.Stats.MatchedMonsters != 0 || p.Stats.AddedMonsters != 0 {
		t.Fatal("winter globally equated to original")
	}
}

func TestReviewedThreeAdditionsAreIndependentAndAllocateStableIDs(t *testing.T) {
	for _, maximum := range []int{619, 9000} {
		monsters := []any{fixtureMonster(maximum, 0, "本地占位", "default"), fixtureMonster(9001, 0, "木桩", "default"), fixtureMonster(343, 218, "烈火守护", "default"), fixtureMonster(379, 238, "月亮砣", "上弦的样子"), fixtureMonster(380, 238, "月亮砣", "下弦的样子")}
		wiki := object{}
		for _, v := range monsters {
			m := asObject(v)
			wiki[displayName(m)] = object{"monster_id": idOf(m), "skills": []any{}}
		}
		details := object{"343": fixtureDetail(218, "烈火守护", ""), "380": fixtureDetail(238, "月亮砣", "上弦的样子"), "381": fixtureDetail(238, "月亮砣", "下弦的样子"), "344": fixtureDetail(218, "烈焰狂战士", "首领形态"), "382": fixtureDetail(238, "满月砣", "上弦的样子"), "383": fixtureDetail(238, "满月砣", "下弦的样子")}
		for _, id := range []string{"344", "382", "383"} {
			d := asObject(details[id])
			d["s"] = ""
			var sourceID int
			fmt.Sscan(id, &sourceID)
			d["evo"] = []any{object{"i": sourceID, "nm": d["nm"], "fn": d["fn"]}}
			for _, excluded := range []string{"h", "w", "si", "desc"} {
				d[excluded] = "DO_NOT_IMPORT"
			}
		}
		source := fixtureSource(t, details)
		p := proposal(t, canonicalFixture(t, monsters, []any{fixtureMove(3, "冲撞", 60)}, wiki), source)
		if p.Stats.AddedMonsters != 3 || p.HasBlockingIssues() {
			t.Fatalf("additions failed: %+v %+v", p.Stats, p.Issues)
		}
		c := importProposal(t, p)
		firstID := maximum + 1
		if firstID == 9001 {
			firstID++
		}
		for offset := 0; offset < 3; offset++ {
			m := canonicalMonster(t, c, firstID+offset)
			if m.MainFormID != 0 || m.EvolvesFromID != 0 || m.FormCategory != "无多形态" || m.Images.Avatar != "" || m.Images.Portrait != "" {
				t.Fatalf("invented relation/image: %+v", m)
			}
			if offset == 0 {
				if !m.IsLeaderForm || m.EvolutionStage != "首领形态" {
					t.Fatal("explicit leader evidence ignored")
				}
			} else if m.EvolutionStage != "首领形态" || !m.IsLeaderForm || m.DataNote != confirmedLeaderNote {
				t.Fatalf("confirmed moon leader role lost: %+v", m)
			}
		}
		if strings.Contains(string(p.Files.Monsters), "DO_NOT_IMPORT") {
			t.Fatal("excluded fields imported")
		}
		second := proposal(t, exportCanonical(t, c), source)
		if len(second.Changes) != 0 || second.Stats.AddedMonsters != 0 {
			t.Fatalf("new identities rebuilt: %+v", second.Changes)
		}
	}
}

func TestReviewedAdditionDoesNotAuthorizeNeighborOrCorruptStage(t *testing.T) {
	for _, test := range []struct {
		id, name, form string
		dex            int
		stage          any
	}{
		{"345", "烈焰狂战士", "首领形态", 218, ""},
		{"344", "别的首领", "首领形态", 218, ""},
		{"382", "满月砣", "上弦的样子", 239, ""},
		{"382", "满月砣", "未审核形态", 238, ""},
		{"382", "满月砣", "", 238, "最终形态"},
		{"382", "满月砣", "上弦的样子", 238, nil},
	} {
		d := fixtureDetail(test.dex, test.name, test.form)
		d["s"] = test.stage
		local := fixtureLocal(t, []any{fixtureMonster(619, 0, "占位", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
		p := proposal(t, local, fixtureSource(t, object{test.id: d}))
		if p.Stats.AddedMonsters != 0 {
			t.Fatalf("unreviewed tuple added: %+v", test)
		}
	}
}
