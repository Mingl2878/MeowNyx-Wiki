package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestMonsterSeasonOptionalRoundTrip(t *testing.T) {
	for _, season := range []string{"", "S1", "S2", "S3", "S4", "S5", "S6", "local-future-season"} {
		t.Run(season, func(t *testing.T) {
			c := testCatalog()
			c.Monsters[0].Season = season
			b, err := Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := Parse(b)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(c, parsed) {
				t.Fatal("optional season changed the typed roundtrip")
			}
			files := mustLegacy(t, parsed)
			var rows []object
			if err := json.Unmarshal(files.Monsters, &rows); err != nil {
				t.Fatal(err)
			}
			if _, present := rows[0]["season"]; present != (season != "") {
				t.Fatalf("season presence does not match nonempty value %q", season)
			}
			if _, present := rows[1]["season"]; present {
				t.Fatal("projection forced season onto an old monster")
			}
			restored := mustImport(t, files)
			if restored.Monsters[0].Season != season || restored.Monsters[1].Season != "" {
				t.Fatal("legacy importer lost or guessed season")
			}
			assertJSONEqual(t, files.Monsters, mustLegacy(t, restored).Monsters)
		})
	}
}

func TestMonsterSeasonLegacyConsumesEmptyAndNull(t *testing.T) {
	for _, raw := range []string{`""`, `null`} {
		t.Run(raw, func(t *testing.T) {
			files := mustLegacy(t, testCatalog())
			var rows []object
			if err := json.Unmarshal(files.Monsters, &rows); err != nil {
				t.Fatal(err)
			}
			rows[0]["season"] = json.RawMessage(raw)
			files.Monsters = mustJSON(rows)
			c := mustImport(t, files)
			if c.Monsters[0].Season != "" {
				t.Fatal("empty optional season guessed a value")
			}
			if bytes.Contains(c.Monsters[0].Extensions["legacy"], []byte(`"season"`)) {
				t.Fatal("consumed optional season retained a legacy override")
			}
			rows = nil
			if err := json.Unmarshal(mustLegacy(t, c).Monsters, &rows); err != nil {
				t.Fatal(err)
			}
			if _, present := rows[0]["season"]; present {
				t.Fatal("empty season must not be projected")
			}
		})
	}
}

func TestMonsterSeasonRejectsNonStringsAndMetadataOverrides(t *testing.T) {
	for _, raw := range []string{`5`, `true`, `[]`, `{}`} {
		var c object
		if err := json.Unmarshal(mustJSON(testCatalog()), &c); err != nil {
			t.Fatal(err)
		}
		var monsters []object
		if err := json.Unmarshal(c["monsters"], &monsters); err != nil {
			t.Fatal(err)
		}
		monsters[0]["season"] = json.RawMessage(raw)
		c["monsters"] = mustJSON(monsters)
		if _, err := Parse(mustJSON(c)); err == nil {
			t.Fatalf("canonical accepted non-string season %s", raw)
		}
		files := mustLegacy(t, testCatalog())
		if err := json.Unmarshal(files.Monsters, &monsters); err != nil {
			t.Fatal(err)
		}
		monsters[0]["season"] = json.RawMessage(raw)
		files.Monsters = mustJSON(monsters)
		if _, err := ImportLegacy(files); err == nil {
			t.Fatalf("legacy accepted non-string season %s", raw)
		}
	}
	for _, ext := range []Extensions{
		{"legacy": json.RawMessage(`{"season":"S4"}`)},
		{"legacy_omit": json.RawMessage(`["season"]`)},
	} {
		c := testCatalog()
		c.Monsters[0].Season = "S5"
		c.Monsters[0].Extensions = ext
		if err := Validate(c); err == nil {
			t.Fatal("metadata can override or remove explicit season")
		}
	}
}

func TestMonsterSeasonOldSchemaAndUnknownFieldsPreserved(t *testing.T) {
	for _, version := range []int{1, 2} {
		var raw object
		if err := json.Unmarshal(mustJSON(testCatalog()), &raw); err != nil {
			t.Fatal(err)
		}
		raw["schema_version"] = rawJSON(version)
		var monsters []object
		if err := json.Unmarshal(raw["monsters"], &monsters); err != nil {
			t.Fatal(err)
		}
		monsters[0]["future_local_field"] = json.RawMessage(`{"keep":[1,"untouched"]}`)
		if version == 1 {
			for _, m := range monsters {
				delete(m, "evolution_members")
			}
		}
		raw["monsters"] = mustJSON(monsters)
		parsed, err := Parse(mustJSON(raw))
		if err != nil {
			t.Fatal(err)
		}
		if parsed.SchemaVersion != 2 || parsed.Monsters[0].Season != "" {
			t.Fatal("old schema forced season or changed the schema contract")
		}
		assertJSONEqual(t, parsed.Monsters[0].Extensions["future_local_field"], monsters[0]["future_local_field"])
		parsed.Monsters[0].Season = "S6"
		b, err := Marshal(parsed)
		if err != nil {
			t.Fatal(err)
		}
		restored, err := Parse(b)
		if err != nil {
			t.Fatal(err)
		}
		if restored.Monsters[0].Season != "S6" {
			t.Fatal("future optional string was not preserved")
		}
		assertJSONEqual(t, restored.Monsters[0].Extensions["future_local_field"], monsters[0]["future_local_field"])
		raw["schema_version"] = rawJSON(3)
		if _, err := Parse(mustJSON(raw)); err == nil {
			t.Fatal("future persistence schema accepted")
		}
	}
}

// A synthetic-only stdout bridge for JS parity; no source catalog reads or writes.
func TestMonsterSeasonJSProjectionFixture(t *testing.T) {
	fixtures := []object{}
	for _, seasons := range [][2]string{{"", ""}, {"S5", "S4"}, {"S6", "local-future-season"}} {
		c := testCatalog()
		c.Monsters[0].Season, c.Monsters[1].Season = seasons[0], seasons[1]
		c.Monsters[0].Extensions = Extensions{"future_local_field": json.RawMessage(`{"keep":true}`), "legacy": json.RawMessage(`{"local_display_note":"keep"}`)}
		f := mustLegacy(t, c)
		b, err := Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, object{"catalog": b, "legacy": rawJSON(object{"monsters": f.Monsters, "moves": f.Moves, "types": f.Types, "wiki": f.Wiki})})
	}
	fmt.Printf("MONSTER_SEASON_JS_FIXTURE=%s\n", rawJSON(fixtures))
}
