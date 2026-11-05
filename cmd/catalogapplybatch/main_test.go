package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalogstore"
)

// All catalog/store/profile/assets/database lookalikes are synthetic TempDir
// files. These tests never read the bundled catalog or a real user profile.
func fixture(t *testing.T) map[string]any {
	t.Helper()
	raw := []byte(`{"schema_version":2,"monsters":[{"id":5,"name":"保留猫","dex_number":1,"type_ids":[8],"trait_id":"keep","stats":{"hp":9,"phy_atk":8,"phy_def":7,"mag_atk":6,"mag_def":5,"speed":4},"images":{"avatar":"keep.png","portrait":"keep-full.png"},"form":"default","form_category":"无多形态","evolution_stage":"高级形态","evolution_members":[5],"source_ref":{"provider":"local-test","id":"5","identity":"keep-cat","extensions":{"evidence":{"large":9007199254740993}}},"extensions":{"legacy":{"unrelated":"keep"}}}],"skills":[{"id":244,"name":"龙吼","description":"保留说明","type_id":8,"category":"Physical Attack","energy_cost":1,"power":60},{"id":245,"name":"龙炮","description":"保留说明二","type_id":8,"category":"Physical Attack","energy_cost":3,"power":100}],"types":[{"id":8,"code":"Dragon","name":"龙","vulnerable_to":[],"resistant_to":[]},{"id":15,"code":"Ghost","name":"幽","vulnerable_to":[],"resistant_to":[]}],"traits":[{"id":"keep","name":"保留特性","description":"保留全文"}],"learnsets":[{"monster_id":5,"mode":"own","skills":[{"skill_id":244,"source":"本地"},{"skill_id":245,"source":"传说"}],"extensions":{"local_learning":"keep"}}],"skill_rules":[{"skill_id":244,"power_formula":"preserve-user-rule"}],"extensions":{"catalog_choices":{"version":1,"entries":{"policy":{"choice":"local"}}},"unrelated":{"large":9007199254740993,"nested":[true,null,"keep"]},"monster_identity_reservations":{"version":1,"entries":[]}},"future_preserved_top":{"a":1}}`)
	v, err := decodeJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	c := v.(map[string]any)
	for _, id := range []int{619, 623, 410, 43} {
		row := copyObject(t, c["monsters"].([]any)[0].(map[string]any))
		row["id"] = json.Number(fmt.Sprint(id))
		row["name"] = fmt.Sprintf("测试精灵%d", id)
		row["evolution_members"] = []any{json.Number(fmt.Sprint(id))}
		delete(row, "source_ref")
		learn := map[string]any{"monster_id": json.Number(fmt.Sprint(id)), "mode": "own", "skills": []any{map[string]any{"skill_id": json.Number("244"), "source": "默认"}, map[string]any{"skill_id": json.Number("245"), "source": "默认"}}, "extensions": map[string]any{"preserve": true}}
		if id == 619 {
			row["name"] = "冥古龙"
			row["type_ids"] = []any{json.Number("8"), json.Number("15")}
			row["stats"] = stats(118, 128, 81, 42, 63, 70)
			row["default_level"] = json.Number("99")
			row["level_configurable"] = true
			row["placeholder"] = true
			row["data_note"] = "保留占位说明"
			row["images"] = map[string]any{}
			row["evolution_stage"] = "待定"
			learn["skills"] = []any{}
		}
		if id == 623 {
			row["stats"] = stats(126, 122, 80, 45, 100, 105)
			row["default_level"] = json.Number("60")
			row["level_configurable"] = true
			row["level_min"] = json.Number("60")
			row["level_max"] = json.Number("99")
			row["level_step"] = json.Number("2")
			row["is_leader_form"] = true
		}
		if id == 43 {
			row["is_leader_form"] = true
		}
		c["monsters"] = append(c["monsters"].([]any), row)
		c["learnsets"] = append(c["learnsets"].([]any), learn)
	}
	if err := validateCatalog(encode(t, c)); err != nil {
		t.Fatal(err)
	}
	return c
}
func stats(h, a, d, m, r, s int) map[string]any {
	out := map[string]any{}
	for k, v := range map[string]int{"hp": h, "phy_atk": a, "phy_def": d, "mag_atk": m, "mag_def": r, "speed": s} {
		out[k] = json.Number(fmt.Sprint(v))
	}
	return out
}
func encode(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return append(b, '\n')
}
func copyObject(t *testing.T, v map[string]any) map[string]any {
	t.Helper()
	x, err := decodeJSON(encode(t, v))
	if err != nil {
		t.Fatal(err)
	}
	return x.(map[string]any)
}
func monster(c map[string]any, index int) map[string]any {
	return c["monsters"].([]any)[index].(map[string]any)
}
func learning(c map[string]any, index int) map[string]any {
	return c["learnsets"].([]any)[index].(map[string]any)
}

func reviewed(t *testing.T, c map[string]any) (map[string]any, *manifest) {
	t.Helper()
	next := copyObject(t, c)
	m619 := monster(next, 1)
	m619["placeholder"] = false
	m619["dex_number"] = json.Number("470")
	m619["season"] = "S5"
	m619["trait_id"] = "new-trait"
	m619["images"].(map[string]any)["portrait"] = "assets/versioned/冥古龙-full.png"
	learning(next, 1)["skills"] = []any{map[string]any{"skill_id": json.Number("244"), "source": "默认"}}
	monster(next, 2)["stats"] = stats(126, 105, 122, 45, 80, 100)
	monster(next, 2)["season"] = "S5"
	learning(next, 2)["mode"] = "inherit"
	learning(next, 2)["from_id"] = json.Number("5")
	learning(next, 2)["skills"] = []any{}
	monster(next, 3)["images"].(map[string]any)["portrait"] = "assets/versioned/立方人.png"
	monster(next, 4)["images"].(map[string]any)["avatar"] = "assets/versioned/leader.png"
	newMon := copyObject(t, monster(c, 0))
	newMon["id"] = json.Number("624")
	newMon["name"] = "手工新增名Ⅱ_保留"
	newMon["evolution_members"] = []any{json.Number("624")}
	delete(newMon, "source_ref")
	newMon["season"] = "S5"
	next["monsters"] = append(next["monsters"].([]any), newMon)
	next["skills"] = append(next["skills"].([]any), map[string]any{"id": json.Number("5963"), "name": "手工新增技能", "description": "只保留提供的说明", "type_id": json.Number("8"), "category": "Physical Attack", "energy_cost": json.Number("1"), "power": json.Number("60"), "season": "S5"})
	next["traits"] = append(next["traits"].([]any), map[string]any{"id": "new-trait", "name": "手工新增特性", "description": "只保留提供的原文"})
	next["learnsets"] = append(next["learnsets"].([]any), map[string]any{"monster_id": json.Number("624"), "mode": "inherit", "from_id": json.Number("5"), "skills": []any{}})
	next["skill_rules"] = append(next["skill_rules"].([]any), map[string]any{"skill_id": json.Number("5963"), "base_combo": json.Number("2")})
	m := &manifest{Version: 1, BaselineSHA256: catalogstore.Hash(encode(t, c)), CandidateSHA256: catalogstore.Hash(encode(t, next)), Changes: rawDiff(c, next), NewMonsterIDs: []int{624}, NewSkillIDs: []int{5963}, NewTraitIDs: []string{"new-trait"}, LeaderAvatarIDs: []int{43}}
	return next, m
}

