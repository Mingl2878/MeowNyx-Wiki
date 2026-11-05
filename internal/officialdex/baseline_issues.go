package officialdex

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

func BaselineIssueKey(i Issue) string {
	return fmt.Sprintf("%x", sha256.Sum256(sourceValue([]string{i.Severity, i.Code, i.Entity, i.SourceID, NormalizeName(i.Name), i.Field})))
}

// A release acknowledgement is not permission to hide structural/identity
// failures, even when a malformed response happens to recur byte-for-byte.
func BaselineIssueSuppressible(i Issue) bool {
	return i.Severity != "blocking" && !strings.Contains(i.Code, "identity") && !strings.Contains(i.Code, "crosscheck") && !strings.HasPrefix(i.Code, "invalid_") && i.Code != "unknown_type" && i.Code != "unknown_stage" && i.Code != "source_relationship_cycle"
}
func (p *Proposal) observeSourceIssues(c *catalog, mapped map[string]int) {
	p.SourceIssueFingerprints = map[string]string{}
	byLocal := map[int]*sourceMonster{}
	for _, s := range c.monsters {
		if mapped[s.id] != 0 {
			byLocal[mapped[s.id]] = s
		}
	}
	for _, i := range p.Issues {
		if !BaselineIssueSuppressible(i) {
			continue
		}
		var evidence any
		s := c.byID[i.SourceID]
		if s == nil {
			s = byLocal[i.ID]
		}
		if s != nil {
			switch i.Field {
			case "hp", "atk", "matk", "df", "mdf", "spd":
				evidence = s.raw[i.Field]
			case "rt":
				evidence = object{"rt": s.raw["rt"], "hp": s.raw["hp"], "atk": s.raw["atk"], "matk": s.raw["matk"], "df": s.raw["df"], "mdf": s.raw["mdf"], "spd": s.raw["spd"]}
			case "s", "source_stage":
				evidence = object{"s": s.raw["s"], "f": s.raw["f"]}
			case "tn", "te", "_trait_notes":
				evidence = object{"tn": s.raw["tn"], "te": semanticText(text(s.raw["te"]))}
			case "evo", "evolution_members", "evolves_from_id":
				evidence = s.raw["evo"]
			case "forms", "leader_of_id":
				evidence = s.raw["forms"]
			case "sk", "skills", "learnset_mode", "learnset_inherits_from_id":
				evidence = s.raw["sk"]
			case "monster", "wiki":
				evidence = s.raw["img"]
			default:
				if strings.HasPrefix(i.Field, "sk.") {
					evidence = s.raw["sk"]
				} else {
					evidence = s.raw
				}
			}
		} else if move := c.moves[NormalizeName(i.Name)]; move != nil {
			switch i.Field {
			case "description", "localized.zh.description":
				evidence = semanticText(text(move.raw["ef"]))
			case "power":
				evidence = move.raw["pw"]
			case "energy_cost":
				evidence = move.raw["ec"]
			default:
				evidence = move.raw
			}
		} else {
			// Local-only records carry a source-absence observation, not local values.
			entity := i.Entity
			if entity == "move" {
				entity = "skill"
			}
			if entity == "wiki" {
				entity = "monster"
			}
			for _, o := range p.SourceObservations {
				if o.Entity == entity && o.LocalID == i.ID && o.Field == "identity" {
					evidence = o.Value
					break
				}
			}
		}
		if evidence != nil {
			p.SourceIssueFingerprints[BaselineIssueKey(i)] = fmt.Sprintf("%x", sha256.Sum256(sourceValue(evidence)))
		}
	}
}
