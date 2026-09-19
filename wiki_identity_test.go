package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func testMonster(id int, name, form string) map[string]interface{} {
	return map[string]interface{}{"id": id, "form": form, "localized": map[string]interface{}{"zh": map[string]interface{}{"name": name}}}
}

func testJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testWiki(t *testing.T, v interface{}) map[string]interface{} {
	t.Helper()
	wiki, err := decodeWiki(testJSON(t, v))
	if err != nil {
		t.Fatal(err)
	}
	return wiki
}

func testSkill(name string) map[string]interface{} {
	return map[string]interface{}{"name": name, "source": "默认", "type": "物攻", "element": "普通", "desc": "描述"}
}

func testEntry(skills ...map[string]interface{}) map[string]interface{} {
	if skills == nil {
		skills = []map[string]interface{}{}
	}
	return map[string]interface{}{"image": "", "skills": skills}
}

func testRefs(skills []map[string]interface{}) []wikiSkillRef {
	refs := make([]wikiSkillRef, 0, len(skills))
	for _, s := range skills {
		key, _ := skillIdentity(s)
		refs = append(refs, key)
	}
	return refs
}

func TestNormalizeWikiName(t *testing.T) {
	cases := map[string]string{
		"权杖_Ⅱ": "权杖II", "权杖-II": "权杖II", "权杖II": "权杖II",
		"权杖-V": "权杖V", "权杖_Ⅴ": "权杖V", "权杖_ⅴ": "权杖V",
		"圣剑-X": "圣剑X", "圣剑_Ⅹ": "圣剑X", "圣剑　－　ｘ": "圣剑X",
		"\ufeff\u200b权\u200c杖\u200d－ｉｉ\u3000": "权杖II",
		" \t权杖-_ \tiv\n":                      "权杖IV", "ＡＢＣ　１２３": "ABC 123",
		"权杖_V（冬季形态）": "权杖_V(冬季形态)", "权杖_V（夏季形态）": "权杖_V(夏季形态)",
		"普通-名字": "普通-名字", "权杖-IIV": "权杖IIV", "": "",
	}
	for input, want := range cases {
		if got := normalizeMonsterName(input); got != want {
			t.Errorf("normalize(%q) = %q, want %q", input, got, want)
		}
	}
	roman := []string{"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"}
	for i, suffix := range roman {
		for _, base := range []rune{0x2160, 0x2170} {
			if got := normalizeMonsterName("名称_" + string(base+rune(i))); got != "名称"+suffix {
				t.Errorf("Roman conversion: %q", got)
			}
		}
	}
	for _, dash := range "‐‑‒–—−﹣" {
		if got := normalizeMonsterName("名称" + string(dash) + "Ⅺ"); got != "名称XI" {
			t.Errorf("dash conversion: %q", got)
		}
	}
}

func TestResolveWikiIdentityMergesOldAndNew53(t *testing.T) {
	old := []map[string]interface{}{}
	for i := 0; i < 52; i++ {
		old = append(old, testSkill(fmt.Sprintf("旧技能%d", i)))
	}
	legacy := testEntry(old...)
	legacy["image"] = "legacy.png"
	legacy["note"] = "keep me"
	canonical := testEntry(testSkill("拖拉机"), cloneObject(old[0]))
	canonical["image"] = "canonical.png"
	wiki := testWiki(t, map[string]interface{}{"圣剑_Ⅹ": legacy, "圣剑-X": canonical, "其他": testEntry(testSkill("别的"))})
	before := testJSON(t, wiki)
	resolved, err := resolveWikiIdentity(wiki, testMonster(434, "圣剑-X", "default"))
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved.Skills) != 53 || len(resolved.Aliases) != 2 {
		t.Fatalf("skills=%d aliases=%v", len(resolved.Skills), resolved.Aliases)
	}
	if resolved.Entry["image"] != "canonical.png" || resolved.Entry["note"] != "keep me" || resolved.Entry["monster_id"] != 434 {
		t.Fatalf("metadata: %v", resolved.Entry)
	}
	if !bytes.Equal(before, testJSON(t, wiki)) {
		t.Fatal("resolver mutated its input")
	}
}