// Independent manifest-author algorithm with documented collection-index append
// semantics. No production verification function constructs test author plans.
func rawDiff(a, b map[string]any) []string {
	out := []string{}
	ax, bx := cloneMap(a), cloneMap(b)
	for _, key := range []string{"monsters", "skills", "traits", "learnsets", "skill_rules"} {
		aa, _ := a[key].([]any)
		bb, _ := b[key].([]any)
		for i := 0; i < len(aa) && i < len(bb); i++ {
			diffObject(aa[i].(map[string]any), bb[i].(map[string]any), fmt.Sprintf("/%s/%d", key, i), &out)
		}
		for i := len(aa); i < len(bb); i++ {
			out = append(out, fmt.Sprintf("/%s/%d", key, i))
		}
		delete(ax, key)
		delete(bx, key)
	}
	diffObject(ax, bx, "", &out)
	return out
}
func put(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func get(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func tree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if e.IsDir() {
			result[rel] = "dir"
		} else {
			result[rel] = catalogstore.Hash(get(t, path))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func setup(t *testing.T) (string, []string, []byte, []byte) {
	t.Helper()
	root := t.TempDir()
	c := fixture(t)
	next, m := reviewed(t, c)
	old, candidate := encode(t, c), encode(t, next)
	storeRoot := filepath.Join(root, "store")
	versions := filepath.Join(storeRoot, "versions")
	put(t, filepath.Join(versions, catalogstore.Hash(old)+".json"), old)
	put(t, filepath.Join(storeRoot, "current.json"), []byte(`{"version":1,"revision":"`+catalogstore.Hash(old)+`","updated_at":"test"}`))
	input := filepath.Join(root, "inputs")
	put(t, filepath.Join(input, "candidate.json"), candidate)
	put(t, filepath.Join(input, "manifest.json"), encode(t, m))
	put(t, filepath.Join(input, "baseline.json"), old)
	put(t, filepath.Join(root, "personal", "battle-records.sqlite"), []byte("not a database; untouched"))
	put(t, filepath.Join(storeRoot, "images", "untouched.webp"), []byte("not an image; untouched"))
	put(t, filepath.Join(root, "personal", "user-config.json"), []byte("untouched settings"))
	args := []string{"-storeRoot", storeRoot, "-candidate", filepath.Join(input, "candidate.json"), "-expectedRevision", catalogstore.Hash(old), "-backupDir", filepath.Join(root, "backup"), "-manifest", filepath.Join(input, "manifest.json")}
	return root, args, old, candidate
}
func clearDeps() dependencies {
	return dependencies{replace: catalogstore.ReplaceFile, appClosed: func() error { return nil }}
}

func TestAuditNoWritesAndExactApply(t *testing.T) {
	root, args, old, candidate := setup(t)
	before := tree(t, root)
	var report bytes.Buffer
	deps := clearDeps()
	deps.appClosed = func() error { t.Fatal("audit queried processes"); return nil }
	if err := runWithDependencies(args, &report, deps); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("audit wrote files/directories")
	}
	if !strings.Contains(report.String(), `"mode":"audit"`) || !strings.Contains(report.String(), `"committed_revision":""`) {
		t.Fatal(report.String())
	}
	report.Reset()
	apply := append(append([]string{}, args...), "-apply", "-appClosed")
	if err := runWithDependencies(apply, &report, clearDeps()); err != nil {
		t.Fatal(err)
	}
	storeRoot := args[1]
	if !bytes.Equal(get(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(candidate)+".json")), candidate) {
		t.Fatal("candidate bytes rewritten")
	}
	if !bytes.Equal(get(t, filepath.Join(root, "backup", catalogstore.Hash(old)+".json")), old) {
		t.Fatal("backup not original")
	}
	if !bytes.Equal(get(t, args[3]), candidate) {
		t.Fatal("input rewritten")
	}
	if !bytes.Contains(candidate, []byte("手工新增名Ⅱ_保留")) {
		t.Fatal("fixture lost exact authored name")
	}
	for _, path := range []string{filepath.Join(root, "personal", "battle-records.sqlite"), filepath.Join(root, "personal", "user-config.json"), filepath.Join(storeRoot, "images", "untouched.webp")} {
		rel, _ := filepath.Rel(root, path)
		if catalogstore.Hash(get(t, path)) != before[rel] {
			t.Fatal("unrelated file changed")
		}
	}
	if err := runWithDependencies(apply, io.Discard, clearDeps()); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale apply accepted", err)
	}
}

