package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/sourcebaseline"
)

func initialFixture(t *testing.T) *catalog.Catalog {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("..", "..", "data", "catalog.json"))
	if e != nil {
		t.Fatal(e)
	}
	c, e := catalog.Parse(b)
	if e != nil {
		t.Fatal(e)
	}
	c.Extensions["catalog_choices"] = json.RawMessage(`{"version":1,"entries":{"monster:1:stats.hp":{"key":"monster:1:stats.hp","entity":"monster","id":1,"field":"stats.hp","name":"迪莫","choice":"source"}}}`)
	var evidence map[string]any
	if e = json.Unmarshal(c.Extensions["mieli_calibration"], &evidence); e != nil {
		t.Fatal(e)
	}
	evidence["counts"].(map[string]any)["monster_evolution_members_changed"] = 283
	raw, _ := json.Marshal(evidence)
	c.Extensions["mieli_calibration"] = raw
	c.Extensions["unrelated_extension"] = json.RawMessage(`{"preserve":true}`)
	return c
}
func TestInitialCatalogClearsOnlyDeveloperPoliciesAndDeltas(t *testing.T) {
	c := initialFixture(t)
	before, _ := catalog.Marshal(c)
	out, e := initialCatalog(c)
	if e != nil {
		t.Fatal(e)
	}
	after, _ := catalog.Marshal(c)
	if !bytes.Equal(before, after) {
		t.Fatal("input changed")
	}
	if _, ok := out.Extensions["catalog_choices"]; ok {
		t.Fatal("preset policies retained")
	}
	if !bytes.Equal(c.Extensions[sourcebaseline.Extension], out.Extensions[sourcebaseline.Extension]) {
		t.Fatal("Tencent source baseline changed")
	}
	if !reflect.DeepEqual(c.Monsters, out.Monsters) || !reflect.DeepEqual(c.Skills, out.Skills) || !reflect.DeepEqual(c.Learnsets, out.Learnsets) || !reflect.DeepEqual(c.Traits, out.Traits) || !reflect.DeepEqual(c.Types, out.Types) || !reflect.DeepEqual(c.SkillRules, out.SkillRules) {
		t.Fatal("business data changed")
	}
	if !bytes.Equal(c.Extensions["unrelated_extension"], out.Extensions["unrelated_extension"]) {
		t.Fatal("unrelated metadata changed")
	}
	var a, b map[string]json.RawMessage
	json.Unmarshal(c.Extensions["mieli_calibration"], &a)
	json.Unmarshal(out.Extensions["mieli_calibration"], &b)
	for key, raw := range a {
		if key != "counts" && !bytes.Equal(raw, b[key]) {
			t.Fatalf("provenance changed: %s", key)
		}
	}
	var counts map[string]json.RawMessage
	json.Unmarshal(b["counts"], &counts)
	for key := range counts {
		if strings.HasSuffix(key, "_changed") {
			t.Fatal("developer delta remains")
		}
	}
	if len(counts) == 0 {
		t.Fatal("verification evidence deleted")
	}
	again, e := initialCatalog(out)
	if e != nil {
		t.Fatal(e)
	}
	x, _ := catalog.Marshal(out)
	y, _ := catalog.Marshal(again)
	if !bytes.Equal(x, y) {
		t.Fatal("not idempotent")
	}
}
func TestInitialCatalogRejectsMissingOrFutureMetadata(t *testing.T) {
	for _, kind := range []string{"baseline", "policy", "evidence"} {
		t.Run(kind, func(t *testing.T) {
			c := initialFixture(t)
			switch kind {
			case "baseline":
				delete(c.Extensions, sourcebaseline.Extension)
			case "policy":
				c.Extensions["catalog_choices"] = json.RawMessage(`{"version":2,"entries":{}}`)
			case "evidence":
				c.Extensions["mieli_calibration"] = json.RawMessage(`{"version":2,"counts":{}}`)
			}
			if _, e := initialCatalog(c); e == nil {
				t.Fatal("unsafe initial reset accepted")
			}
		})
	}
}
