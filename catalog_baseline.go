package main

import (
	"encoding/json"
	"fmt"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/officialdex"
	"xhmwiki/internal/sourcebaseline"
)

func (p *catalogChoicePlan) initBaseline(c *catalog.Catalog, proposal *officialdex.Proposal) error {
	if err := catalogrecovery.Validate(c); err != nil {
		return err
	}
	var err error
	p.baseline, err = sourcebaseline.Decode(c.Extensions[sourcebaseline.Extension])
	if err != nil {
		return err
	}
	p.observations = map[string]sourcebaseline.Observation{}
	p.sourceHash = proposal.SourceSHA256
	p.issueFingerprints = proposal.SourceIssueFingerprints
	p.issues = proposal.Issues
	for _, o := range proposal.SourceObservations {
		if o.LocalID == 0 && o.Entity != "catalog" {
			continue
		}
		key := catalogCandidateKey(o.Entity, o.LocalID, o.Field)
		if _, exists := p.observations[key]; exists {
			return fmt.Errorf("duplicate source observation binding %s", key)
		}
		p.observations[key] = o
	}
	if p.baseline != nil && len(p.observations) == 0 {
		return fmt.Errorf("source baseline requires normalized source observations")
	}
	return nil
}
func (p *catalogChoicePlan) sourceAcknowledged(entity string, id int, field string) bool {
	o, ok := p.observations[catalogCandidateKey(entity, id, field)]
	return ok && p.baseline.Matches(o)
}
func (p *catalogChoicePlan) sourceChanged(entity string, id int, field string) bool {
	if p.baseline == nil {
		return false
	}
	o, ok := p.observations[catalogCandidateKey(entity, id, field)]
	if !ok {
		return false
	}
	_, known := p.baseline.Entries[sourcebaseline.Key(o.Entity, o.Identity, o.Field)]
	return known && !p.baseline.Matches(o)
}
func (p *catalogChoicePlan) shieldAcknowledgedSource() {
	if p.baseline == nil {
		return
	}
	reservations, _ := catalogrecovery.Read(p.localCatalog) // validated by initBaseline
	out := p.candidates[:0]
	for _, item := range p.candidates {
		// Acknowledging a source value is not proof the local entity still
		// exists. Explicit deletion fixtures must remain recoverable even when
		// Tencent's complete entity value has not changed since calibration.
		// A source-only entity explicitly declined before is NOT a deletion.
		// Bypass only for a verified identity reservation of a deleted record.
		missingEntity := false
		if item.Entity == "monster" && item.Field == "entity" && item.Kind == "add" {
			if next := choiceMonster(p.sourceCatalog, item.ID); next != nil && next.SourceRef != nil {
				id, err := reservations.Match(next.SourceRef.Provider, next.SourceRef.ID, next.SourceRef.Identity)
				missingEntity = err == nil && id == item.ID
			}
		}
		if !missingEntity && p.sourceAcknowledged(item.Entity, item.ID, item.Field) {
			continue
		}
		if o, ok := p.observations[catalogCandidateKey(item.Entity, item.ID, item.Field)]; ok && item.Kind == "source_review" {
			item.SourceRevision = o.Value
		}
		if item.Entity == "monster" && item.Field == "learning" {
			item.LocalValue = baselineLearningDisplay(p.localCatalog, item.ID)
			if item.SourceAvailable {
				item.SourceValue = baselineLearningDisplay(p.sourceCatalog, item.ID)
			}
		}
		out = append(out, item)
	}
	p.candidates = out
}

// commitBaseline only modifies the isolated Apply candidate. The store commits
// its extension atomically with business data; checks, cancellation, stale
// previews and failed validation cannot advance it. Unselected revisions remain
// outstanding; neither an unrelated Apply nor clearing a policy accepts them.
func (p *catalogChoicePlan) commitBaseline(c *catalog.Catalog, selected map[string]string) error {
	if p.baseline == nil {
		return nil
	}
	b, err := sourcebaseline.Decode(c.Extensions[sourcebaseline.Extension])
	if err != nil {
		return err
	}
	acknowledged := map[string]bool{}
	for _, item := range p.candidates {
		choice, explicit := selected[item.Key]
		if !explicit {
			if memory, ok := p.remembered(item); ok {
				choice = memory.Choice
			}
		}
		// Local locks suppress updates but do not silently acknowledge a new source
		// revision. A future policy clear must still expose that outstanding change.
		if !explicit && choice != "source" {
			continue
		}
		if choice == "source" && !item.SourceAvailable {
			continue
		}
		o, ok := p.observations[catalogCandidateKey(item.Entity, item.ID, item.Field)]
		if !ok || !o.Available {
			continue
		} // never bless newly malformed/missing input
		b.Put(o)
		acknowledged[catalogCandidateKey(item.Entity, item.ID, item.Field)] = true
		if item.Field == "entity" && choice == "source" {
			// Acceptance switches to constituent field updates next time. Seed every
			// field now, keyed by semantic identity, not this preview's provisional ID.
			for _, part := range p.observations {
				if part.Entity == o.Entity && part.Identity == o.Identity && part.Available {
					b.Put(part)
				}
			}
		}
	}
	for _, issue := range p.issues {
		entity := issue.Entity
		if entity == "move" {
			entity = "skill"
		}
		if entity == "wiki" {
			entity = "monster"
		}
		field := unavailableChoiceField(issue)
		if field == "" {
			field = map[string]string{"localized.zh.description": "description", "description": "description", "power": "power", "energy_cost": "energy_cost", "_trait_notes": "trait", "source_stage": "evolution_stage", "forms": "leader_form"}[issue.Field]
		}
		if acknowledged[catalogCandidateKey(entity, issue.ID, field)] || acknowledged[catalogCandidateKey(entity, issue.ID, "entity")] {
			key := officialdex.BaselineIssueKey(issue)
			if fingerprint := p.issueFingerprints[key]; fingerprint != "" {
				if b.Issues == nil {
					b.Issues = map[string]string{}
				}
				b.Issues[key] = fingerprint
			}
		}
	}
	if len(acknowledged) > 0 {
		b.SourceSHA256 = p.sourceHash
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	c.Extensions[sourcebaseline.Extension] = raw
	return nil
}
func (p *catalogChoicePlan) issueAcknowledged(issue officialdex.Issue) bool {
	if p.baseline == nil || !officialdex.BaselineIssueSuppressible(issue) {
		return false
	}
	key := officialdex.BaselineIssueKey(issue)
	fingerprint := p.issueFingerprints[key]
	return fingerprint != "" && p.baseline.Issues[key] == fingerprint
}
func (p *catalogChoicePlan) visibleChanges(original []officialdex.Change) []officialdex.Change {
	if p.baseline == nil {
		return original
	}
	out := []officialdex.Change{}
	for _, item := range p.candidates {
		out = append(out, officialdex.Change{Entity: item.Entity, ID: item.ID, Name: item.Name, Field: item.Field, Before: item.LocalValue, After: item.SourceValue, Kind: item.Kind})
	}
	return out
}
