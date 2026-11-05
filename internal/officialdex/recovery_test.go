package officialdex

import (
	"testing"

	canonical "xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
)

func TestCanonicalReservationRecoveryAndUnrelatedAllocation(t *testing.T) {
	m := fixtureMonster(7, 2, "小狗", "default")
	m["_source_ref"] = object{"provider": Provider, "id": "103", "identity": "NO.002|小狗|"}
	local := canonicalFixture(t, []any{fixtureMonster(1, 1, "小猫", "default"), m}, []any{fixtureMove(3, "冲撞", 60)}, object{"小猫": object{"monster_id": 1, "skills": []any{}}, "小狗": object{"monster_id": 7, "skills": []any{}}})
	c, err := canonical.ImportLegacy(canonical.LegacyFiles{Monsters: local.Monsters, Moves: local.Moves, Types: local.Types, Wiki: local.Wiki})
	if err != nil {
		t.Fatal(err)
	}
	deleted, _, err := catalogrecovery.DeleteMonsters(c, []string{"小狗"})
	if err != nil {
		t.Fatal(err)
	}
	source := fixtureSource(t, object{"101": fixtureDetail(1, "小猫", ""), "102": fixtureDetail(3, "新猫", ""), "103": fixtureDetail(2, "小狗", "")})
	p, err := BuildCatalogProposal(deleted, source)
	if err != nil || p.HasBlockingIssues() {
		t.Fatal(p, err)
	}
	restored := importProposal(t, p)
	if canonicalMonster(t, restored, 7).Name != "小狗" || canonicalMonster(t, restored, 8).Name != "新猫" {
		t.Fatal("reserved ID reused or recovery reassigned identity")
	}
	restored.Extensions = deleted.Extensions
	if err := catalogrecovery.Validate(restored); err != nil {
		t.Fatal(err)
	}
	second, err := BuildCatalogProposal(restored, source)
	if err != nil || second.Stats.AddedMonsters != 0 {
		t.Fatal("reservation not compatible with restored identity", err)
	}
	changed := fixtureSource(t, object{"101": fixtureDetail(1, "小猫", ""), "103": fixtureDetail(2, "另一只", "")})
	if _, err := BuildCatalogProposal(deleted, changed); err == nil {
		t.Fatal("changed source tuple reused reserved ID")
	}
}
