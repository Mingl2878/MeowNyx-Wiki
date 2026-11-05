package main

// Explicit normalized records are importer declarations, not raw protocol
// lifecycle fragments. Preserve the established strict canonical decoder for
// legacy single objects, arrays and versioned record envelopes. Mixed raw arrays
// must not accidentally invoke the old stateless RKPP adapter inside that decoder.
func battleLiveCanonicalShape(v any, depth int) (candidate, valid bool) {
	if depth > 4 {
		return true, false
	}
	switch value := v.(type) {
	case []any:
		anyCandidate := false
		allValid := len(value) > 0
		for _, child := range value {
			c, ok := battleLiveCanonicalShape(child, depth+1)
			anyCandidate = anyCandidate || c
			allValid = allValid && c && ok
		}
		return anyCandidate, allValid
	case map[string]any:
		// An explicit protocol opcode always remains on the stateful raw path.
		for _, key := range []string{"opcode", "opencode", "opcode_hex"} {
			if value[key] != nil {
				return false, false
			}
		}
		if child, ok := value["records"]; ok {
			items, ok := child.([]any)
			if !ok || len(items) == 0 {
				return true, false
			}
			_, valid = battleLiveCanonicalShape(items, depth+1)
			return true, valid
		}
		_, hasID := value["id"]
		_, hasSides := value["sides"]
		_, hasEvents := value["events"]
		_, hasVersion := value["version"]
		if hasID && (hasSides || hasEvents || hasVersion) {
			return true, value["id"] != nil
		}
	}
	return false, false
}
