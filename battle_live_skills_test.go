package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func battleStreamSkillTestDocument(t *testing.T) battleStreamSkillDocument {
	t.Helper()
	var doc battleStreamSkillDocument
	if err := json.Unmarshal([]byte(battleStreamSkillProofJSON), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func battleStreamSkillTestBytes(t *testing.T, doc battleStreamSkillDocument) []byte {
	t.Helper()
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBattleStreamSkillLocalReviewedExactConfigIDs(t *testing.T) {
	want := map[string]int{
		"7021110": 74, "7021160": 68, "7050210": 164,
		"7050270": 161, "7050320": 155, "7070270": 491,
		"7070290": 492, "7090320": 217, "7150270": 351,
		"7130210": 321,  // Exact primary 贮藏 row, despite another same-name row.
		"7170110": 384,  // Exact 背袭 row, not system-looking 7000090.
		"7050200": 163,  // Exact 水刃 row, not different-energy 7200001.
		"7180450": 5945, // Stable local IDs are not bounded by skill count.
		"7020550": 35,   // 魔能爆; identity only, not a dynamic-power rewrite.
		"7020620": 28,   // 力量增效
		"7030300": 87,   // 光合作用
		"7050220": 151,  // 润泽
		"7090110": 212,  // 暴风雪
		"7120120": 282,  // 毒孢子
		"7120240": 297,  // 疫病吐息
		"7190280": 444,  // 超维投射
	}
	for config, local := range want {
		if got := battleStreamSkillLocal(config); got != local {
			t.Errorf("configuration %s: got %d, want stable local ID %d", config, got, local)
		}
	}
	ids, err := battleStreamSkillDecode([]byte(battleStreamSkillProofJSON))
	if err != nil || len(ids) == 0 || len(ids) != len(battleStreamSkillTestDocument(t).Mappings) {
		t.Fatalf("embedded proof did not validate: %v", err)
	}
}

func TestBattleStreamSkillLocalUnknownSystemPassiveAndVariants(t *testing.T) {
	for _, id := range []string{
		"", "0", "-1", "+7050320", "07050320", "7050320 ", "7050320.0", "7050320e0",
		"4294967296", "999999999", "水弹", "过山车", "rkpp:7050320",
		"200216", "200231", // Passive configuration IDs, not ordinary skills.
		"7000010", "7000030", "7010070", // System/role actions stay out.
		"7000090", "7200001", // Same display names, incompatible semantics.
		"7880030",            // Unreviewed same-name source variant is not an automatic alias.
		"7880058", "7001120", // 魔能爆 has different power; 超维投射 has different complete description.
		"7880000", "7001060", "7880062", "7880016", // Even matching-name/effect variants need their own review.
		"7880056", "7880026", "7880068", "7880043",
		"702055000", "719028000", "魔能爆", "超维投射", // New identities do not authorize runtime IDs or names.
		"705032000", "707027100", "702111100", // Runtime IDs are not config IDs.
	} {
		if got := battleStreamSkillLocal(id); got != 0 {
			t.Errorf("excluded/unknown %q mapped to %d", id, got)
		}
	}
	doc := battleStreamSkillTestDocument(t)
	for _, row := range doc.Excluded {
		if got := battleStreamSkillLocal(row.ConfigID); got != 0 {
			t.Errorf("excluded config %s (%s) mapped to %d", row.ConfigID, row.Reason, got)
		}
	}
}

func TestBattleStreamSkillDecodeRejectsConflictsAndUnprovedRows(t *testing.T) {
	cases := []struct {
		name string
		edit func(*battleStreamSkillDocument)
	}{
		{"duplicateConfigID", func(d *battleStreamSkillDocument) { d.Mappings = append(d.Mappings, d.Mappings[0]) }},
		{"conflictingConfigID", func(d *battleStreamSkillDocument) {
			row := d.Mappings[0]
			row.LocalSkillID++
			d.Mappings = append(d.Mappings, row)
		}},
		{"excludedConfigConflict", func(d *battleStreamSkillDocument) {
			d.Excluded = append(d.Excluded, battleStreamSkillExclusion{ConfigID: d.Mappings[0].ConfigID, Reason: "conflict"})
		}},
		{"ambiguousCanonicalName", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.CanonicalNameCount = 2 }},
		{"absentSourceRow", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.SourceNameCount = 0 }},
		{"passive", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.SourceType = 2 }},
		{"system", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.SourceType = 4 }},
		{"unknownElement", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.SourceElement = 7 }},
		{"differentCategory", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.LocalCategory = "Defense" }},
		{"differentEnergy", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.LocalEnergyCost++ }},
		{"differentPower", func(d *battleStreamSkillDocument) {
			value := *d.Mappings[0].Proof.LocalPower + 1
			d.Mappings[0].Proof.LocalPower = &value
		}},
		{"differentDescription", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.SourceDescription += "新增不同机制" }},
		{"unknownMarkup", func(d *battleStreamSkillDocument) { d.Mappings[0].Proof.SourceDescription = "<script>bad</script>" }},
		{"missingIdentity", func(d *battleStreamSkillDocument) { d.Mappings[0].LocalSkillID = 0 }},
		{"noncanonicalNumericID", func(d *battleStreamSkillDocument) { d.Mappings[0].ConfigID = "0" + d.Mappings[0].ConfigID }},
		{"futureVersion", func(d *battleStreamSkillDocument) { d.Version++ }},
		{"differentSourceHash", func(d *battleStreamSkillDocument) { d.Source.SHA256 = strings.Repeat("0", 64) }},
		{"differentSourceRevision", func(d *battleStreamSkillDocument) { d.Source.Revision = "unreviewed" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := battleStreamSkillTestDocument(t)
			tc.edit(&doc)
			if ids, err := battleStreamSkillDecode(battleStreamSkillTestBytes(t, doc)); err == nil || ids != nil {
				t.Fatal("invalid proof must reject the entire table without partial mappings")
			}
		})
	}
	for _, data := range [][]byte{nil, []byte("{}"), []byte(battleStreamSkillProofJSON + "{}"), []byte(strings.Repeat(" ", (2<<20)+1))} {
		if ids, err := battleStreamSkillDecode(data); err == nil || ids != nil {
			t.Fatal("malformed/oversized/trailing JSON must fail closed")
		}
	}
}

