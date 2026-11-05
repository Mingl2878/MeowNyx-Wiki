package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
)

const (
	monsterID        = 623
	monsterName      = "超能阿布"
	traitID          = "trait-2d62e65c758af0457fe3fcdc3054ae81"
	traitName        = "圣龙的守护"
	traitDescription = "己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。"
	dataNote         = "用户补充的独立首领形态；图鉴编号、图片、对应普通形态待补。"
)

func approvedMonster() catalog.Monster {
	return catalog.Monster{
		ID: monsterID, Name: monsterName, DexNumber: 0, TypeIDs: []int{8}, TraitID: traitID,
		Stats:  catalog.Stats{HP: 126, PhyAtk: 122, PhyDef: 80, MagAtk: 45, MagDef: 100, Speed: 105},
		Images: catalog.Images{}, Form: "default", FormCategory: "无多形态", EvolutionStage: "首领形态",
		EvolutionMembers: []int{monsterID}, IsLeaderForm: true,
		DefaultLevel: 60, LevelConfigurable: true, LevelMin: 60, LevelMax: 99, LevelStep: 2,
		DataNote: dataNote,
	}
}

func approvedTrait() catalog.Trait {
	return catalog.Trait{ID: traitID, Name: traitName, Description: traitDescription}
}

func approvedLearnset() catalog.Learnset {
	return catalog.Learnset{MonsterID: monsterID, Mode: "own", Skills: []catalog.LearnedSkill{
		{SkillID: 244, Source: "默认"}, {SkillID: 245, Source: "默认"},
	}}
}

// These fixed, all-Chinese target names have no Latin/roman suffix or fullwidth
// ASCII. Their only applicable catalog identity normalization is trimming space
// and removing the same zero-width characters; never strip a form/name suffix.
func targetName(name string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r >= 0x200b && r <= 0x200d || r == 0xfeff {
			return -1
		}
		return r
	}, name))
}

// patch accepts only absent-all -> append three records, or exact existing-all ->
// byte-for-byte no-op. A partial installation or user edit is never repaired or
// overwritten. Validation and all conflict checks precede any mutation.
func patch(raw []byte) ([]byte, []change, error) {
	c, err := catalog.Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	r, err := catalogrecovery.Read(c)
	if err != nil {
		return nil, nil, err
	}
	root, err := jsonObject(raw)
	if err != nil {
		return nil, nil, err
	}
	if root["schema_version"] != json.Number("2") {
		return nil, nil, fmt.Errorf("abudata requires schema_version 2; migrations refused")
	}
	// Same deterministic convention as catalog legacy import: first 16 bytes of
	// SHA256(name + NUL + exact description), not a guessed source identifier.
	sum := sha256.Sum256([]byte(traitName + "\x00" + traitDescription))
	if traitID != "trait-"+hex.EncodeToString(sum[:16]) {
		return nil, nil, fmt.Errorf("trait ID definition mismatch")
	}
	for _, entry := range r.Entries {
		if entry.LocalID == monsterID {
			return nil, nil, fmt.Errorf("local ID 623 is reserved; refused")
		}
	}
	mi, ti, li := -1, -1, -1
	for i, m := range c.Monsters {
		if m.ID == monsterID {
			mi = i
		}
		for _, name := range append([]string{m.Name}, m.Aliases...) {
			if m.ID != monsterID && targetName(name) == monsterName {
				return nil, nil, fmt.Errorf("monster name/alias collision with local ID %d; refused", m.ID)
			}
		}
		if m.ID != monsterID && m.TraitID == traitID {
			return nil, nil, fmt.Errorf("approved trait ID is already shared by monster %d; refused", m.ID)
		}
	}
	for i, tr := range c.Traits {
		if tr.ID == traitID {
			ti = i
		}
		if tr.ID != traitID && targetName(tr.Name) == traitName {
			return nil, nil, fmt.Errorf("same-name trait conflict (%s); refused", tr.ID)
		}
	}
	for i, l := range c.Learnsets {
		if l.MonsterID == monsterID {
			li = i
		}
	}
	if err = checkMasterSkills(c); err != nil {
		return nil, nil, err
	}
	changes := []change{}
	if mi >= 0 || ti >= 0 || li >= 0 {
		if mi < 0 || ti < 0 || li < 0 {
			return nil, nil, fmt.Errorf("partial existing 623/trait/learnset state; refused")
		}
		for _, item := range []struct {
			collection string
			index      int
			expected   any
		}{
			{"monsters", mi, approvedMonster()}, {"traits", ti, approvedTrait()}, {"learnsets", li, approvedLearnset()},
		} {
			want, err := objectValue(item.expected)
			if err != nil {
				return nil, nil, err
			}
			if !reflect.DeepEqual(root[item.collection].([]any)[item.index], want) {
				return nil, nil, fmt.Errorf("conflicting existing %s record for 623; local data preserved", item.collection)
			}
		}
		return bytes.Clone(raw), changes, nil
	}
	c.Monsters = append(c.Monsters, approvedMonster())
	c.Traits = append(c.Traits, approvedTrait())
	c.Learnsets = append(c.Learnsets, approvedLearnset())
	data, err := catalog.Marshal(c)
	if err != nil {
		return nil, nil, err
	}
	if err = validateCatalog(data); err != nil {
		return nil, nil, err
	}
	if err = approvedDiffOnly(raw, data); err != nil {
		return nil, nil, err
	}
	changes = append(changes,
		change{"monsters[id=623]", nil, approvedMonster()},
		change{"traits[id=" + traitID + "]", nil, approvedTrait()},
		change{"learnsets[monster_id=623]", nil, approvedLearnset()},
	)
	return data, changes, nil
}