func TestProtectionAgainstReviewedButOutOfScopeDiff(t *testing.T) {
	cases := map[string]func(map[string]any, *manifest){
		"old skill": func(c map[string]any, m *manifest) {
			c["skills"].([]any)[0].(map[string]any)["power"] = json.Number("61")
		},
		"old trait": func(c map[string]any, m *manifest) {
			c["traits"].([]any)[0].(map[string]any)["description"] = "changed"
		},
		"old rule": func(c map[string]any, m *manifest) {
			c["skill_rules"].([]any)[0].(map[string]any)["power_formula"] = "changed"
		},
		"types":             func(c map[string]any, m *manifest) { c["types"].([]any)[0].(map[string]any)["name"] = "changed" },
		"global extension":  func(c map[string]any, m *manifest) { c["extensions"].(map[string]any)["unrelated"] = nil },
		"unknown top field": func(c map[string]any, m *manifest) { delete(c, "future_preserved_top") },
		"source extension": func(c map[string]any, m *manifest) {
			monster(c, 0)["source_ref"].(map[string]any)["extensions"] = map[string]any{}
		},
		"level":            func(c map[string]any, m *manifest) { monster(c, 2)["level_step"] = json.Number("1") },
		"ordinary monster": func(c map[string]any, m *manifest) { monster(c, 0)["dex_number"] = json.Number("2") },
		"410 stats":        func(c map[string]any, m *manifest) { monster(c, 3)["stats"].(map[string]any)["hp"] = json.Number("10") },
		"leader portrait": func(c map[string]any, m *manifest) {
			monster(c, 4)["images"].(map[string]any)["portrait"] = "forbidden.png"
		},
		"old other learnset":           func(c map[string]any, m *manifest) { learning(c, 0)["skills"] = []any{} },
		"619 clear learning":           func(c map[string]any, m *manifest) { learning(c, 1)["skills"] = []any{} },
		"623 clear effective learning": func(c map[string]any, m *manifest) { learning(c, 2)["mode"] = "own"; delete(learning(c, 2), "from_id") },
		"mixed623 stats": func(c map[string]any, m *manifest) {
			monster(c, 2)["stats"].(map[string]any)["speed"] = json.Number("101")
		},
		"619 reversedtypes": func(c map[string]any, m *manifest) {
			monster(c, 1)["type_ids"] = []any{json.Number("15"), json.Number("8")}
		},
		"new monster IDcollision": func(c map[string]any, m *manifest) { monster(c, 5)["id"] = json.Number("5") },
		"new monster undeclared":  func(c map[string]any, m *manifest) { m.NewMonsterIDs = []int{625} },
		"new skill undeclared":    func(c map[string]any, m *manifest) { m.NewSkillIDs = []int{5964} },
		"new trait undeclared":    func(c map[string]any, m *manifest) { m.NewTraitIDs = []string{} },
		"new unknown field":       func(c map[string]any, m *manifest) { monster(c, 5)["weight"] = json.Number("12") },
		"new rule formula": func(c map[string]any, m *manifest) {
			c["skill_rules"].([]any)[1].(map[string]any)["power_formula"] = "inferred"
		},
		"new rule combo4": func(c map[string]any, m *manifest) {
			c["skill_rules"].([]any)[1].(map[string]any)["base_combo"] = json.Number("4")
		},
		"nonleader avatar ID": func(c map[string]any, m *manifest) { m.LeaderAvatarIDs = []int{5, 43} },
		"deletion":            func(c map[string]any, m *manifest) { c["monsters"] = c["monsters"].([]any)[1:] },
		"reorder": func(c map[string]any, m *manifest) {
			rows := c["monsters"].([]any)
			rows[0], rows[3] = rows[3], rows[0]
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			base := fixture(t)
			next, m := reviewed(t, base)
			change(next, m)
			m.Changes = rawDiff(base, next)
			if _, err := verifyCandidate(encode(t, base), encode(t, next), m); err == nil {
				t.Fatal("accepted even with authored exact whitelist")
			}
		})
	}
}

