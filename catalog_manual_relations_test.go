package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestManualMainFormKeepsExplicitProjectionConsistent(t *testing.T) {
	pet := func(id int, form, category string) map[string]interface{} {
		return map[string]interface{}{"id": id, "localized": map[string]interface{}{"zh": map[string]interface{}{"name": "岚鸟"}}, "form": form, "form_category": category}
	}
	main := pet(48, "本来的样子", "主形态")
	variant := pet(50, "春天的样子", "变体形态")
	variant["main_form_id"], variant["main_form_name"] = 999, "错误"
	if err := applyManualMainForm(variant, []map[string]interface{}{main, variant}, "变体形态", "本来的样子"); err != nil {
		t.Fatal(err)
	}
	if variant["main_form_id"] != 48 {
		t.Fatal("stale main_form_id survived save")
	}
	if err := applyManualMainForm(variant, nil, "", ""); err != nil || variant["main_form_id"] != 48 {
		t.Fatal("partial edit cleared pairing")
	}
	before, _ := json.Marshal(variant)
	if err := applyManualMainForm(variant, []map[string]interface{}{main, variant}, "变体形态", "不存在"); err == nil {
		t.Fatal("accepted missing main")
	}
	after, _ := json.Marshal(variant)
	if string(before) != string(after) {
		t.Fatal("failed resolution partially mutated")
	}
	if err := applyManualMainForm(variant, nil, "无多形态", ""); err != nil || variant["main_form_id"] != nil || variant["main_form_name"] != "" {
		t.Fatal("old ID not cleared")
	}
}

func TestManualRelationsPreserveOmittedAndClearExplicit(t *testing.T) {
	m := map[string]interface{}{"evolution_members": []int{1, 2}, "evolves_from_id": 2, "leader_of_id": nil}
	known := map[int]bool{1: true, 2: true, 3: true}
	before, _ := json.Marshal(m)
	if err := applyManualRelationFields(m, 1, known, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(m)
	if string(before) != string(after) {
		t.Fatal("omitted relationship fields changed")
	}
	if err := applyManualRelationFields(m, 1, known, nil, json.RawMessage(`null`), nil); err != nil {
		t.Fatal(err)
	}
	if m["evolves_from_id"] != nil || !reflect.DeepEqual(m["evolution_members"], []int{1, 2}) {
		t.Fatal("explicit clear affected member scope")
	}
	if err := applyManualRelationFields(m, 1, known, nil, nil, json.RawMessage(`2`)); err != nil {
		t.Fatal(err)
	}
	if m["leader_of_id"] != 2 || m["is_leader_form"] != true || m["evolves_from_id"] != nil {
		t.Fatal("leader reference not separate")
	}
}
func TestManualRelationsRejectInvalidBeforeMutation(t *testing.T) {
	known := map[int]bool{1: true, 2: true, 3: true}
	for _, tc := range []struct{ members, from, leader string }{
		{"null", "", ""}, {"[1,1]", "", ""}, {"[99]", "", ""}, {"", "1", ""}, {"", "3", ""}, {"", "1.5", ""}, {"", "", "99"}, {"", "", "1"},
	} {
		m := map[string]interface{}{"evolution_members": []int{1, 2}, "evolves_from_id": 2, "leader_of_id": nil}
		before, _ := json.Marshal(m)
		if err := applyManualRelationFields(m, 1, known, json.RawMessage(tc.members), json.RawMessage(tc.from), json.RawMessage(tc.leader)); err == nil {
			t.Fatalf("accepted invalid relations %+v", tc)
		}
		after, _ := json.Marshal(m)
		if string(before) != string(after) {
			t.Fatalf("partial mutation on invalid request %+v", tc)
		}
	}
}