func TestResolveWikiIdentityRenameAndForms(t *testing.T) {
	old := testEntry(testSkill("旧技能"))
	old["monster_id"] = 248
	otherForm := testEntry(testSkill("冬季技能"))
	otherForm["monster_id"] = 999
	wiki := testWiki(t, map[string]interface{}{"旧名_Ⅱ": old, "旧名-II": testEntry(testSkill("新技能")), "新名-II（冬季形态）": otherForm})
	resolved, err := resolveWikiIdentity(wiki, testMonster(248, "新名-II", "Original"))
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Canonical != "新名-II" || len(resolved.Skills) != 2 {
		t.Fatalf("rename: %+v", resolved)
	}
	winter, err := resolveWikiIdentity(wiki, testMonster(999, "新名-II", "冬季形态"))
	if err != nil || len(winter.Skills) != 1 || winter.Skills[0]["name"] != "冬季技能" {
		t.Fatalf("form separation: %+v %v", winter, err)
	}
	unmapped, err := resolveWikiIdentity(testWiki(t, map[string]interface{}{"基础名": testEntry(testSkill("legacy"))}), testMonster(20, "基础名", "冬季形态"))
	if err != nil || len(unmapped.Aliases) != 0 {
		t.Fatalf("must not steal legacy base name for a full form: %+v %v", unmapped, err)
	}
	for _, form := range []string{"", "default", "Original"} {
		if got := monsterDisplayName(testMonster(1, "基础名", form)); got != "基础名" {
			t.Errorf("displayName(%q)=%q", form, got)
		}
	}
}

func TestResolveWikiImageFallback(t *testing.T) {
	legacy := testEntry(testSkill("旧"))
	legacy["image"] = "legacy.png"
	wiki := testWiki(t, map[string]interface{}{"权杖-V": testEntry(), "权杖_Ⅴ": legacy})
	resolved, err := resolveWikiIdentity(wiki, testMonster(249, "权杖-V", "default"))
	if err != nil || resolved.Entry["image"] != "legacy.png" || len(resolved.Skills) != 1 {
		t.Fatalf("empty canonical must not erase legacy: %+v %v", resolved, err)
	}
}

func TestWikiConflictsAndSemanticDuplicates(t *testing.T) {
	a := testSkill("技能")
	delete(a, "source")
	a["extra"] = map[string]interface{}{"a": 1, "b": 2}
	b := testSkill("技能")
	b["source"] = ""
	b["extra"] = map[string]interface{}{"b": 2, "a": 1}
	wiki := testWiki(t, map[string]interface{}{"权杖-V": testEntry(a), "权杖_Ⅴ": testEntry(b)})
	resolved, err := resolveWikiIdentity(wiki, testMonster(249, "权杖-V", "default"))
	if err != nil || len(resolved.Skills) != 1 || resolved.Skills[0]["source"] != "默认" {
		t.Fatalf("semantic duplicate: %+v %v", resolved, err)
	}
	for _, field := range []string{"type", "element", "desc", "extra"} {
		t.Run(field, func(t *testing.T) {
			bad := cloneObject(b)
			bad[field] = "different"
			wiki := testWiki(t, map[string]interface{}{"权杖-V": testEntry(a), "权杖_Ⅴ": testEntry(bad)})
			if _, err := resolveWikiIdentity(wiki, testMonster(249, "权杖-V", "default")); err == nil {
				t.Fatal("expected conflicting skill error")
			}
			if _, _, err := prepareWikiSkills(testJSON(t, wiki), nil, testMonster(249, "权杖-V", "default"), nil, []wikiSkillRef{}, true); err == nil {
				t.Fatal("clearing must not conceal alias conflicts")
			}
		})
	}
	b["source"] = "传承"
	wiki = testWiki(t, map[string]interface{}{"权杖-V": testEntry(a), "权杖_Ⅴ": testEntry(b)})
	resolved, err = resolveWikiIdentity(wiki, testMonster(249, "权杖-V", "default"))
	if err != nil || len(resolved.Skills) != 2 {
		t.Fatalf("same name/different source must survive: %v", err)
	}
	for _, wrongID := range []interface{}{248, "249", 249.5, 0} {
		entry := testEntry(testSkill("技能"))
		entry["monster_id"] = wrongID
		wiki = testWiki(t, map[string]interface{}{"权杖_Ⅴ": entry})
		if _, err := resolveWikiIdentity(wiki, testMonster(249, "权杖-V", "default")); err == nil {
			t.Fatalf("expected explicit identity error for %v", wrongID)
		}
	}
}