func TestBattleStreamSkillSameNameSourceIsNotAutomaticallyAmbiguous(t *testing.T) {
	doc := battleStreamSkillTestDocument(t)
	found := false
	for _, row := range doc.Mappings {
		if row.ConfigID == "7130210" {
			found = true
			if row.Proof.SourceNameCount < 2 || row.Proof.CanonicalNameCount != 1 || row.LocalSkillID != 321 {
				t.Fatal("exact 贮藏 config must retain its separately reviewed same-name proof")
			}
		}
	}
	if !found {
		t.Fatal("reviewed same-name primary configuration missing")
	}
}

func TestBattleStreamSkillEightReviewedProofsPreservePriorReview(t *testing.T) {
	// Fingerprints describe this frozen review delta, not a permanent skill-count
	// rule. They pin every field/order of the prior 495 proofs and the 221
	// exclusions remaining after exactly these eight IDs were independently audited.
	want := map[string]int{
		"7020550": 35, "7020620": 28, "7030300": 87, "7050220": 151,
		"7090110": 212, "7120120": 282, "7120240": 297, "7190280": 444,
	}
	doc := battleStreamSkillTestDocument(t)
	prior := make([]battleStreamSkillBinding, 0, 495)
	seen := make(map[string]bool)
	for _, row := range doc.Mappings {
		if local, added := want[row.ConfigID]; added {
			if seen[row.ConfigID] || row.LocalSkillID != local {
				t.Fatalf("duplicate or changed approved binding: %+v", row)
			}
			seen[row.ConfigID] = true
		} else {
			prior = append(prior, row)
		}
	}
	if len(seen) != len(want) || len(prior) != 495 || len(doc.Mappings) != 503 || len(doc.Excluded) != 221 {
		t.Fatalf("review delta changed: added=%d prior=%d total=%d excluded=%d", len(seen), len(prior), len(doc.Mappings), len(doc.Excluded))
	}
	for _, row := range doc.Excluded {
		if want[row.ConfigID] != 0 {
			t.Fatalf("approved ID remains excluded: %s", row.ConfigID)
		}
	}
	for _, tc := range []struct {
		name string
		data any
		sha  string
	}{
		{"prior complete proofs", prior, "37139616f9e1db5861c4d1445ac71783304351a2d77400df07b161245d3715a4"},
		{"remaining exclusions", doc.Excluded, "10d36c07d9ed49b83d74e9c5b9427e0de9dd3a3f5f6ac93a680bac1879fff21c"},
	} {
		data, err := json.Marshal(tc.data)
		if err != nil {
			t.Fatal(err)
		}
		if got := fmt.Sprintf("%x", sha256.Sum256(data)); got != tc.sha {
			t.Errorf("%s changed outside eight-ID review: %s", tc.name, got)
		}
	}
	if doc.CatalogReviewSHA256 != "0f9211a0bff1600cbd1a46a5564e1f107164953ac8173b06585a82a642680542" || doc.CanonicalReviewedSkills != 579 {
		t.Fatal("identity-only review must not replace the canonical review baseline")
	}
}

