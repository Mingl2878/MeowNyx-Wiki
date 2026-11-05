package officialdex

import (
	"bytes"
	"fmt"
	"testing"
)

func relationRef(id int, detail object, form bool) object {
	r := object{"i": id, "nm": detail["nm"], "fn": detail["fn"]}
	if form {
		r["f"] = detail["f"]
	}
	return r
}
func relationLocal(t *testing.T, monsters []any) LegacyFiles {
	wiki := object{}
	for _, v := range monsters {
		m := asObject(v)
		wiki[displayName(m)] = object{"monster_id": idOf(m), "skills": []any{object{"name": "冲撞", "source": "默认"}}}
	}
	return canonicalFixture(t, monsters, []any{fixtureMove(3, "冲撞", 60)}, wiki)
}

func TestSourceMembersAreCompleteOrderedPerEntryAndNeverParentsByPosition(t *testing.T) {
	a, b := fixtureMonster(10, 10, "甲", "default"), fixtureMonster(20, 20, "乙", "default")
	a["evolves_from_id"], a["evolution_members"] = 20, []any{10, 20}
	b["evolution_members"] = []any{10, 20}
	sa, sb := fixtureDetail(10, "甲", ""), fixtureDetail(20, "乙", "")
	sa["evo"] = []any{relationRef(99, sb, false)} // self not required, asymmetric
	sb["evo"] = []any{}
	local, source := relationLocal(t, []any{a, b}), fixtureSource(t, object{"90": sa, "99": sb})
	before := append([]byte{}, local.Monsters...)
	p := proposal(t, local, source)
	if !bytes.Equal(before, local.Monsters) {
		t.Fatal("BuildProposal mutated input")
	}
	ca, cb := canonicalMonster(t, importProposal(t, p), 10), canonicalMonster(t, importProposal(t, p), 20)
	if !equal(ca.EvolutionMembers, []int{20}) || ca.EvolvesFromID != 20 || !equal(cb.EvolutionMembers, []int{}) || cb.EvolvesFromID != 0 {
		t.Fatal("lists closed/sorted or ordinary predecessor guessed", ca, cb)
	}
	p2 := proposal(t, exportCanonical(t, importProposal(t, p)), source)
	if len(p2.Changes) != 0 {
		t.Fatal("repeat has business changes", p2.Changes)
	}
	// A non-topological source order must be retained verbatim.
	sa["evo"] = []any{relationRef(90, sa, false), relationRef(99, sb, false)}
	p = proposal(t, local, fixtureSource(t, object{"90": sa, "99": sb}))
	if !equal(canonicalMonster(t, importProposal(t, p), 10).EvolutionMembers, []int{10, 20}) {
		t.Fatal("source order changed")
	}
}

func TestUnavailableSourceMembersNeverBecomeEmptyOrPartial(t *testing.T) {
	for _, kind := range []string{"missing", "null", "object", "duplicate", "dangling", "name conflict", "invalid id", "unmapped"} {
		t.Run(kind, func(t *testing.T) {
			a, b := fixtureMonster(10, 10, "甲", "default"), fixtureMonster(20, 20, "乙", "default")
			a["evolves_from_id"], a["evolution_members"] = 20, []any{10, 20}
			b["evolution_members"] = []any{}
			sa, sb := fixtureDetail(10, "甲", ""), fixtureDetail(20, "乙", "")
			sa["evo"] = []any{relationRef(90, sa, false), relationRef(99, sb, false)}
			details := object{"90": sa, "99": sb}
			switch kind {
			case "missing":
				delete(sa, "evo")
			case "null":
				sa["evo"] = nil
			case "object":
				sa["evo"] = object{}
			case "duplicate":
				sa["evo"] = []any{relationRef(90, sa, false), relationRef(90, sa, false)}
			case "dangling":
				sa["evo"] = []any{relationRef(90, sa, false), relationRef(100, sb, false)}
			case "name conflict":
				r := relationRef(99, sb, false)
				r["nm"] = "错误"
				sa["evo"] = []any{r}
			case "invalid id":
				r := relationRef(99, sb, false)
				r["i"] = "99"
				sa["evo"] = []any{r}
			case "unmapped":
				unknown := fixtureDetail(30, "新复杂形态", "未知形态")
				details["100"] = unknown
				sa["evo"] = []any{relationRef(90, sa, false), relationRef(100, unknown, false)}
			}
			local := relationLocal(t, []any{a, b})
			p := proposal(t, local, fixtureSource(t, details))
			got := findID(t, p.Files.Monsters, 10)
			if !equal(got["evolution_members"], a["evolution_members"]) || !equal(got["evolves_from_id"], 20) {
				t.Fatal("unavailable source cleared/partially replaced relations", p.Changes)
			}
			warning := false
			for _, issue := range p.Issues {
				if issue.ID == 10 && issue.Field == "evolution_members" && issue.Code == "source_relationship_unavailable" && issue.Severity == "warning" {
					warning = true
				}
			}
			if !warning {
				t.Fatal("unavailable candidate warning missing", p.Issues)
			}
			for _, ch := range p.Changes {
				if ch.ID == 10 && (ch.Field == "evolution_members" || ch.Field == "evolves_from_id") {
					t.Fatal("unusable source exposed a change", ch)
				}
			}
			importProposal(t, p)
		})
	}
}