func TestPrepareWikiCanonicalOutputAndPreservation(t *testing.T) {
	monster := testMonster(434, "圣剑-X", "Original")
	old := []map[string]interface{}{}
	for i := 0; i < 52; i++ {
		old = append(old, testSkill(fmt.Sprintf("旧%d", i)))
	}
	legacy := testEntry(old...)
	legacy["image"] = "legacy.png"
	legacy["extra"] = map[string]interface{}{"keep": true}
	canonical := testEntry(testSkill("拖拉机"))
	canonical["image"] = "canonical.png"
	input := testJSON(t, map[string]interface{}{"圣剑_Ⅹ": legacy, "圣剑-X": canonical, "其他": testEntry(testSkill("别的"))})
	wiki, _ := decodeWiki(input)
	resolved, _ := resolveWikiIdentity(wiki, monster)
	// Full replacement can remove one old skill and add another while preserving
	// all retained alias metadata. The resolver has already produced all 53.
	refs := testRefs(resolved.Skills)[1:]
	refs = append(refs, wikiSkillRef{"新增", ""}, wikiSkillRef{"新增", "默认"})
	out, changed, err := prepareWikiSkills(input, testMoveData(t, "新增"), monster, nil, refs, false)
	if err != nil || !changed {
		t.Fatalf("prepare: changed=%v error=%v", changed, err)
	}
	result, err := decodeWiki(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 || result["圣剑_Ⅹ"] != nil || result["圣剑-X（Original）"] != nil {
		t.Fatalf("noncanonical output: %v", result)
	}
	entry := result["圣剑-X"].(map[string]interface{})
	skills, _ := entrySkills(entry)
	if len(skills) != 53 || entry["monster_id"] != float64(434) || entry["image"] != "canonical.png" || entry["extra"] == nil {
		t.Fatalf("canonical metadata/count: %+v %d", entry, len(skills))
	}
	if !reflect.DeepEqual(result["其他"], wiki["其他"]) {
		t.Fatal("unrelated entry was changed")
	}
}

func TestPrepareEmptyProtectionAndUnchanged(t *testing.T) {
	monster := testMonster(249, "权杖-V", "default")
	input := testJSON(t, map[string]interface{}{"权杖_Ⅴ": testEntry(testSkill("旧技能")), "权杖-V": testEntry()})
	if _, _, err := prepareWikiSkills(input, nil, monster, nil, []wikiSkillRef{}, false); err == nil {
		t.Fatal("empty replacement must require explicit confirmation")
	}
	out, changed, err := prepareWikiSkills(input, nil, monster, nil, []wikiSkillRef{}, true)
	if err != nil || !changed {
		t.Fatalf("explicit empty: %v %v", changed, err)
	}
	wiki, _ := decodeWiki(out)
	entry := wiki["权杖-V"].(map[string]interface{})
	skills, _ := entrySkills(entry)
	if len(skills) != 0 || len(wiki) != 1 || entry["monster_id"] != float64(249) {
		t.Fatal("explicit empty did not canonicalize")
	}
	out, changed, err = prepareWikiSkills(input, nil, monster, nil, []wikiSkillRef{{"旧技能", ""}}, false)
	if err != nil || changed || out != nil {
		t.Fatalf("unchanged set must not rewrite: %v %v", changed, err)
	}
	out, changed, err = prepareWikiSkills(nil, nil, monster, nil, nil, false)
	if err != nil || changed || out != nil {
		t.Fatal("omitted/null list must not read, validate, or write wiki")
	}
}

// Paths are injected into handler cores. Never call getDataFilePath from tests:
// it prefers the EXE installation directory, not the current working directory.
type testDataPaths struct{ monsters, wiki, moves string }

func makeTestData(t *testing.T, monsters interface{}, wiki interface{}) testDataPaths {
	t.Helper()
	dir := t.TempDir()
	p := testDataPaths{filepath.Join(dir, "monsters.json"), filepath.Join(dir, "wiki.json"), filepath.Join(dir, "moves.json")}
	for path, data := range map[string][]byte{p.monsters: testJSON(t, monsters), p.wiki: testJSON(t, wiki), p.moves: testMoveData(t, "新", "新增")} {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return p
}
func readTestFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func editTestMonster(t *testing.T, p testDataPaths, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	handleEditMonsterFiles(w, httptest.NewRequest(http.MethodPost, "/api/edit-monster", strings.NewReader(body)), p.monsters, p.wiki, p.moves)
	return w
}
func assertJSONError(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	var result map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code < 400 || result["ok"] != false || result["error"] == "" || result["error"] == nil {
		t.Fatalf("not an error response: %d %s", w.Code, w.Body.String())
	}
}

func TestSaveMissingCorruptFilesPreservesBothFiles(t *testing.T) {
	for _, target := range []string{"wiki", "moves", "monsters"} {
		for _, state := range []string{"missing", "corrupt", "null"} {
			t.Run(target+"/"+state, func(t *testing.T) {
				p := makeTestData(t, []interface{}{testMonster(249, "权杖-V", "default")}, map[string]interface{}{"权杖_Ⅴ": testEntry(testSkill("旧"))})
				path := map[string]string{"wiki": p.wiki, "moves": p.moves, "monsters": p.monsters}[target]
				if state == "missing" {
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				} else {
					data := []byte(`{broken`)
					if state == "null" {
						data = []byte(`null`)
					}
					if err := os.WriteFile(path, data, 0600); err != nil {
						t.Fatal(err)
					}
				}
				before := map[string][]byte{}
				for _, file := range []string{p.monsters, p.wiki, p.moves} {
					before[file], _ = os.ReadFile(file)
				}
				w := editTestMonster(t, p, `{"id":249,"base_hp":999,"skillList":[{"name":"旧"},{"name":"新增"}]}`)
				assertJSONError(t, w)
				for file, old := range before {
					now, err := os.ReadFile(file)
					if old == nil && !os.IsNotExist(err) {
						t.Errorf("missing file recreated: %s", file)
					}
					if !bytes.Equal(old, now) {
						t.Errorf("file changed on failed save: %s", file)
					}
				}
			})
		}
	}
}

func TestEditOmittedAndUnchangedSkillListDoesNotWriteWiki(t *testing.T) {
	for _, list := range []string{"", `,"skillList":null`, `,"skillList":[{"name":"旧"}]`} {
		t.Run(list, func(t *testing.T) {
			p := makeTestData(t, []interface{}{testMonster(249, "权杖-V", "default")}, map[string]interface{}{"权杖_Ⅴ": testEntry(testSkill("旧"))})
			before := readTestFile(t, p.wiki)
			st, _ := os.Stat(p.wiki)
			w := editTestMonster(t, p, `{"id":249,"base_hp":777`+list+`}`)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			afterStat, _ := os.Stat(p.wiki)
			if !bytes.Equal(before, readTestFile(t, p.wiki)) || !os.SameFile(st, afterStat) || !st.ModTime().Equal(afterStat.ModTime()) {
				t.Fatal("wiki was rewritten")
			}
			if list == "" {
				if err := os.Remove(p.wiki); err != nil {
					t.Fatal(err)
				}
				if w = editTestMonster(t, p, `{"id":249,"base_hp":778}`); w.Code != 200 {
					t.Fatalf("omitted list tried reading wiki: %s", w.Body.String())
				}
			}
		})
	}
}

func TestInheritedEditBecomesOwnWithoutChangingAncestor(t *testing.T) {
	for _, empty := range []bool{false, true} {
		t.Run(fmt.Sprint(empty), func(t *testing.T) {
			parent := testMonster(1, "祖先", "default")
			parent["learnset_mode"] = "own"
			child := testMonster(2, "子代", "default")
			child["learnset_mode"] = "inherit"
			child["learnset_inherits_from_id"] = 1
			p := makeTestData(t, []interface{}{parent, child}, map[string]interface{}{"祖先": testEntry(testSkill("旧"))})
			before, _ := decodeWiki(readTestFile(t, p.wiki))
			var originalMonsters []map[string]interface{}
			json.Unmarshal(readTestFile(t, p.monsters), &originalMonsters)
			body := `{"id":2,"skillList":[{"name":"旧"},{"name":"新"}]}`
			if empty {
				assertJSONError(t, editTestMonster(t, p, `{"id":2,"skillList":[]}`))
				body = `{"id":2,"skillList":[],"allowEmptySkills":true}`
			}
			w := editTestMonster(t, p, body)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var monsters []map[string]interface{}
			if err := json.Unmarshal(readTestFile(t, p.monsters), &monsters); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(originalMonsters[0], monsters[0]) {
				t.Fatal("ancestor monster changed")
			}
			if monsters[1]["learnset_mode"] != "own" {
				t.Fatal("child did not become own")
			}
			if _, exists := monsters[1]["learnset_inherits_from_id"]; exists {
				t.Fatal("inherit ID was not removed")
			}
			after, _ := decodeWiki(readTestFile(t, p.wiki))
			if !reflect.DeepEqual(before["祖先"], after["祖先"]) {
				t.Fatal("ancestor wiki entry changed")
			}
			entry := after["子代"].(map[string]interface{})
			if entry["monster_id"] != float64(2) {
				t.Fatal("wrong ID")
			}
			skills, _ := entrySkills(entry)
			expected := 2
			if empty {
				expected = 0
			}
			if len(skills) != expected {
				t.Fatalf("skills=%d", len(skills))
			}
		})
	}
}

func TestAddMonsterAssignedIDNilEmptyAndSkills(t *testing.T) {
	for _, list := range []string{"", `,"skillList":null`, `,"skillList":[]`, `,"skillList":[{"name":"新增"}]`} {
		t.Run(list, func(t *testing.T) {
			p := makeTestData(t, []interface{}{testMonster(434, "旧精灵", "default")}, map[string]interface{}{})
			beforeWiki := readTestFile(t, p.wiki)
			w := httptest.NewRecorder()
			handleAddMonsterFiles(w, httptest.NewRequest(http.MethodPost, "/api/add-monster", strings.NewReader(`{"name":"新精灵"`+list+`}`)), p.monsters, p.wiki, p.moves)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var monsters []map[string]interface{}
			json.Unmarshal(readTestFile(t, p.monsters), &monsters)
			if len(monsters) != 2 || monsters[1]["id"] != float64(435) {
				t.Fatalf("assigned ID lost: %v", monsters)
			}
			if strings.Contains(list, "新增") {
				wiki, _ := decodeWiki(readTestFile(t, p.wiki))
				if wiki["新精灵"].(map[string]interface{})["monster_id"] != float64(435) {
					t.Fatal("new ID not stored in wiki")
				}
			} else if !bytes.Equal(beforeWiki, readTestFile(t, p.wiki)) {
				t.Fatal("nil/empty new learnset unnecessarily rewrote wiki")
			}
		})
	}
}

func TestAtomicWritesStageRollbackAndFailure(t *testing.T) {
	for _, mode := range []string{"success", "stage", "second", "rollback", "external"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			a, b := filepath.Join(dir, "a.json"), filepath.Join(dir, "b.json")
			os.WriteFile(a, []byte("old a"), 0600)
			os.WriteFile(b, []byte("old b"), 0600)
			writes := []preparedDataWrite{{a, []byte("old a"), []byte("new a")}, {b, []byte("old b"), []byte("new b")}}
			if mode == "stage" {
				os.Remove(b)
			}
			if mode == "external" {
				os.WriteFile(b, []byte("external"), 0600)
			}
			calls := 0
			err := commitDataWritesWithRename(writes, func(from, to string) error {
				calls++
				if calls == 2 && (mode == "second" || mode == "rollback") || calls == 3 && mode == "rollback" {
					return errors.New("injected rename failure")
				}
				return os.Rename(from, to)
			})
			if mode == "success" {
				if err != nil || string(readTestFile(t, a)) != "new a" || string(readTestFile(t, b)) != "new b" {
					t.Fatalf("success: %v", err)
				}
			} else {
				if err == nil {
					t.Fatal("failed transaction reported success")
				}
				if mode == "rollback" {
					if !strings.Contains(err.Error(), "rollback") {
						t.Fatal("rollback failure not surfaced")
					}
				} else if string(readTestFile(t, a)) != "old a" {
					t.Fatal("first file not preserved/restored")
				}
				if mode == "second" && string(readTestFile(t, b)) != "old b" {
					t.Fatal("second file not preserved")
				}
			}
			leftovers, _ := filepath.Glob(filepath.Join(dir, ".wiki-save-*"))
			if len(leftovers) != 0 {
				t.Fatalf("temporary files leaked: %v", leftovers)
			}
		})
	}
}