func TestBadManifestsDataTypesAndBoundedFilesNoWrites(t *testing.T) {
	for _, mode := range []string{"missing flag", "relative candidate", "relative manifest", "missingappClosed", "running", "probe error", "manifest hash", "candidate hash", "duplicate pointer", "coarse pointer", "extra pointer", "missing diff pointer", "future manifest", "unknown manifest field", "duplicate manifest key", "trailing manifest", "null IDs", "too many IDs", "candidate bad type", "candidate duplicate key", "candidate oversized", "manifest oversized", "internal backup", "missing pointer", "recovery pointer", "stale", "bad object"} {
		t.Run(mode, func(t *testing.T) {
			root, args, _, _ := setup(t)
			deps := clearDeps()
			mutateManifest := func(f func(map[string]any)) {
				v, e := decodeJSON(get(t, args[9]))
				if e != nil {
					t.Fatal(e)
				}
				m := v.(map[string]any)
				f(m)
				put(t, args[9], encode(t, m))
			}
			switch mode {
			case "missing flag":
				args = nil
			case "relative candidate":
				args[3] = "candidate.json"
			case "relative manifest":
				args[9] = "manifest.json"
			case "missingappClosed":
				args = append(args, "-apply")
			case "running":
				args = append(args, "-apply", "-appClosed")
				deps.appClosed = func() error { return errors.New("app running") }
			case "probe error":
				args = append(args, "-apply", "-appClosed")
				deps.appClosed = func() error { return errors.New("probe failed") }
			case "manifest hash":
				mutateManifest(func(m map[string]any) { m["baseline_sha256"] = strings.Repeat("0", 64) })
			case "candidate hash":
				put(t, args[3], append(get(t, args[3]), ' '))
			case "duplicate pointer":
				mutateManifest(func(m map[string]any) { m["changes"] = append(m["changes"].([]any), m["changes"].([]any)[0]) })
			case "coarse pointer":
				mutateManifest(func(m map[string]any) { m["changes"] = []any{"/monsters"} })
			case "extra pointer":
				mutateManifest(func(m map[string]any) { m["changes"] = append(m["changes"].([]any), "/monsters/0/name") })
			case "missing diff pointer":
				mutateManifest(func(m map[string]any) { m["changes"] = m["changes"].([]any)[1:] })
			case "future manifest":
				mutateManifest(func(m map[string]any) { m["version"] = json.Number("2") })
			case "unknown manifest field":
				mutateManifest(func(m map[string]any) { m["allow_all"] = true })
			case "duplicate manifest key":
				put(t, args[9], bytes.Replace(get(t, args[9]), []byte(`"version": 1`), []byte(`"version":1,"version":1`), 1))
			case "trailing manifest":
				put(t, args[9], append(get(t, args[9]), []byte(`{}`)...))
			case "null IDs":
				mutateManifest(func(m map[string]any) { m["new_skill_ids"] = nil })
			case "too many IDs":
				mutateManifest(func(m map[string]any) {
					ids := []any{}
					for i := 0; i < 30; i++ {
						ids = append(ids, json.Number(fmt.Sprint(5963+i)))
					}
					m["new_skill_ids"] = ids
				})
			case "candidate bad type":
				put(t, args[3], bytes.Replace(get(t, args[3]), []byte(`"dex_number": 1`), []byte(`"dex_number": "1"`), 1))
			case "candidate duplicate key":
				put(t, args[3], bytes.Replace(get(t, args[3]), []byte(`"schema_version": 2`), []byte(`"schema_version":2,"schema_version":2`), 1))
			case "candidate oversized":
				put(t, args[3], bytes.Repeat([]byte(" "), catalogstore.MaxCatalogBytes+1))
			case "manifest oversized":
				put(t, args[9], bytes.Repeat([]byte(" "), maxManifestBytes+1))
			case "internal backup":
				args[7] = filepath.Join(args[1], "backup")
			case "missing pointer": // remove only this explicitly verified TempDir fixture
				path := filepath.Join(root, "store", "current.json")
				if !sameOrWithin(root, path) {
					t.Fatal("unsafe test path")
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "recovery pointer":
				put(t, filepath.Join(args[1], "previous.json"), get(t, filepath.Join(args[1], "current.json")))
				put(t, filepath.Join(args[1], "current.json"), []byte(`{"version":1,"revision":"bad"}`))
			case "stale":
				args[5] = strings.Repeat("0", 64)
			case "bad object":
				put(t, filepath.Join(args[1], "versions", args[5]+".json"), []byte("corrupt"))
			}
			before := tree(t, root)
			var report bytes.Buffer
			if err := runWithDependencies(args, &report, deps); err == nil {
				t.Fatal("accepted unsafe input")
			}
			if report.Len() != 0 {
				t.Fatal("reported success after refusal")
			}
			if !reflect.DeepEqual(before, tree(t, root)) {
				t.Fatal("refusal wrote files")
			}
		})
	}
}

func TestLateCASAndAtomicReplaceFailurePreservePointer(t *testing.T) {
	for _, mode := range []string{"before commit", "during staging", "previous replacement", "current replacement", "backup failure"} {
		t.Run(mode, func(t *testing.T) {
			root, args, old, _ := setup(t)
			args = append(args, "-apply", "-appClosed")
			pointer := filepath.Join(args[1], "current.json")
			original := get(t, pointer)
			expected := original
			deps := clearDeps()
			sentinel := errors.New("replace failed")
			switch mode {
			case "before commit":
				expected = append(bytes.Clone(original), ' ')
				deps.beforeCommit = func() error { put(t, pointer, expected); return nil }
			case "during staging":
				expected = append(bytes.Clone(original), ' ')
				deps.replace = func(from, to string) error {
					if filepath.Base(to) == "previous.json" {
						put(t, pointer, expected)
					}
					return catalogstore.ReplaceFile(from, to)
				}
			case "previous replacement", "current replacement":
				target := "previous.json"
				if mode == "current replacement" {
					target = "current.json"
				}
				deps.replace = func(from, to string) error {
					if filepath.Base(to) == target {
						return sentinel
					}
					return catalogstore.ReplaceFile(from, to)
				}
			case "backup failure":
				put(t, filepath.Join(root, "backup"), []byte("blocked"))
			}
			var report bytes.Buffer
			err := runWithDependencies(args, &report, deps)
			if err == nil || report.Len() != 0 {
				t.Fatal("failure reported success", err)
			}
			if !bytes.Equal(get(t, pointer), expected) {
				t.Fatal("failed commit overwrote active pointer")
			}
			if !bytes.Equal(get(t, filepath.Join(args[1], "versions", catalogstore.Hash(old)+".json")), old) {
				t.Fatal("old immutable object changed")
			}
			if mode == "before commit" || mode == "during staging" {
				if !errors.Is(err, catalogstore.ErrConflict) {
					t.Fatal("not exact CAS error", err)
				}
			}
		})
	}
}

func TestExplicitBaselineAndExactNoop(t *testing.T) {
	root, args, old, _ := setup(t)
	if err := runWithDependencies(append(append([]string{}, args...), "-baseline", filepath.Join(root, "inputs", "baseline.json")), io.Discard, clearDeps()); err != nil {
		t.Fatal(err)
	}
	m := manifest{Version: 1, BaselineSHA256: catalogstore.Hash(old), CandidateSHA256: catalogstore.Hash(old), Changes: []string{}, NewMonsterIDs: []int{}, NewSkillIDs: []int{}, NewTraitIDs: []string{}, LeaderAvatarIDs: []int{}}
	put(t, args[3], old)
	put(t, args[9], encode(t, m))
	before := tree(t, root)
	if err := runWithDependencies(append(args, "-apply", "-appClosed"), io.Discard, clearDeps()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("exact noop wrote files")
	}
}

func TestGoldenExactDiffContract(t *testing.T) {
	base := fixture(t)
	next, m := reviewed(t, base)
	expected := []string{
		"/monsters/1/placeholder", "/monsters/1/dex_number", "/monsters/1/season", "/monsters/1/trait_id", "/monsters/1/images/portrait",
		"/learnsets/1/skills", "/monsters/2/stats/phy_atk", "/monsters/2/stats/phy_def", "/monsters/2/stats/mag_def", "/monsters/2/stats/speed", "/monsters/2/season",
		"/learnsets/2/mode", "/learnsets/2/from_id", "/learnsets/2/skills", "/monsters/3/images/portrait", "/monsters/4/images/avatar",
		"/monsters/5", "/skills/2", "/traits/1", "/learnsets/5", "/skill_rules/1",
	}
	m.Changes = expected
	actual, err := verifyCandidate(encode(t, base), encode(t, next), m)
	if err != nil || !sameStrings(actual, expected) {
		t.Fatal("diff contract mismatch", actual, err)
	}
	// Exponents are compared without expanding them into enormous integers.
	if !semanticEqual(json.Number("1e999999999999999999"), json.Number("10e999999999999999998")) {
		t.Fatal("large exponent normalization failed")
	}
}

func TestApprovedSourceExtensionsAndBackupAliasesProtected(t *testing.T) {
	base := fixture(t)
	monster(base, 1)["source_ref"] = copyObject(t, monster(base, 0)["source_ref"].(map[string]any))
	next, m := reviewed(t, base)
	delete(monster(next, 1), "source_ref")
	m.Changes = rawDiff(base, next)
	if _, err := verifyCandidate(encode(t, base), encode(t, next), m); err == nil {
		t.Fatal("removed approved monster source extension through whole-object pointer")
	}
	root, args, old, _ := setup(t)
	backupFile := filepath.Join(root, "backup", catalogstore.Hash(old)+".json")
	if err := os.MkdirAll(filepath.Dir(backupFile), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(args[1], "versions", catalogstore.Hash(old)+".json"), backupFile); err != nil {
		t.Skipf("hard link unavailable: %v", err)
	}
	before := tree(t, root)
	if err := runWithDependencies(append(args, "-apply", "-appClosed"), io.Discard, clearDeps()); err == nil {
		t.Fatal("accepted backup alias")
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("backup alias refusal wrote files")
	}
}

func metadata619Fixture(t *testing.T, omissions []any) (map[string]any, map[string]any, *manifest) {
	t.Helper()
	base := fixture(t)
	ext := learning(base, 1)["extensions"].(map[string]any)
	ext["legacy"] = map[string]any{"data_status": "placeholder", "data_note": "preserve unknown local note", "evidence": map[string]any{"version": json.Number("7"), "unknown": []any{true, "keep"}}}
	ext["legacy_omit"] = omissions
	next, m := reviewed(t, base)
	cleanup := learning(next, 1)["extensions"].(map[string]any)
	delete(cleanup["legacy"].(map[string]any), "data_status")
	filtered := []any{}
	for _, v := range omissions {
		if v != "image" {
			filtered = append(filtered, v)
		}
	}
	cleanup["legacy_omit"] = filtered
	m.Changes = rawDiff(base, next)
	m.CandidateSHA256 = catalogstore.Hash(encode(t, next))
	return base, next, m
}

func Test619MetadataCleanupOnlyExactObsoleteDeclarations(t *testing.T) {
	for _, mode := range []string{"retain other omission order", "keep empty array", "delete empty omit key"} {
		t.Run(mode, func(t *testing.T) {
			omits := []any{"before", "image", "after"}
			if mode != "retain other omission order" {
				omits = []any{"image"}
			}
			base, next, m := metadata619Fixture(t, omits)
			if mode == "delete empty omit key" {
				delete(learning(next, 1)["extensions"].(map[string]any), "legacy_omit")
				m.Changes = rawDiff(base, next)
				m.CandidateSHA256 = catalogstore.Hash(encode(t, next))
			}
			if err := validateCatalog(encode(t, next)); err != nil {
				t.Fatal(err)
			}
			if _, err := verifyCandidate(encode(t, base), encode(t, next), m); err != nil {
				t.Fatal(err)
			}
			// Exercise the full read-only CLI using only this TempDir's synthetic store.
			root, args, _, _ := setup(t)
			raw := encode(t, base)
			revision := catalogstore.Hash(raw)
			args[5] = revision
			put(t, filepath.Join(args[1], "versions", revision+".json"), raw)
			put(t, filepath.Join(args[1], "current.json"), []byte(`{"version":1,"revision":"`+revision+`","updated_at":"test"}`))
			put(t, args[3], encode(t, next))
			put(t, args[9], encode(t, m))
			before := tree(t, root)
			if err := runWithDependencies(args, io.Discard, clearDeps()); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, tree(t, root)) {
				t.Fatal("metadata audit wrote files")
			}
		})
	}
	cases := map[string]func(map[string]any, map[string]any){
		"normal status substitution": func(a, b map[string]any) {
			learning(b, 1)["extensions"].(map[string]any)["legacy"].(map[string]any)["data_status"] = "normal"
		},
		"null status": func(a, b map[string]any) {
			learning(b, 1)["extensions"].(map[string]any)["legacy"].(map[string]any)["data_status"] = nil
		},
		"remove nonplaceholder status": func(a, b map[string]any) {
			learning(a, 1)["extensions"].(map[string]any)["legacy"].(map[string]any)["data_status"] = "user-status"
		},
		"remove note": func(a, b map[string]any) {
			delete(learning(b, 1)["extensions"].(map[string]any)["legacy"].(map[string]any), "data_note")
		},
		"change evidence": func(a, b map[string]any) {
			learning(b, 1)["extensions"].(map[string]any)["legacy"].(map[string]any)["evidence"] = nil
		},
		"delete whole legacy":     func(a, b map[string]any) { delete(learning(b, 1)["extensions"].(map[string]any), "legacy") },
		"delete whole extensions": func(a, b map[string]any) { delete(learning(b, 1), "extensions") },
		"remove additional omission": func(a, b map[string]any) {
			learning(b, 1)["extensions"].(map[string]any)["legacy_omit"] = []any{"before"}
		},
		"reorder other omissions": func(a, b map[string]any) {
			learning(b, 1)["extensions"].(map[string]any)["legacy_omit"] = []any{"after", "before"}
		},
		"add omission": func(a, b map[string]any) {
			learning(b, 1)["extensions"].(map[string]any)["legacy_omit"] = []any{"before", "after", "extra"}
		},
		"delete nonempty omit key": func(a, b map[string]any) { delete(learning(b, 1)["extensions"].(map[string]any), "legacy_omit") },
		"no exact image declaration": func(a, b map[string]any) {
			learning(a, 1)["extensions"].(map[string]any)["legacy_omit"] = []any{"before", " image ", "after"}
		},
		"still placeholder": func(a, b map[string]any) { monster(b, 1)["placeholder"] = true },
		"missing portrait":  func(a, b map[string]any) { delete(monster(b, 1)["images"].(map[string]any), "portrait") },
		"empty learning":    func(a, b map[string]any) { learning(b, 1)["skills"] = []any{} },
		"623 status cleanup": func(a, b map[string]any) {
			learning(a, 2)["extensions"].(map[string]any)["legacy"] = map[string]any{"data_status": "placeholder"}
		},
	}
	for mode, change := range cases {
		t.Run(mode, func(t *testing.T) {
			base, next, m := metadata619Fixture(t, []any{"before", "image", "after"})
			change(base, next)
			m.Changes = rawDiff(base, next)
			if _, err := verifyCandidate(encode(t, base), encode(t, next), m); err == nil {
				t.Fatal("broader metadata exception accepted")
			}
		})
	}
}

