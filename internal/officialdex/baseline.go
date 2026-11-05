package officialdex

// Source observations are produced from validated Tencent input, never the
// local-dependent proposal. The latter intentionally suppresses protected power,
// preserves spelling and sometimes changes several coupled relationship fields.
import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	canonical "xhmwiki/internal/catalog"
	"xhmwiki/internal/sourcebaseline"
)

func sourceBaselineIdentity(s *sourceMonster) string {
	return strconv.Itoa(s.dex) + "|" + NormalizeName(s.name) + "|" + NormalizeName(s.form)
}
func sourceValue(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func (p *Proposal) observeSource(c *catalog, mapped map[string]int, moves map[string]object, locals *localIndex) {
	// Availability here means structurally valid SOURCE evidence. Whether the
	// local catalog can represent a type/skill remains a separate Build issue.
	types := map[string]object{}
	for _, s := range c.monsters {
		for _, field := range []string{"e", "e2"} {
			if s.valid[field] && text(s.raw[field]) != "" {
				types[text(s.raw[field])] = object{}
			}
		}
	}
	for _, s := range c.moves {
		if s.valid {
			types[text(s.raw["el"])] = object{}
		}
	}
	observations := []sourcebaseline.Observation{}
	add := func(entity, identity string, id int, field string, value any, available bool) {
		observations = append(observations, sourcebaseline.Observation{Entry: sourcebaseline.Entry{Entity: entity, Identity: identity, Field: field, Value: sourceValue(object{"available": available, "value": value})}, LocalID: id, Available: available})
	}
	refs := func(s *sourceMonster, field string) any {
		values, ok := s.raw[field].([]any)
		if !ok || !s.valid[field] {
			return object{"unavailable": s.raw[field]}
		}
		out := []any{}
		for _, v := range values {
			ref := asObject(v)
			n, _ := integer(ref["i"])
			target := c.byID[strconv.Itoa(n)]
			if target == nil || !target.identityOK {
				out = append(out, object{"unavailable": ref})
				continue
			}
			// IDs are only retained as source evidence alongside verified identity.
			out = append(out, object{"identity": sourceBaselineIdentity(target), "source_id": target.id})
		}
		if field == "forms" {
			sort.Slice(out, func(i, j int) bool { return string(sourceValue(out[i])) < string(sourceValue(out[j])) })
		}
		return out
	}
	images := []any{}
	for _, s := range c.monsters {
		if !s.identityOK {
			continue
		}
		id, identity := mapped[s.id], sourceBaselineIdentity(s)
		fields := map[string]any{}
		put := func(field string, value any, available bool) {
			fields[field] = value
			add("monster", identity, id, field, value, available)
		}
		put("identity", object{"name": NormalizeName(s.name), "form": NormalizeName(s.form), "dex": s.dex, "source_id": s.id, "forms": refs(s, "forms")}, true)
		for _, pair := range [][2]string{{"hp", "hp"}, {"atk", "phy_atk"}, {"matk", "mag_atk"}, {"df", "phy_def"}, {"mdf", "mag_def"}, {"spd", "speed"}} {
			value := s.raw[pair[0]]
			if n, ok := integer(value); ok {
				value = n
			}
			put("stats."+pair[1], value, s.valid[pair[0]])
		}
		put("type_ids", []any{text(s.raw["e"]), text(s.raw["e2"])}, s.valid["e"] && s.valid["e2"] && types[text(s.raw["e"])] != nil && (text(s.raw["e2"]) == "" || types[text(s.raw["e2"])] != nil))
		put("trait", object{"name": NormalizeName(text(s.raw["tn"])), "description": semanticText(text(s.raw["te"]))}, s.valid["tn"] && s.valid["te"])
		put("evolution_stage", object{"stage": s.raw["s"], "form": NormalizeName(s.form)}, s.valid["s"] || confirmedMoon(s))
		put("evolution", object{"members": refs(s, "evo"), "form": NormalizeName(s.form)}, s.valid["evo"])
		put("leader_form", object{"forms": refs(s, "forms"), "form": NormalizeName(s.form)}, s.valid["forms"])
		// data_note has no general source text. Its only source-dependent producer is
		// the reviewed addition/leader annotation; observe those inputs explicitly.
		put("data_note", object{"stage": s.raw["s"], "form": NormalizeName(s.form)}, s.valid["s"] || confirmedMoon(s))
		learning := []string{}
		seen := map[string]bool{}
		learningOK := s.learnOK && len(s.skills) > 0
		for _, skill := range s.skills {
			key := skill.key + "|" + skill.source
			if !seen[key] {
				learning = append(learning, key)
				seen[key] = true
			}
			learningOK = learningOK && c.moves[skill.key] != nil && c.moves[skill.key].valid
		}
		sort.Strings(learning)
		var learningValue any = learning
		if !s.learnOK {
			learningValue = object{"unavailable": s.raw["sk"]}
		}
		put("learning", learningValue, learningOK)
		image := ""
		if u, err := TrustedImageURL(text(s.raw["img"]), "wiki"); err == nil {
			image = u
		}
		images = append(images, object{"identity": identity, "url": image})
		fields["image"] = image
		add("monster", identity, id, "entity", fields, completeNewMonster(s, c, types))
	}
	for _, key := range c.moveOrder {
		s := c.moves[key]
		id := idOf(moves[key])
		fields := map[string]any{}
		put := func(field string, value any, available bool) {
			fields[field] = value
			add("skill", key, id, field, value, available)
		}
		put("identity", NormalizeName(s.name), s.valid)
		put("description", semanticText(text(s.raw["ef"])), s.valid)
		put("type_id", text(s.raw["el"]), s.valid)
		put("category", categoryToLegacy[text(s.raw["tp"])], s.valid)
		ec, ecOK := numericString(s.raw["ec"], false)
		pw, pwOK := numericString(s.raw["pw"], true)
		put("energy_cost", ec, s.valid && ecOK)
		put("power", pw, s.valid && pwOK)
		// Tencent has no season field. Explicitly record that absence, not a local
		// season value; future normalizers must version this contract if it changes.
		put("season", object{"source_field": false}, true)
		add("skill", key, id, "entity", fields, s.valid)
	}
	sort.Slice(images, func(i, j int) bool { return string(sourceValue(images[i])) < string(sourceValue(images[j])) })
	add("catalog", "tencent-compendium", 0, "image_policy", images, true)
	// An unmatched local-only identity has no source value to copy. A verified
	// whole-snapshot identity-set fingerprint acknowledges that absence without
	// confusing it with a source numeric ID or a permanent local lock.
	identities := []string{}
	matched := map[int]bool{}
	for _, s := range c.monsters {
		identities = append(identities, s.id+"|"+sourceBaselineIdentity(s))
		matched[mapped[s.id]] = true
	}
	sort.Strings(identities)
	identitySet := fmt.Sprintf("%x", sha256.Sum256(sourceValue(identities)))
	for id, m := range locals.monsters {
		if !matched[id] && id != 9001 {
			identity := "local-only|" + fmt.Sprint(m["dex_number"]) + "|" + NormalizeName(localName(m)) + "|" + NormalizeName(explicitLocalForm(m))
			add("monster", identity, id, "identity", object{"present": false, "source_identity_set": identitySet}, true)
		}
	}
	for key, m := range moves {
		if c.moves[key] == nil {
			add("skill", key, idOf(m), "identity", object{"present": false}, true)
		}
	}
	p.SourceObservations = observations
	p.observeSourceIssues(c, mapped)
}

// SeedTencentBaseline returns a cloned catalog with the FULL observed snapshot
// acknowledged, including rows/fields that BuildProposal leaves unchanged. It
// never copies proposal business values, writes files or changes choice policies.
// Call only after human-reviewed one-time calibration; this is not runtime Apply.
func SeedTencentBaseline(c *canonical.Catalog, source []byte) (*canonical.Catalog, *Proposal, error) {
	b, err := canonical.Marshal(c)
	if err != nil {
		return nil, nil, err
	}
	out, err := canonical.Parse(b)
	if err != nil {
		return nil, nil, err
	}
	p, err := BuildCatalogProposal(c, source)
	if err != nil {
		return nil, nil, err
	}
	if p.HasBlockingIssues() {
		return nil, p, fmt.Errorf("Tencent baseline cannot acknowledge blocking source conflicts")
	}
	known := 0
	for _, m := range c.Monsters {
		if m.SourceRef != nil && m.SourceRef.Provider == Provider {
			known++
		}
	}
	if known > 0 && p.Stats.MatchedMonsters*5 < known*4 || known == 0 && p.Stats.SourceDetails*2 < len(c.Monsters) {
		return nil, p, fmt.Errorf("Tencent baseline source coverage unexpectedly reduced")
	}
	baseline := sourcebaseline.New(p.SourceSHA256)
	baseline.Issues = p.SourceIssueFingerprints
	for _, o := range p.SourceObservations {
		baseline.Put(o)
	}
	raw, err := json.Marshal(baseline)
	if err != nil {
		return nil, p, err
	}
	if out.Extensions == nil {
		out.Extensions = canonical.Extensions{}
	}
	out.Extensions[sourcebaseline.Extension] = raw
	if err := canonical.Validate(out); err != nil {
		return nil, p, err
	}
	return out, p, nil
}