func TestMarshalFailurePreventsAnyWrite(t *testing.T) {
	monster := testMonster(1, "精灵", "default")
	p := makeTestData(t, []interface{}{monster}, map[string]interface{}{})
	before := readTestFile(t, p.monsters)
	wikiBefore := readTestFile(t, p.wiki)
	monster["bad"] = make(chan int)
	writes, err := prepareMonsterSave([]map[string]interface{}{monster}, monster, []wikiSkillRef{{"新", ""}}, false, p.monsters, before, p.wiki, p.moves)
	if err == nil || writes != nil {
		t.Fatal("marshal error not propagated")
	}
	if !bytes.Equal(before, readTestFile(t, p.monsters)) || !bytes.Equal(wikiBefore, readTestFile(t, p.wiki)) {
		t.Fatal("preparation wrote files")
	}
}

func TestConcurrentMonsterAndMoveWrites(t *testing.T) {
	p := makeTestData(t, []interface{}{testMonster(1, "原始", "default")}, map[string]interface{}{})
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 24)
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func(i int) {
			defer wg.Done()
			w := httptest.NewRecorder()
			handleAddMonsterFiles(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(fmt.Sprintf(`{"name":"精灵%d","skillList":[{"name":"新增"}]}`, i))), p.monsters, p.wiki, p.moves)
			responses <- w
		}(i)
		go func(i int) {
			defer wg.Done()
			w := httptest.NewRecorder()
			handleAddMoveFiles(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(fmt.Sprintf(`{"name":"技能%d","type":"普通","category":"物攻"}`, i))), p.moves)
			responses <- w
		}(i)
		go func(i int) {
			defer wg.Done()
			w := httptest.NewRecorder()
			handleEditMonsterFiles(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(fmt.Sprintf(`{"id":1,"base_hp":%d}`, 100+i))), p.monsters, p.wiki, p.moves)
			responses <- w
		}(i)
	}
	wg.Wait()
	close(responses)
	for w := range responses {
		if w.Code != 200 {
			t.Errorf("concurrent request failed: %s", w.Body.String())
		}
	}
	var monsters, moves []map[string]interface{}
	json.Unmarshal(readTestFile(t, p.monsters), &monsters)
	json.Unmarshal(readTestFile(t, p.moves), &moves)
	if len(monsters) != 9 || len(moves) != 10 {
		t.Fatalf("lost update: monsters=%d moves=%d", len(monsters), len(moves))
	}
	ids := map[int]bool{}
	for _, m := range monsters {
		id, _ := numericMonsterID(m["id"])
		if ids[id] {
			t.Fatalf("duplicate ID %d", id)
		}
		ids[id] = true
	}
	wiki, _ := decodeWiki(readTestFile(t, p.wiki))
	if len(wiki) != 8 {
		t.Fatalf("lost wiki update: %d", len(wiki))
	}
}

