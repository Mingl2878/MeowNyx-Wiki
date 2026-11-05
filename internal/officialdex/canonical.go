package officialdex

import (
	canonical "xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
)

// BuildCatalogProposal is the canonical entry point. Root identity reservations
// are intentionally not exported into the legacy business-record projections.
// Keep the canonical context here so a missing, independently proven source
// monster can recover its original local ID rather than max(existing)+1.
func BuildCatalogProposal(c *canonical.Catalog, source []byte) (*Proposal, error) {
	reservations, err := catalogrecovery.Read(c)
	if err != nil {
		return nil, err
	}
	files, err := canonical.ExportLegacy(c)
	if err != nil {
		return nil, err
	}
	return buildProposal(LegacyFiles{Monsters: files.Monsters, Moves: files.Moves, Types: files.Types, Wiki: files.Wiki}, source, reservations)
}
