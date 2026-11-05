package catalog

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestV1MigrationSnapshotsOnceWithoutLosingOldFields(t *testing.T) {
	original := testCatalog()
	var raw map[string]any
	if err := json.Unmarshal(mustJSON(original), &raw); err != nil {
		t.Fatal(err)
	}
	raw["schema_version"] = 1
	for _, value := range raw["monsters"].([]any) {
		delete(value.(map[string]any), "evolution_members")
	}
	v1 := mustJSON(raw)
	migrated, err := Parse(v1)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.SchemaVersion != 2 || !reflect.DeepEqual(migrated, original) {
		t.Fatal("v1 fields or snapshot changed", migrated)
	}
	// An asymmetric, ordered v2 list is authoritative; the ordinary graph must
	// never grow it back on another parse or a Legacy edit roundtrip.
	migrated.Monsters[0].EvolutionMembers = []int{}
	migrated.Monsters[1].EvolutionMembers = []int{1}
	migrated.Monsters[1].LeaderOfID = 1
	migrated.Monsters[1].EvolvesFromID = 0
	for i := 0; i < 3; i++ {
		b, err := Marshal(migrated)
		if err != nil {
			t.Fatal(err)
		}
		migrated, err = Parse(b)
		if err != nil {
			t.Fatal(err)
		}
		migrated = mustImport(t, mustLegacy(t, migrated))
		if !reflect.DeepEqual(migrated.Monsters[0].EvolutionMembers, []int{}) || !reflect.DeepEqual(migrated.Monsters[1].EvolutionMembers, []int{1}) || migrated.Monsters[1].LeaderOfID != 1 {
			t.Fatal("v2 list was rebuilt")
		}
	}
}

func TestLegacyV1AndMixedMissingMembersAreDifferent(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		f := mustLegacy(t, testCatalog())
		var rows []object
		json.Unmarshal(f.Monsters, &rows)
		delete(rows[1], "evolution_members")
		delete(rows[1], "leader_of_id")
		if mixed {
			rows[0]["evolution_members"] = mustJSON([]int{})
		} else {
			delete(rows[0], "evolution_members")
			delete(rows[0], "leader_of_id")
		}
		f.Monsters = mustJSON(rows)
		c := mustImport(t, f)
		want0, want1 := []int{1, 2}, []int{1, 2}
		if mixed {
			want0, want1 = []int{}, []int{2, 1}
		}
		if !reflect.DeepEqual(c.Monsters[0].EvolutionMembers, want0) || !reflect.DeepEqual(c.Monsters[1].EvolutionMembers, want1) {
			t.Fatalf("mixed=%v incorrect snapshots: %+v", mixed, c.Monsters)
		}
		out := mustLegacy(t, c)
		var exported []object
		json.Unmarshal(out.Monsters, &exported)
		for _, r := range exported {
			if r["evolution_members"] == nil || r["leader_of_id"] == nil {
				t.Fatal("new fields omitted from projection")
			}
		}
	}
}

func TestRelationValidationNoClosureButRejectsInvalidGraphs(t *testing.T) {
	for name, change := range map[string]func(*Catalog){
		"missing members":             func(c *Catalog) { c.Monsters[0].EvolutionMembers = nil },
		"duplicate member":            func(c *Catalog) { c.Monsters[0].EvolutionMembers = []int{1, 1} },
		"dangling member":             func(c *Catalog) { c.Monsters[0].EvolutionMembers = []int{9} },
		"parent outside members":      func(c *Catalog) { c.Monsters[1].EvolutionMembers = []int{2} },
		"self leader":                 func(c *Catalog) { c.Monsters[0].LeaderOfID = 1 },
		"dangling leader":             func(c *Catalog) { c.Monsters[0].LeaderOfID = 9 },
		"ordinary and leader coexist": func(c *Catalog) { c.Monsters[1].LeaderOfID = 1 },
		"leader cycle": func(c *Catalog) {
			c.Monsters[0].LeaderOfID = 2
			c.Monsters[1].LeaderOfID = 1
			c.Monsters[1].EvolvesFromID = 0
		},
		"member patch": func(c *Catalog) {
			c.Monsters[0].Extensions = Extensions{"legacy": mustJSON(map[string]any{"evolution_members": []int{}})}
		},
		"leader omit": func(c *Catalog) {
			c.Monsters[0].Extensions = Extensions{"legacy_omit": mustJSON([]string{"leader_of_id"})}
		},
	} {
		t.Run(name, func(t *testing.T) {
			c := testCatalog()
			change(c)
			if err := Validate(c); err == nil {
				t.Fatal("invalid relation accepted")
			}
		})
	}
	for _, version := range []int{1, 2} {
		for _, invalid := range []json.RawMessage{json.RawMessage(`null`), json.RawMessage(`{}`), json.RawMessage(`[1,1]`), json.RawMessage(`[999]`)} {
			var raw object
			json.Unmarshal(mustJSON(testCatalog()), &raw)
			raw["schema_version"] = mustJSON(version)
			var rows []object
			json.Unmarshal(raw["monsters"], &rows)
			rows[0]["evolution_members"] = invalid
			raw["monsters"] = mustJSON(rows)
			if _, err := Parse(mustJSON(raw)); err == nil {
				t.Fatalf("schema%d accepted %s", version, invalid)
			}
		}
	}
	c := testCatalog()
	c.Monsters[0].EvolutionMembers = []int{2}
	c.Monsters[1].EvolutionMembers = []int{2, 1}
	if err := Validate(c); err != nil {
		t.Fatal("self/order/asymmetry incorrectly constrained", err)
	}
}

func TestV1MigrationRejectsCyclesDanglingAndFutureVersions(t *testing.T) {
	for _, field := range []string{"cycle", "dangling", "future"} {
		var raw map[string]any
		json.Unmarshal(mustJSON(testCatalog()), &raw)
		raw["schema_version"] = 1
		for _, v := range raw["monsters"].([]any) {
			delete(v.(map[string]any), "evolution_members")
		}
		m := raw["monsters"].([]any)[0].(map[string]any)
		switch field {
		case "cycle":
			m["evolves_from_id"] = 2
		case "dangling":
			m["evolves_from_id"] = 99
		case "future":
			raw["schema_version"] = 3
		}
		if _, err := Parse(mustJSON(raw)); err == nil {
			t.Fatal("accepted", field)
		}
	}
}