func TestPersistedAliasesRegisterRenameAndRejectKnownOtherID(t *testing.T) {
	monster := testMonster(1, "新名-X", "Original")
	other := testMonster(2, "别的精灵", "default")
	entry := testEntry(testSkill("旧技能"))
	entry["monster_id"] = 1
	entry["aliases"] = []string{"历史名称", "更早名称"}
	input := testJSON(t, map[string]interface{}{"改名前名称": entry, "历史名称": testEntry(testSkill("别名新增"))})
	wiki, _ := decodeWiki(input)
	resolved, err := resolveWikiIdentity(wiki, monster, []map[string]interface{}{monster, other})
	if err != nil || len(resolved.Skills) != 2 {
		t.Fatalf("persisted alias resolution: %+v %v", resolved, err)
	}
	refs := append(testRefs(resolved.Skills), wikiSkillRef{"新技能", ""})
	out, changed, err := prepareWikiSkills(input, testMoveData(t, "新技能"), monster, []map[string]interface{}{monster, other}, refs, false)
	if err != nil || !changed {
		t.Fatalf("rename save: %v %v", changed, err)
	}
	after, _ := decodeWiki(out)
	canonical := after["新名-X"].(map[string]interface{})
	aliases, err := wikiAliases(canonical)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"改名前名称", "历史名称", "更早名称"} {
		found := false
		for _, alias := range aliases {
			if alias == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("lost alias %q: %v", want, aliases)
		}
	}
	if len(after) != 1 {
		t.Fatal("old alias keys were not consolidated")
	}
	for _, conflict := range []string{"key", "alias", "unknown-id"} {
		bad := cloneObject(entry)
		key := "改名前名称"
		switch conflict {
		case "key":
			key = "别的精灵"
		case "alias":
			bad["aliases"] = []string{"别的精灵"}
		case "unknown-id":
			bad["monster_id"] = 99
		}
		badWiki := testWiki(t, map[string]interface{}{key: bad})
		if _, err := resolveWikiIdentity(badWiki, monster, []map[string]interface{}{monster, other}); err == nil {
			t.Fatalf("expected %s identity conflict", conflict)
		}
	}
}

