package catalog

import (
	"encoding/json"
	"testing"
)

func formProjectionFixture() *Catalog {
	c := testCatalog()
	c.Monsters[0].Name = "岚鸟"
	c.Monsters[0].Form = "本来的样子"
	c.Monsters[0].FormCategory = "主形态"
	c.Monsters[1].Name = "岚鸟"
	c.Monsters[1].Form = "春天的样子"
	c.Monsters[1].FormCategory = "变体形态"
	c.Monsters[1].MainFormID = 1
	c.Monsters[1].EvolvesFromID = 0
	return c
}

func TestMainFormIDProjectionAndLegacyRoundTrip(t *testing.T) {
	c := formProjectionFixture()
	f := mustLegacy(t, c)
	var rows []object
	if err := json.Unmarshal(f.Monsters, &rows); err != nil {
		t.Fatal(err)
	}
	if string(rows[0]["main_form_id"]) != "null" || string(rows[1]["main_form_id"]) != "1" {
		t.Fatal("stable main form ID missing from projection", string(f.Monsters))
	}
	// Removing a deprecated form label does not change an explicitly mapped ID.
	delete(rows[1], "main_form_name")
	rows[0], rows[1] = rows[1], rows[0]
	f.Monsters = mustJSON(rows)
	x := indexCatalog(mustImport(t, f))
	if x.monsters[2].MainFormID != 1 {
		t.Fatal("stable ID changed with row order or missing form label")
	}
	// Historical input without the ID still resolves its precise old form label.
	f = mustLegacy(t, c)
	rows = nil // Unmarshal into fresh maps after the earlier reordered fixture.
	json.Unmarshal(f.Monsters, &rows)
	for _, row := range rows {
		delete(row, "main_form_id")
	}
	f.Monsters = mustJSON(rows)
	out := mustLegacy(t, mustImport(t, f))
	json.Unmarshal(out.Monsters, &rows)
	if string(rows[1]["main_form_id"]) != "1" {
		t.Fatal("legacy import omitted the new stable ID field")
	}
}

func TestMainFormIDExplicitInvalidNeverFallsBackToLabel(t *testing.T) {
	for _, value := range []string{"null", "999", "2", "\"1\""} {
		f := mustLegacy(t, formProjectionFixture())
		var rows []object
		json.Unmarshal(f.Monsters, &rows)
		rows[1]["main_form_id"] = json.RawMessage(value)
		f.Monsters = mustJSON(rows)
		if _, err := ImportLegacy(f); err == nil {
			t.Fatal("invalid explicit form ID silently guessed from label", value)
		}
	}
}

func TestMainFormIDProtectedFromLegacyExtensions(t *testing.T) {
	for _, extension := range []Extensions{
		{"legacy": json.RawMessage(`{"main_form_id":999}`)},
		{"legacy_omit": json.RawMessage(`["main_form_id"]`)},
	} {
		c := formProjectionFixture()
		c.Monsters[1].Extensions = extension
		if _, err := ExportLegacy(c); err == nil {
			t.Fatal("extension overrode main form ID")
		}
	}
}