func TestBattleStreamSkillEightExactSourceEvidence(t *testing.T) {
	// These source fields were checked against SKILL_CONF at the pinned revision
	// and SHA256. The test needs neither that external file nor network/live data.
	cases := []struct {
		config, name, category, description         string
		nameCount, kind, damage, element, localType int
		energy                                      float64
		parameters                                  []float64
	}{
		{"7020550", "魔能爆", "Magic Attack", "造成魔伤，使用时消耗所有能量，消耗越高，伤害越高。", 2, 1, 3, 2, 1, 0, []float64{1, 450000, 700000, 900000, 1100000, 1350000, 1550000, 1650000, 1800000, 1900000, 2000000, 2100000}},
		{"7020620", "力量增效", "Status", "自己获得物攻+100%。", 2, 2, 1, 2, 1, 1, []float64{0}},
		{"7030300", "光合作用", "Status", "自己获得1层<desc_id=1021>光合印记</>。", 3, 2, 1, 3, 2, 4, []float64{0}},
		{"7050220", "润泽", "Status", "自己获得魔攻+190%。", 2, 2, 1, 5, 4, 7, []float64{0}},
		{"7090110", "暴风雪", "Physical Attack", "造成物伤，敌方获得1层<desc_id=1004>冻结</>。", 2, 1, 2, 9, 7, 3, []float64{85}},
		{"7120120", "毒孢子", "Status", "敌方获得5层<desc_id=1001>中毒</>。", 2, 2, 1, 12, 10, 3, []float64{0}},
		{"7120240", "疫病吐息", "Status", "敌方获得1层<desc_id=1014>中毒印记</>。", 2, 2, 1, 12, 10, 3, []float64{0}},
		{"7190280", "超维投射", "Status", "敌方获得4层<desc_id=1035>星陨印记</>。", 3, 2, 1, 20, 18, 4, []float64{0}},
	}
	for _, tc := range cases {
		t.Run(tc.config, func(t *testing.T) {
			doc := battleStreamSkillTestDocument(t)
			index := -1
			for i, row := range doc.Mappings {
				if row.ConfigID == tc.config {
					index = i
					break
				}
			}
			if index < 0 {
				t.Fatal("approved exact source row missing")
			}
			p := doc.Mappings[index].Proof
			if p.Name != tc.name || p.SourceNameCount != tc.nameCount || p.CanonicalNameCount != 1 || p.SourceType != 1 || p.SourceSkillType != tc.kind || p.SourceDamageType != tc.damage || p.SourceElement != tc.element || p.LocalTypeID != tc.localType || p.LocalCategory != tc.category || p.LocalEnergyCost != tc.energy || !reflect.DeepEqual(p.SourceEnergyCost, []float64{tc.energy}) || !reflect.DeepEqual(p.SourceDamageParameters, tc.parameters) || p.SourceDescription != tc.description {
				t.Fatalf("exact frozen source evidence changed: %+v", p)
			}
			if tc.kind == 1 {
				if p.LocalPower == nil || *p.LocalPower != tc.parameters[0] {
					t.Fatal("canonical base power changed; identity review must not rewrite dynamic formulas")
				}
			} else if p.LocalPower != nil {
				t.Fatal("status skills must retain absent canonical power, not synthesize zero")
			}
			// Same-name source multiplicity cannot bypass full-description review.
			doc.Mappings[index].Proof.SourceDescription += "不同机制"
			if ids, err := battleStreamSkillDecode(battleStreamSkillTestBytes(t, doc)); err == nil || ids != nil {
				t.Fatal("changed same-name source semantics must fail the whole table closed")
			}
		})
	}
}