func TestSingleEntryDuplicatesArePreservedNotMerged(t *testing.T) {
	monster := testMonster(1, "目标", "default")
	a := testSkill("重复")
	b := testSkill("重复")
	b["desc"] = "existing distinct row"
	unrelated := testEntry(testSkill("无关"), testSkill("无关"))
	input := testJSON(t, map[string]interface{}{"目标": testEntry(a, b), "无关精灵": unrelated})
	wiki, _ := decodeWiki(input)
	resolved, err := resolveWikiIdentity(wiki, monster)
	if err != nil || len(resolved.Skills) != 2 {
		t.Fatalf("single entry was deduplicated: %v", err)
	}
	out, changed, err := prepareWikiSkills(input, testMoveData(t, "新增"), monster, nil, []wikiSkillRef{{"重复", ""}, {"新增", ""}}, false)
	if err != nil || !changed {
		t.Fatalf("save: %v", err)
	}
	after, _ := decodeWiki(out)
	rows, _ := entrySkills(after["目标"].(map[string]interface{}))
	if len(rows) != 3 {
		t.Fatalf("existing duplicate rows lost: %d", len(rows))
	}
	if !reflect.DeepEqual(after["无关精灵"], wiki["无关精灵"]) {
		t.Fatal("unrelated duplicates modified")
	}
	_, changed, err = prepareWikiSkills(input, nil, monster, nil, []wikiSkillRef{{"重复", ""}}, false)
	if err != nil || changed {
		t.Fatal("unchanged refs must preserve duplicate rows without writing")
	}
}

func TestJavaScriptWhitespaceParity(t *testing.T) {
	for _, space := range []rune{0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000} {
		name := string(space) + "权杖" + string(space) + "−" + string(space) + "x" + string(space)
		if got := normalizeMonsterName(name); got != "权杖X" {
			t.Errorf("U+%04X: %q", space, got)
		}
	}
	for _, input := range []string{"权杖 − x", "权杖　－　ｘ", "　ＡＢＣ＿ⅻ　"} {
		want := "权杖X"
		if strings.Contains(input, "ＡＢＣ") {
			want = "ABCXII"
		}
		if got := normalizeMonsterName(input); got != want {
			t.Errorf("%q => %q, want %q", input, got, want)
		}
	}
	// NEL is whitespace to Go's unicode.IsSpace but not JS's regex or trim.
	input := string(rune(0x85)) + "权杖" + string(rune(0x85)) + "x"
	if got := normalizeMonsterName(input); got != string(rune(0x85))+"权杖"+string(rune(0x85))+"X" {
		t.Fatalf("NEL was incorrectly stripped: %q", got)
	}
}
