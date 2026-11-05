package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"xhmwiki/internal/catalog"
)

func TestManualLevelControlsValidateAndPreserveOmitted(t *testing.T) {
	m := map[string]interface{}{"default_level": 99, "level_configurable": true, "unrelated": "keep"}
	before, _ := json.Marshal(m)
	if err := applyManualLevelControls(m, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(m)
	if !bytes.Equal(before, after) {
		t.Fatal("omitted controls changed data")
	}
	for _, raw := range []string{`null`, `{}`, `{"enabled":true,"default":60,"min":70,"max":99,"step":2}`, `{"enabled":true,"default":60,"min":1,"max":99,"step":0}`, `{"enabled":true,"default":60,"min":1,"max":99,"step":1.5}`, `{"enabled":false,"default":60,"min":1,"max":99,"step":1,"unknown":2}`} {
		if err := applyManualLevelControls(m, json.RawMessage(raw)); err == nil {
			t.Fatal("invalid settings accepted", raw)
		}
		after, _ = json.Marshal(m)
		if !bytes.Equal(before, after) {
			t.Fatal("failed edit mutated data")
		}
	}
	if err := applyManualLevelControls(m, json.RawMessage(`{"enabled":true,"default":60,"min":40,"max":99,"step":2}`)); err != nil {
		t.Fatal(err)
	}
	if m["level_step"] != 2 || m["default_level"] != 60 || m["unrelated"] != "keep" {
		t.Fatal(m)
	}
}

func TestNativeManualLevelControlsCommitWithRevision(t *testing.T) {
	fx := catalogTestNew(t, 2, true, nil)
	before := fx.rt.store.Current()
	body := catalogTestManualBody(before.Revision, 91)
	body["level_controls"] = catalogTestObject{"enabled": true, "default": 60, "min": 40, "max": 99, "step": 2}
	w := catalogTestManual(t, fx.rt, "edit", body)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	current := fx.rt.store.Current()
	c, err := catalog.Parse(current.Data)
	if err != nil {
		t.Fatal(err)
	}
	m := c.Monsters[0]
	if !m.LevelConfigurable || m.DefaultLevel != 60 || m.LevelStep != 2 || m.LevelMin != 40 || m.LevelMax != 99 {
		t.Fatalf("not committed: %+v", m)
	}
	// New parameters do not allow an old page to overwrite this revision.
	if w = catalogTestManual(t, fx.rt, "edit", body); w.Code != 409 {
		t.Fatalf("stale save: %d %s", w.Code, w.Body.String())
	}
	newer := catalogTestManualBody(current.Revision, 92)
	if w = catalogTestManual(t, fx.rt, "edit", newer); w.Code != 200 {
		t.Fatalf("partial save: %d %s", w.Code, w.Body.String())
	}
	c, err = catalog.Parse(fx.rt.store.Current().Data)
	if err != nil {
		t.Fatal(err)
	}
	if c.Monsters[0].LevelStep != 2 {
		t.Fatal("omitted controls were erased")
	}
}