func metadata410Fixture(t *testing.T, omissions []any) (map[string]any, map[string]any, *manifest) {
	t.Helper()
	base := fixture(t)
	ext := monster(base, 3)["extensions"].(map[string]any)
	ext["legacy_omit"] = omissions
	ext["unknown_metadata"] = map[string]any{"version": json.Number("42"), "order": []any{"a", "b"}}
	next, m := reviewed(t, base)
	monster(next, 3)["images"].(map[string]any)["avatar"] = "assets/versioned/立方人-new-avatar.webp"
	filtered := []any{}
	for _, v := range omissions {
		if v != "image" {
			filtered = append(filtered, v)
		}
	}
	monster(next, 3)["extensions"].(map[string]any)["legacy_omit"] = filtered
	m.Changes = rawDiff(base, next)
	m.CandidateSHA256 = catalogstore.Hash(encode(t, next))
	return base, next, m
}
func Test410ImageOmitCleanupDoesNotBroadenMetadataScope(t *testing.T) {
	for _, mode := range []string{"other omissions retained", "empty array retained", "empty key removed"} {
		t.Run(mode, func(t *testing.T) {
			omits := []any{"before", "image", "after"}
			if mode != "other omissions retained" {
				omits = []any{"image"}
			}
			base, next, m := metadata410Fixture(t, omits)
			if mode == "empty key removed" {
				delete(monster(next, 3)["extensions"].(map[string]any), "legacy_omit")
				m.Changes = rawDiff(base, next)
			}
			if err := validateCatalog(encode(t, next)); err != nil {
				t.Fatal(err)
			}
			if _, err := verifyCandidate(encode(t, base), encode(t, next), m); err != nil {
				t.Fatal(err)
			}
		})
	}
	cases := map[string]func(map[string]any, map[string]any){
		"remove other omission": func(a, b map[string]any) {
			monster(b, 3)["extensions"].(map[string]any)["legacy_omit"] = []any{"after"}
		},
		"reorder remaining": func(a, b map[string]any) {
			monster(b, 3)["extensions"].(map[string]any)["legacy_omit"] = []any{"after", "before"}
		},
		"add omission": func(a, b map[string]any) {
			monster(b, 3)["extensions"].(map[string]any)["legacy_omit"] = []any{"before", "after", "extra"}
		},
		"delete nonempty omit key": func(a, b map[string]any) { delete(monster(b, 3)["extensions"].(map[string]any), "legacy_omit") },
		"whitespace image": func(a, b map[string]any) {
			monster(a, 3)["extensions"].(map[string]any)["legacy_omit"] = []any{"before", " image ", "after"}
		},
		"remove all extensions":   func(a, b map[string]any) { delete(monster(b, 3), "extensions") },
		"remove other legacy":     func(a, b map[string]any) { delete(monster(b, 3)["extensions"].(map[string]any), "legacy") },
		"change unknown metadata": func(a, b map[string]any) { monster(b, 3)["extensions"].(map[string]any)["unknown_metadata"] = nil },
		"no avatar":               func(a, b map[string]any) { delete(monster(b, 3)["images"].(map[string]any), "avatar") },
		"410 learnset omission": func(a, b map[string]any) {
			learning(a, 3)["extensions"].(map[string]any)["legacy_omit"] = []any{"image"}
		},
		"623 monster omission": func(a, b map[string]any) {
			monster(a, 2)["extensions"].(map[string]any)["legacy_omit"] = []any{"image"}
		},
	}
	for mode, change := range cases {
		t.Run(mode, func(t *testing.T) {
			base, next, m := metadata410Fixture(t, []any{"before", "image", "after"})
			change(base, next)
			m.Changes = rawDiff(base, next)
			if _, err := verifyCandidate(encode(t, base), encode(t, next), m); err == nil {
				t.Fatal("broader410metadata exception accepted")
			}
		})
	}
}

