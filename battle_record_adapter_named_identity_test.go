package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBattleNamedInitialBaseAndSafeOpeningOthers(t *testing.T) {
	for _, mode := range []string{"matched", "absent owner", "unmatched", "ambiguous sides", "duplicate owner", "not opening", "conflicting pet"} {
		t.Run(mode, func(t *testing.T) {
			frame := domainNamedFrame(t)
			state, _ := domainNamedParts(frame)
			enemy := state["enemy_team"].([]any)[0].(map[string]any)
			first := enemy["pets"].([]any)[0].(map[string]any)
			first["battle_common_pet_info"].(map[string]any)["base_conf_id"] = json.Number("102")
			first["battle_inside_pet_info"].(map[string]any)["base_conf_id"] = json.Number("101")
			other := map[string]any{"role_uin": json.Number("444"), "account": "PRIVATE_SENTINEL", "pets": []any{first, map[string]any{
				"battle_inside_pet_info": map[string]any{"pet_id": json.Number("204"), "conf_id": json.Number("10004")},
				"battle_common_pet_info": map[string]any{"base_conf_id": json.Number("103"), "conf_id": json.Number("10004")},
			}}}
			state["others"] = []any{other}
			opening := true
			switch mode {
			case "absent owner":
				delete(other, "role_uin")
			case "unmatched":
				other["role_uin"] = json.Number("555")
			case "ambiguous sides":
				state["player_team"].([]any)[0].(map[string]any)["base"].(map[string]any)["role_uin"] = json.Number("444")
			case "duplicate owner":
				state["enemy_team"] = append(state["enemy_team"].([]any), map[string]any{"base": map[string]any{"role_uin": json.Number("444")}})
			case "not opening":
				opening = false
			case "conflicting pet":
				other["pets"].([]any)[1].(map[string]any)["battle_inside_pet_info"].(map[string]any)["pet_id"] = json.Number("202")
			}
			r := BattleRecord{ID: "safe", Sides: map[string]BattleSide{}}
			err := battleAdaptNamed(&r, state, nil, opening)
			if mode == "conflicting pet" {
				if err == nil {
					t.Fatal("same instance conflict accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := ValidateBattleRecord(&r); err != nil {
				t.Fatal(err)
			}
			want := 2
			if mode == "matched" {
				want = 3
			}
			if len(r.Sides["enemy"].Pets) != want || len(r.Sides["me"].Pets) != 1 {
				t.Fatal("unsafe others join/dedup", r.Sides)
			}
			pet := r.Sides["enemy"].Pets[0]
			if pet.ProtocolBaseID != "102" || pet.ProtocolID != "10002" || pet.MonsterID != 0 {
				t.Fatal("initial base overwritten/guessed", pet)
			}
			if r.Quality.Roster["enemy"] || r.Quality.Lead["enemy"] || r.Quality.Actions {
				t.Fatal("opening declared complete")
			}
			encoded := string(domainEncode(t, r))
			if strings.Contains(encoded, "PRIVATE_SENTINEL") || strings.Contains(encoded, "role_uin") || strings.Contains(encoded, `"444"`) {
				t.Fatal("owner leaked")
			}
			if len(state["enemy_team"].([]any)) > 1 && mode != "duplicate owner" {
				t.Fatal("input team slice mutated")
			}
		})
	}
}

func TestBattleNamedBaseFallbackAndConflicts(t *testing.T) {
	for _, kind := range []string{"inside", "common", "missing", "conflict"} {
		r := BattleRecord{}
		common := map[string]any{"conf_id": json.Number("999")}
		inside := map[string]any{"pet_id": json.Number("1"), "conf_id": json.Number("999")}
		switch kind {
		case "inside":
			inside["base_conf_id"] = json.Number("101")
		case "common":
			common["base_conf_id"] = json.Number("102")
			inside["base_conf_id"] = json.Number("101")
		case "conflict":
			common["base_conf_id"] = json.Number("102")
			inside["base_conf_id"] = json.Number("101")
			inside["conf_id"] = json.Number("888")
		}
		p, ok, err := battleNamedPet(map[string]any{"battle_common_pet_info": common, "battle_inside_pet_info": inside}, &r)
		if kind == "conflict" {
			if err == nil {
				t.Fatal("conf_id conflict erased")
			}
			continue
		}
		want := ""
		if kind == "inside" {
			want = "101"
		}
		if kind == "common" {
			want = "102"
		}
		if err != nil || !ok || p.ProtocolBaseID != want || p.MonsterID != 0 {
			t.Fatal(kind, p, err)
		}
	}
}