func TestBattleStreamSkillProofMatchesCurrentCanonicalIDs(t *testing.T) {
	// Development-only verification of the shipped review, not a runtime lookup.
	// No source table/network/live DB/profile access is needed by this test.
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var cat struct {
		Version int `json:"schema_version"`
		Skills  []struct {
			ID          int      `json:"id"`
			Name        string   `json:"name"`
			Description string   `json:"description"`
			TypeID      int      `json:"type_id"`
			Category    string   `json:"category"`
			EnergyCost  float64  `json:"energy_cost"`
			Power       *float64 `json:"power"`
		} `json:"skills"`
	}
	if err = json.Unmarshal(data, &cat); err != nil || cat.Version != 2 {
		t.Fatalf("invalid canonical: %v", err)
	}
	byID := make(map[int]int, len(cat.Skills))
	nameCounts := make(map[string]int, len(cat.Skills))
	for i, skill := range cat.Skills {
		if _, exists := byID[skill.ID]; exists {
			t.Fatal("duplicate canonical skill ID")
		}
		byID[skill.ID] = i
		nameCounts[skill.Name]++
	}
	for _, row := range battleStreamSkillTestDocument(t).Mappings {
		index, exists := byID[row.LocalSkillID]
		if !exists {
			t.Fatalf("mapped stable ID %d is absent from current canonical", row.LocalSkillID)
		}
		skill, proof := cat.Skills[index], row.Proof
		text, ok := battleStreamSkillSemanticText(skill.Description)
		frozen, frozenOK := battleStreamSkillSemanticText(proof.LocalDescription)
		if skill.Name != proof.Name || nameCounts[skill.Name] != 1 || skill.TypeID != proof.LocalTypeID || skill.Category != proof.LocalCategory || skill.EnergyCost != proof.LocalEnergyCost || !ok || !frozenOK || text != frozen || (skill.Power == nil) != (proof.LocalPower == nil) || (skill.Power != nil && *skill.Power != *proof.LocalPower) {
			t.Errorf("reviewed config %s does not match canonical stable ID %d", row.ConfigID, row.LocalSkillID)
		}
		// Renaming the loaded catalog snapshot cannot change the frozen ID table.
		cat.Skills[index].Name = "runtime name edited"
		if got := battleStreamSkillLocal(row.ConfigID); got != row.LocalSkillID {
			t.Errorf("runtime table unexpectedly depends on current catalog name: %s", row.ConfigID)
		}
		cat.Skills[index].Name = skill.Name
	}
}