// Include metadata and link targets so create/remove attempts cannot pass an
// audit/reuse freeze by merely restoring file content hashes. All paths are
// synthetic descendants of a test's TempDir; no permission changes are made.
func frozenTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		// Windows directory enumeration can return stale directory timestamps;
		// query each path itself instead of trusting the DirEntry cache.
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		state := fmt.Sprintf("%s:%d:%d", info.Mode(), info.Size(), info.ModTime().UnixNano())
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			state += ":link:" + target
		} else if info.Mode().IsRegular() {
			state += ":" + catalogstore.Hash(get(t, path))
		}
		out[rel] = state
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func existingBackupFixture(t *testing.T, root string, old []byte, nested bool) string {
	t.Helper()
	path := filepath.Join(root, "backup", "active-catalog.json")
	if nested {
		path = filepath.Join(root, "backup", "fresh", "active-catalog.json")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	// Request read-only at creation, not by modifying any file's permissions.
	if err := os.WriteFile(path, old, 0400); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExistingBackupReadOnlyAuditAndExactApply(t *testing.T) {
	for _, nested := range []bool{false, true} {
		t.Run(fmt.Sprintf("nested=%t", nested), func(t *testing.T) {
			root, args, old, candidate := setup(t)
			backupFile := existingBackupFixture(t, root, old, nested)
			put(t, filepath.Join(root, "backup", "unrelated-snapshot.json"), []byte("untouched older snapshot"))
			args = append(args, "-existingBackupFile", backupFile)
			before := frozenTree(t, root)
			backupBefore := frozenTree(t, filepath.Join(root, "backup"))
			infoBefore, err := os.Stat(backupFile)
			if err != nil {
				t.Fatal(err)
			}
			var report bytes.Buffer
			deps := clearDeps()
			deps.appClosed = func() error { t.Fatal("audit queried processes"); return nil }
			deps.replace = func(string, string) error { t.Fatal("audit attempted replacement"); return nil }
			if err := runWithDependencies(args, &report, deps); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, frozenTree(t, root)) {
				t.Fatal("existing-backup audit wrote files/directories or metadata")
			}
			if !strings.Contains(report.String(), `"existing_backup_verified":true`) || !strings.Contains(report.String(), `"mode":"audit"`) || strings.Contains(report.String(), backupFile) || strings.Contains(report.String(), root) {
				t.Fatal("audit did not verify backup, or exposed private path", report.String())
			}
			report.Reset()
			deps = clearDeps()
			closedCalls := 0
			deps.appClosed = func() error { closedCalls++; return nil }
			deps.replace = func(from, to string) error {
				if sameOrWithin(filepath.Join(root, "backup"), from) || sameOrWithin(filepath.Join(root, "backup"), to) {
					t.Fatal("reuse attempted backup replacement")
				}
				return catalogstore.ReplaceFile(from, to)
			}
			if err := runWithDependencies(append(append([]string{}, args...), "-apply", "-appClosed"), &report, deps); err != nil {
				t.Fatal(err)
			}
			if closedCalls != 1 || !strings.Contains(report.String(), `"existing_backup_verified":true`) || !strings.Contains(report.String(), `"committed_revision":"`+catalogstore.Hash(candidate)+`"`) || strings.Contains(report.String(), root) {
				t.Fatal("apply omitted closed verification or valid report", report.String())
			}
			if !reflect.DeepEqual(backupBefore, frozenTree(t, filepath.Join(root, "backup"))) {
				t.Fatal("reuse created/modified backups or backup metadata")
			}
			infoAfter, err := os.Stat(backupFile)
			if err != nil || !os.SameFile(infoBefore, infoAfter) {
				t.Fatal("reuse replaced backup identity", err)
			}
			if !bytes.Equal(get(t, filepath.Join(args[1], "versions", catalogstore.Hash(candidate)+".json")), candidate) || !bytes.Equal(get(t, args[3]), candidate) || !bytes.Equal(get(t, backupFile), old) {
				t.Fatal("reuse normalized/replaced candidate or baseline data")
			}
			if _, err := os.Lstat(filepath.Join(root, "backup", catalogstore.Hash(old)+".json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("reuse created default backup", err)
			}
			var pointer struct {
				Version   int    `json:"version"`
				Revision  string `json:"revision"`
				UpdatedAt string `json:"updated_at"`
			}
			if err := decodeStrict(get(t, filepath.Join(args[1], "current.json")), &pointer); err != nil || pointer.Revision != catalogstore.Hash(candidate) {
				t.Fatal("reuse did not switch active pointer", pointer, err)
			}
			if err := decodeStrict(get(t, filepath.Join(args[1], "previous.json")), &pointer); err != nil || pointer.Revision != catalogstore.Hash(old) {
				t.Fatal("reuse did not retain previous pointer", pointer, err)
			}
		})
	}
}

func TestExistingBackupInvalidReadOnlyAuditAndApplyNoWrites(t *testing.T) {
	for _, apply := range []bool{false, true} {
		for _, mode := range []string{"missing", "relative", "outside backup", "sibling prefix escape", "backup root", "inside store", "directory", "empty", "oversized", "invalid JSON", "wrong exact-size hash", "same JSON different bytes", "active alias", "candidate alias", "manifest alias", "baseline alias", "current pointer alias", "previous pointer alias", "file symlink", "directory symlink"} {
			t.Run(fmt.Sprintf("apply=%t/%s", apply, mode), func(t *testing.T) {
				root, args, old, _ := setup(t)
				backupFile := filepath.Join(root, "backup", "active-catalog.json")
				if err := os.MkdirAll(filepath.Dir(backupFile), 0700); err != nil {
					t.Fatal(err)
				}
				link := func(source, target string, symbolic bool) {
					var err error
					if symbolic {
						err = os.Symlink(source, target)
					} else {
						err = os.Link(source, target)
					}
					if err != nil {
						t.Skipf("isolated link fixture unavailable: %v", err)
					}
				}
				active := filepath.Join(args[1], "versions", catalogstore.Hash(old)+".json")
				switch mode {
				case "missing":
				case "relative":
					backupFile = "active-catalog.json"
				case "outside backup":
					backupFile = filepath.Join(root, "outside", "active-catalog.json")
					put(t, backupFile, old)
				case "sibling prefix escape":
					backupFile = filepath.Join(root, "backup-sibling", "active-catalog.json")
					put(t, backupFile, old)
				case "backup root":
					backupFile = filepath.Join(root, "backup")
				case "inside store":
					backupFile = active
				case "directory":
					if err := os.Mkdir(backupFile, 0700); err != nil {
						t.Fatal(err)
					}
				case "empty":
					put(t, backupFile, nil)
				case "oversized":
					put(t, backupFile, bytes.Repeat([]byte(" "), catalogstore.MaxCatalogBytes+1))
				case "invalid JSON":
					put(t, backupFile, bytes.Repeat([]byte("x"), len(old)))
				case "wrong exact-size hash":
					put(t, backupFile, bytes.Replace(old, []byte("保留猫"), []byte("修改猫"), 1))
				case "same JSON different bytes":
					var compact bytes.Buffer
					if err := json.Compact(&compact, old); err != nil {
						t.Fatal(err)
					}
					put(t, backupFile, compact.Bytes())
				case "active alias":
					link(active, backupFile, false)
				case "candidate alias":
					link(args[3], backupFile, false)
				case "manifest alias":
					link(args[9], backupFile, false)
				case "baseline alias":
					baseline := filepath.Join(root, "inputs", "baseline.json")
					args = append(args, "-baseline", baseline)
					link(baseline, backupFile, false)
				case "current pointer alias":
					link(filepath.Join(args[1], "current.json"), backupFile, false)
				case "previous pointer alias":
					previous := filepath.Join(args[1], "previous.json")
					put(t, previous, get(t, filepath.Join(args[1], "current.json")))
					link(previous, backupFile, false)
				case "file symlink":
					independent := filepath.Join(root, "backup", "independent.json")
					put(t, independent, old)
					link(independent, backupFile, true)
				case "directory symlink":
					independent := filepath.Join(root, "backup", "independent")
					put(t, filepath.Join(independent, "active-catalog.json"), old)
					dirlink := filepath.Join(root, "backup", "linked-dir")
					link(independent, dirlink, true)
					backupFile = filepath.Join(dirlink, "active-catalog.json")
				}
				args = append(args, "-existingBackupFile", backupFile)
				if apply {
					args = append(args, "-apply", "-appClosed")
				}
				pointer := get(t, filepath.Join(root, "store", "current.json"))
				before := frozenTree(t, root)
				deps := clearDeps()
				deps.appClosed = func() error { t.Fatal("invalid backup reached process check"); return nil }
				deps.replace = func(string, string) error { t.Fatal("invalid backup reached replacement"); return nil }
				var report bytes.Buffer
				if err := runWithDependencies(args, &report, deps); err == nil || report.Len() != 0 {
					t.Fatal("invalid existing backup accepted/reported", err, report.String())
				}
				if !reflect.DeepEqual(before, frozenTree(t, root)) || !bytes.Equal(pointer, get(t, filepath.Join(root, "store", "current.json"))) {
					t.Fatal("invalid existing-backup refusal changed files/metadata/pointer")
				}
			})
		}
	}
}

func TestExistingBackupIdentityRejectsEveryInputAlias(t *testing.T) {
	for _, name := range []string{"candidate.json", "manifest.json", "baseline.json", "current.json", "previous.json", "active-object.json"} {
		t.Run(name, func(t *testing.T) {
			root, _, old, _ := setup(t)
			alias := filepath.Join(root, "alias-inputs", name)
			put(t, alias, old) // exact bytes isolate file identity from hash mismatch
			backup := filepath.Join(root, "backup")
			if err := os.MkdirAll(backup, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(backup, "active-catalog.json")
			if err := os.Link(alias, path); err != nil {
				t.Skipf("hard link unavailable: %v", err)
			}
			before := frozenTree(t, root)
			if _, err := verifyExistingBackup(path, backup, filepath.Join(root, "store"), old, catalogstore.Hash(old), []string{alias}); err == nil || !strings.Contains(err.Error(), "alias") {
				t.Fatal("exact-byte input alias accepted", err)
			}
			if after := frozenTree(t, root); !reflect.DeepEqual(before, after) {
				t.Fatalf("alias verification wrote files: before=%v after=%v", before, after)
			}
		})
	}
}

func TestExistingBackupFailuresPreservePointerWithoutFallback(t *testing.T) {
	for _, mode := range []string{"version object failure", "previous replacement", "current replacement", "before commit CAS", "late CAS", "backup changed before commit", "app running", "process probe failure"} {
		t.Run(mode, func(t *testing.T) {
			root, args, old, candidate := setup(t)
			backupFile := filepath.Join(root, "backup", "active-catalog.json")
			put(t, backupFile, old)
			args = append(args, "-existingBackupFile", backupFile, "-apply", "-appClosed")
			pointer := filepath.Join(args[1], "current.json")
			original := get(t, pointer)
			expectedPointer := original
			backupExpected := frozenTree(t, filepath.Join(root, "backup"))
			deps := clearDeps()
			sentinel := errors.New("explicit simulated failure; no workaround")
			switch mode {
			case "version object failure":
				put(t, filepath.Join(args[1], "versions", catalogstore.Hash(candidate)+".json"), []byte("blocked immutable version"))
			case "previous replacement", "current replacement":
				target := "previous.json"
				if mode == "current replacement" {
					target = "current.json"
				}
				deps.replace = func(from, to string) error {
					if filepath.Base(to) == target {
						return sentinel
					}
					return catalogstore.ReplaceFile(from, to)
				}
			case "before commit CAS":
				expectedPointer = append(bytes.Clone(original), ' ')
				deps.beforeCommit = func() error { put(t, pointer, expectedPointer); return nil }
			case "late CAS":
				expectedPointer = append(bytes.Clone(original), ' ')
				deps.replace = func(from, to string) error {
					if filepath.Base(to) == "previous.json" {
						put(t, pointer, expectedPointer)
					}
					return catalogstore.ReplaceFile(from, to)
				}
			case "backup changed before commit":
				deps.beforeCommit = func() error {
					put(t, backupFile, bytes.Replace(old, []byte("保留猫"), []byte("修改猫"), 1))
					backupExpected = frozenTree(t, filepath.Join(root, "backup"))
					return nil
				}
			case "app running", "process probe failure":
				deps.appClosed = func() error { return sentinel }
			}
			var report bytes.Buffer
			err := runWithDependencies(args, &report, deps)
			if err == nil || report.Len() != 0 {
				t.Fatal("failed reuse reported success", err, report.String())
			}
			if !bytes.Equal(get(t, pointer), expectedPointer) || !bytes.Equal(get(t, filepath.Join(args[1], "versions", catalogstore.Hash(old)+".json")), old) {
				t.Fatal("failed reuse altered active pointer/old immutable object")
			}
			if !reflect.DeepEqual(backupExpected, frozenTree(t, filepath.Join(root, "backup"))) {
				t.Fatal("failed reuse wrote backup or attempted normal backup fallback")
			}
			if !bytes.Equal(get(t, args[3]), candidate) {
				t.Fatal("failed reuse rewrote authored candidate")
			}
			if mode == "before commit CAS" || mode == "late CAS" {
				if !errors.Is(err, catalogstore.ErrConflict) {
					t.Fatal("reuse lost exact CAS error", err)
				}
			}
		})
	}
}

func TestExistingBackupRequiresOptInAndNoopStillAudits(t *testing.T) {
	t.Run("default not inferred or certified", func(t *testing.T) {
		root, args, old, _ := setup(t)
		backupFile := existingBackupFixture(t, root, old, false)
		backupBefore := frozenTree(t, filepath.Join(root, "backup"))
		var report bytes.Buffer
		if err := runWithDependencies(args, &report, clearDeps()); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(report.String(), "existing_backup_verified") || !reflect.DeepEqual(backupBefore, frozenTree(t, filepath.Join(root, "backup"))) {
			t.Fatal("default audit inferred or certified a backup", report.String())
		}
		report.Reset()
		if err := runWithDependencies(append(args, "-apply", "-appClosed"), &report, clearDeps()); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(report.String(), "existing_backup_verified") || !bytes.Equal(get(t, filepath.Join(root, "backup", catalogstore.Hash(old)+".json")), old) || !bytes.Equal(get(t, backupFile), old) {
			t.Fatal("default apply did not preserve original backupDir behavior", report.String())
		}
	})
	for _, valid := range []bool{false, true} {
		t.Run(fmt.Sprintf("exact noop validbackup=%t", valid), func(t *testing.T) {
			root, args, old, _ := setup(t)
			backupFile := filepath.Join(root, "backup", "active-catalog.json")
			data := old
			if !valid {
				data = bytes.Replace(old, []byte("保留猫"), []byte("修改猫"), 1)
			}
			put(t, backupFile, data)
			m := manifest{Version: 1, BaselineSHA256: catalogstore.Hash(old), CandidateSHA256: catalogstore.Hash(old), Changes: []string{}, NewMonsterIDs: []int{}, NewSkillIDs: []int{}, NewTraitIDs: []string{}, LeaderAvatarIDs: []int{}}
			put(t, args[3], old)
			put(t, args[9], encode(t, m))
			args = append(args, "-existingBackupFile", backupFile, "-apply", "-appClosed")
			before := frozenTree(t, root)
			var report bytes.Buffer
			err := runWithDependencies(args, &report, clearDeps())
			if valid {
				if err != nil || !strings.Contains(report.String(), `"existing_backup_verified":true`) || !strings.Contains(report.String(), `"already_applied":true`) {
					t.Fatal("valid exact noop rejected/unverified", err, report.String())
				}
			} else if err == nil || report.Len() != 0 {
				t.Fatal("exact noop bypassed explicit backup verification", err, report.String())
			}
			if !reflect.DeepEqual(before, frozenTree(t, root)) {
				t.Fatal("noop backup verification wrote files")
			}
		})
	}
}

func TestNumericSemanticPrecisionAndPointerEscapes(t *testing.T) {
	a, err := decodeJSON([]byte(`{"n":9007199254740993,"d":1.0,"a/b~c":[1]}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := decodeJSON([]byte(`{"n":9007199254740993,"d":1e0,"a/b~c":[2]}`))
	if err != nil {
		t.Fatal(err)
	}
	diff := []string{}
	diffObject(a.(map[string]any), b.(map[string]any), "", &diff)
	if !sameStrings(diff, []string{"/a~1b~0c"}) {
		t.Fatal(diff)
	}
	if semanticEqual(json.Number("9007199254740993"), json.Number("9007199254740992")) {
		t.Fatal("lost integer precision")
	}
	for _, p := range []string{"", "/bad~", "/bad~2", "/monsters/*"} {
		if validPointer(p) {
			t.Fatal("accepted invalid pointer", p)
		}
	}
}