func checkMasterSkills(c *catalog.Catalog) error {
	dragon := false
	for _, typ := range c.Types {
		if typ.ID == 8 && typ.Code == "Dragon" {
			dragon = true
		}
	}
	if !dragon {
		return fmt.Errorf("requires existing type 8 Code Dragon")
	}
	for _, want := range []struct {
		id          int
		name        string
		power, cost float64
	}{{244, "龙吼", 60, 1}, {245, "龙炮", 100, 3}} {
		found := false
		for _, skill := range c.Skills {
			if skill.ID != want.id {
				continue
			}
			found = true
			if skill.Name != want.name || skill.TypeID != 8 || skill.Category != "Physical Attack" || skill.Power == nil || *skill.Power != want.power || skill.EnergyCost != want.cost {
				return fmt.Errorf("existing master skill %d (%s) conflicts with approved Dragon physical power/cost; refused", want.id, want.name)
			}
		}
		if !found {
			return fmt.Errorf("required existing master skill %d (%s) is missing; no new skills allowed", want.id, want.name)
		}
	}
	return nil
}

func jsonValue(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	err := dec.Decode(&value)
	return value, err
}

func jsonObject(raw []byte) (map[string]any, error) {
	v, err := jsonValue(raw)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("expected JSON object")
	}
	return m, nil
}

func objectValue(v any) (any, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return jsonValue(raw)
}

// Strip exactly the three verified appended records, then compare the entire
// JSON tree using Number (including extensions and >2^53 local values). Even
// automatic schema/extension normalization is outside this command's scope.
func approvedDiffOnly(before, after []byte) error {
	a, err := jsonObject(before)
	if err != nil {
		return err
	}
	b, err := jsonObject(after)
	if err != nil {
		return err
	}
	for _, item := range []struct {
		collection string
		expected   any
	}{
		{"monsters", approvedMonster()}, {"traits", approvedTrait()}, {"learnsets", approvedLearnset()},
	} {
		old, oldOK := a[item.collection].([]any)
		updated, newOK := b[item.collection].([]any)
		if !oldOK || !newOK || len(updated) != len(old)+1 {
			return fmt.Errorf("nonapproved %s length change", item.collection)
		}
		want, err := objectValue(item.expected)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(updated[len(old)], want) {
			return fmt.Errorf("nonapproved appended %s record", item.collection)
		}
		b[item.collection] = updated[:len(old)]
	}
	if !reflect.DeepEqual(a, b) {
		return fmt.Errorf("nonapproved JSON difference (including schema/extension normalization); refused")
	}
	return nil
}