func TestSelfOnlyAndExplicitEmptyClearOrdinaryEdges(t *testing.T) {
	for _, empty := range []bool{false, true} {
		a, b := fixtureMonster(10, 10, "甲", "default"), fixtureMonster(20, 20, "乙", "default")
		a["evolves_from_id"], a["evolution_members"] = 20, []any{10, 20}
		b["evolution_members"] = []any{}
		sa, sb := fixtureDetail(10, "甲", ""), fixtureDetail(20, "乙", "")
		want := []int{}
		if !empty {
			sa["evo"] = []any{relationRef(90, sa, false)}
			want = []int{10}
		}
		p := proposal(t, relationLocal(t, []any{a, b}), fixtureSource(t, object{"90": sa, "99": sb}))
		m := canonicalMonster(t, importProposal(t, p), 10)
		if m.EvolvesFromID != 0 || !equal(m.EvolutionMembers, want) {
			t.Fatal("valid empty/self list not authoritative", m)
		}
	}
}

func TestLeaderMigrationNeedsCorrectRoleDexAndFormsNotSameDexGuess(t *testing.T) {
	for _, kind := range []string{"proven", "different dex", "no forms", "parent leader", "no old parent"} {
		t.Run(kind, func(t *testing.T) {
			a, b := fixtureMonster(10, 10, "首领甲", "default"), fixtureMonster(20, 10, "甲", "default")
			a["is_leader_form"], a["evolution_stage"] = true, "首领形态"
			a["evolves_from_id"], a["evolution_members"] = 20, []any{10, 20}
			b["evolution_members"] = []any{}
			sa, sb := fixtureDetail(10, "首领甲", "首领形态"), fixtureDetail(10, "甲", "")
			sa["forms"] = []any{relationRef(99, sb, true)}
			sb["forms"] = []any{relationRef(90, sa, true)}
			switch kind {
			case "different dex":
				b["dex_number"] = 11
				sb = fixtureDetail(11, "甲", "")
			case "no forms":
				sa["forms"], sb["forms"] = []any{}, []any{}
			case "parent leader":
				b["is_leader_form"] = true
				sb = fixtureDetail(10, "甲", "首领形态")
				sa["forms"] = []any{relationRef(99, sb, true)}
			case "no old parent":
				a["evolves_from_id"] = nil
			}
			p := proposal(t, relationLocal(t, []any{a, b}), fixtureSource(t, object{"90": sa, "99": sb}))
			m := canonicalMonster(t, importProposal(t, p), 10)
			want := 0
			if kind == "proven" {
				want = 20
			}
			if m.LeaderOfID != want || m.EvolvesFromID != 0 {
				t.Fatal("unproven leader guessed or duplicated ordinary edge", kind, m)
			}
		})
	}
}

func TestReviewedLeaderPrecedesReverseOrdinaryRepairAndInvalidSourceCannotCauseRing(t *testing.T) {
	for _, badBase := range []bool{false, true} {
		middle, base, leader := fixtureMonster(197, 106, "阿米樱", "default"), fixtureMonster(199, 107, "罗隐", "default"), fixtureMonster(198, 107, "深渊罗隐", "default")
		middle["evolution_members"] = []any{197, 198, 199}
		base["evolution_members"], base["evolves_from_id"] = []any{197, 198, 199}, 198
		leader["evolution_members"], leader["evolves_from_id"] = []any{197, 198, 199}, 197
		leader["is_leader_form"], leader["evolution_stage"] = true, "首领形态"
		sm, sb, sl := fixtureDetail(106, "阿米樱", ""), fixtureDetail(107, "罗隐", ""), fixtureDetail(107, "深渊罗隐", "首领形态")
		refs := []any{relationRef(197, sm, false), relationRef(198, sb, false), relationRef(199, sl, false)}
		sm["evo"], sb["evo"], sl["evo"] = refs, refs, []any{relationRef(199, sl, false)}
		sb["forms"], sl["forms"] = []any{relationRef(199, sl, true)}, []any{relationRef(198, sb, true)}
		if badBase {
			delete(sb, "evo")
		}
		source := fixtureSource(t, object{"197": sm, "198": sb, "199": sl})
		p := proposal(t, relationLocal(t, []any{middle, leader, base}), source)
		c := importProposal(t, p)
		l, b := canonicalMonster(t, c, 198), canonicalMonster(t, c, 199)
		if badBase {
			if l.LeaderOfID != 0 || l.EvolvesFromID != 197 || b.EvolvesFromID != 198 || !hasIssue(p, "source_relationship_cycle") {
				t.Fatal("unsafe reverse chain source was not disabled", l, b, p.Issues)
			}
		} else {
			if l.LeaderOfID != 199 || l.EvolvesFromID != 0 || b.EvolvesFromID != 197 {
				t.Fatal("reviewed corrections wrong", l, b)
			}
			second := proposal(t, exportCanonical(t, c), source)
			if len(second.Changes) != 0 {
				t.Fatal("relation repair not idempotent", second.Changes)
			}
		}
	}
}

