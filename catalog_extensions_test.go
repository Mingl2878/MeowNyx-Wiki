package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"xhmwiki/internal/catalog"
)

func TestCatalogRootMetadataSurvivesManualAndOfficialUpdates(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	snap := fx.rt.store.Current()
	current, err := catalog.Parse(snap.Data)
	if err != nil {
		t.Fatal(err)
	}
	note := json.RawMessage(`{"user_note":"keep this local metadata","version":7}`)
	current.Extensions = catalog.Extensions{"local_metadata": note}
	data, err := catalog.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	first, err := fx.rt.store.Commit(data, snap.Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	saved := catalogTestManual(t, fx.rt, "edit", catalogTestManualBody(first.Revision, 115))
	if saved.Code != 200 {
		t.Fatalf("manual: %d %s", saved.Code, saved.Body.String())
	}
	check := func() {
		t.Helper()
		c, e := catalog.Parse(fx.rt.store.Current().Data)
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(c.Extensions["local_metadata"], note) {
			t.Fatalf("lost root metadata: %s", c.Extensions["local_metadata"])
		}
	}
	check()
	preview := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	result := catalogTestApply(t, fx, preview)
	if result.State != "applied" {
		t.Fatalf("official update: %+v", result)
	}
	check()
}
