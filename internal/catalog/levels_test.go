package catalog

import (
	"encoding/json"
	"testing"
)

func TestLevelRangeRoundTripAndValidation(t *testing.T) {
	c := testCatalog()
	m := &c.Monsters[0]
	m.LevelConfigurable = true
	m.DefaultLevel = 60
	m.LevelMin = 40
	m.LevelMax = 99
	m.LevelStep = 2
	data, err := Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	files, err := ExportLegacy(parsed)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := ImportLegacy(files)
	if err != nil {
		t.Fatal(err)
	}
	got := restored.Monsters[0]
	if got.DefaultLevel != 60 || got.LevelMin != 40 || got.LevelMax != 99 || got.LevelStep != 2 || !got.LevelConfigurable {
		t.Fatalf("controls lost: %+v", got)
	}
	for _, values := range [][4]int{{60, 0, 99, 2}, {60, 70, 99, 2}, {60, 1, 100, 2}, {60, 1, 99, 0}, {60, 1, 99, 99}} {
		m.DefaultLevel = values[0]
		m.LevelMin = values[1]
		m.LevelMax = values[2]
		m.LevelStep = values[3]
		if _, err = Marshal(c); err == nil {
			t.Fatalf("bad level settings accepted: %v", values)
		}
	}
	m.DefaultLevel = 60
	m.LevelMin = 1
	m.LevelMax = 99
	m.LevelStep = 2
	m.Extensions = Extensions{"legacy": json.RawMessage(`{"level_step":7}`)}
	if _, err = Marshal(c); err == nil {
		t.Fatal("legacy patch overrode explicit controls")
	}
}