func TestReviewedLeaderRegistrationWithoutFormsStillCrossChecksIdentities(t *testing.T) {
	for _, spoof := range []bool{false, true} {
		name, parentName := "千棘海针", "千棘盔"
		if spoof {
			name, parentName = "冒用数字首领", "冒用数字普通"
		}
		leader, parent := fixtureMonster(166, 78, name, "磨损的样子"), fixtureMonster(164, 78, parentName, "磨损的样子")
		leader["is_leader_form"], leader["evolution_stage"] = true, "首领形态"
		leader["evolution_members"], parent["evolution_members"] = []any{166}, []any{164}
		sl, sp := fixtureDetail(78, name, "磨损的样子"), fixtureDetail(78, parentName, "磨损的样子")
		sl["s"] = ""
		delete(sl, "forms")
		delete(sp, "forms")
		p := proposal(t, relationLocal(t, []any{leader, parent}), fixtureSource(t, object{"166": sl, "164": sp}))
		m := canonicalMonster(t, importProposal(t, p), 166)
		if spoof {
			if m.LeaderOfID != 0 {
				t.Fatal("source/local numeric pairs authorized an unreviewed identity")
			}
		} else {
			if m.LeaderOfID != 164 || !hasIssue(p, "confirmed_leader_source_incomplete") {
				t.Fatal("human confirmation incorrectly depends on forms", m, p.Issues)
			}
			for _, issue := range p.Issues {
				if issue.SourceID == "166" && issue.Field == "leader_of_id" && issue.Code == "source_relationship_unavailable" {
					t.Fatal("confirmed available candidate marked unavailable")
				}
			}
		}
	}
}

func TestExistingLeaderSurvivesMissingFormsAndStageWithoutRebuildingMembers(t *testing.T) {
	leader, parent := fixtureMonster(10, 10, "首领甲", "default"), fixtureMonster(20, 10, "甲", "default")
	leader["is_leader_form"], leader["evolution_stage"], leader["leader_of_id"] = true, "首领形态", 20
	leader["evolution_members"], parent["evolution_members"] = []any{}, []any{}
	sl, sp := fixtureDetail(10, "首领甲", "首领形态"), fixtureDetail(10, "甲", "")
	delete(sl, "forms")
	delete(sl, "evo")
	delete(sl, "s")
	p := proposal(t, relationLocal(t, []any{leader, parent}), fixtureSource(t, object{"90": sl, "99": sp}))
	m := canonicalMonster(t, importProposal(t, p), 10)
	if m.LeaderOfID != 20 || m.EvolutionStage != "首领形态" || !m.IsLeaderForm || len(m.EvolutionMembers) != 0 {
		t.Fatal("existing independently known leader was discarded", m)
	}
}

func TestConfirmedMoonRolesAndLeaderSourcesStayIndependent(t *testing.T) {
	monsters, details := []any{}, object{}
	for i, form := range []string{"上弦的样子", "下弦的样子"} {
		base := fixtureMonster(379+i, 238, "月亮砣", form)
		leader := fixtureMonster(621+i, 238, "满月砣", form)
		leader["evolution_stage"], leader["data_note"] = "未确认", independentFormNote
		base["evolution_members"], leader["evolution_members"] = []any{379 + i}, []any{621 + i}
		sb, sl := fixtureDetail(238, "月亮砣", form), fixtureDetail(238, "满月砣", form)
		sl["s"] = ""
		sb["forms"], sl["forms"] = []any{relationRef(382+i, sl, true)}, []any{relationRef(380+i, sb, true)}
		monsters = append(monsters, base, leader)
		details[fmt.Sprint(380+i)], details[fmt.Sprint(382+i)] = sb, sl
	}
	source := fixtureSource(t, details)
	p := proposal(t, relationLocal(t, monsters), source)
	c := importProposal(t, p)
	for i := 0; i < 2; i++ {
		m := canonicalMonster(t, c, 621+i)
		if m.LeaderOfID != 379+i || m.EvolvesFromID != 0 || m.MainFormID != 0 || !m.IsLeaderForm || m.EvolutionStage != "首领形态" {
			t.Fatal("moon explicit role/source lost", m)
		}
	}
	if !hasIssue(p, "confirmed_leader_stage_source_incomplete") {
		t.Fatal("confirmed stage information notice missing")
	}
	for _, issue := range p.Issues {
		if (issue.ID == 621 || issue.ID == 622) && issue.Field == "s" {
			t.Fatal("confirmed stage incorrectly marked unavailable", issue)
		}
	}
	second := proposal(t, exportCanonical(t, c), source)
	if len(second.Changes) != 0 {
		t.Fatal("confirmed roles reverted/repeated", second.Changes)
	}
}
