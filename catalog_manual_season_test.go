package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"xhmwiki/internal/catalog"
)

func TestNativeManualUnrelatedEditPreservesMonsterSeason(t *testing.T) {
	for _, season := range []string{"", "S5", "S6", "local-future-season"} {
		t.Run(season, func(t *testing.T) {
			fx := catalogTestNew(t, 2, true, nil)
			before := fx.rt.store.Current()
			c, err := catalog.Parse(before.Data)
			if err != nil {
				t.Fatal(err)
			}
			c.Monsters[0].Season = season
			c.Monsters[1].Season = "S4"
			note := json.RawMessage(`{"keep":"unrelated local metadata"}`)
			// The existing native transaction preserves root metadata separately
			// from the legacy form projection; do not widen season work to opaque
			// per-monster extensions that the old manual projection never carried.
			if c.Extensions == nil {
				c.Extensions = catalog.Extensions{}
			}
			c.Extensions["future_local_field"] = note
			data, err := catalog.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			installed, err := fx.rt.store.Commit(data, before.Revision, nil)
			if err != nil {
				t.Fatal(err)
			}
			body := catalogTestManualBody(installed.Revision, 115)
			if _, present := body["season"]; present {
				t.Fatal("unrelated form unexpectedly supplied season")
			}
			response := catalogTestManual(t, fx.rt, "edit", body)
			if response.Code != 200 {
				t.Fatalf("manual save: %d %s", response.Code, response.Body.String())
			}
			current := fx.rt.store.Current()
			if current.Revision == installed.Revision {
				t.Fatal("manual edit was not committed")
			}
			updated, err := catalog.Parse(current.Data)
			if err != nil {
				t.Fatal(err)
			}
			if updated.Monsters[0].Stats.HP != 115 || updated.Monsters[0].Season != season || updated.Monsters[1].Season != "S4" {
				t.Fatal("unrelated manual edit lost/guessed a monster season")
			}
			if !bytes.Equal(updated.Extensions["future_local_field"], note) {
				t.Fatal("manual edit lost unknown future metadata")
			}
			files, err := catalog.ExportLegacy(updated)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := catalog.ImportLegacy(files)
			if err != nil {
				t.Fatal(err)
			}
			if restored.Monsters[0].Season != season || restored.Monsters[1].Season != "S4" {
				t.Fatal("native edited projection/import lost season")
			}
			if stale := catalogTestManual(t, fx.rt, "edit", body); stale.Code != 409 {
				t.Fatalf("stale manual save accepted: %d %s", stale.Code, stale.Body.String())
			}
		})
	}
}
