package main

import (
	"encoding/json"
	"errors"
	"strings"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/sourcebaseline"
)

// initialCatalog is opt-in developer packaging preparation, not a startup
// migration or an updater operation. Player policies must never be reset merely
// because they open a new executable. Business data/source snapshots stay intact.
func initialCatalog(input *catalog.Catalog) (*catalog.Catalog, error) {
	raw, err := catalog.Marshal(input)
	if err != nil {
		return nil, err
	}
	out, err := catalog.Parse(raw)
	if err != nil {
		return nil, err
	}
	baseline, err := sourcebaseline.Decode(out.Extensions[sourcebaseline.Extension])
	if err != nil {
		return nil, err
	}
	if baseline == nil || len(baseline.Entries) == 0 {
		return nil, errors.New("缺少有效腾讯基线，不能将历史差异重新作为初始资料")
	}
	if raw := out.Extensions["catalog_choices"]; len(raw) > 0 {
		var policy struct {
			Version int                        `json:"version"`
			Entries map[string]json.RawMessage `json:"entries"`
		}
		if err = json.Unmarshal(raw, &policy); err != nil {
			return nil, err
		}
		if policy.Version != 1 || policy.Entries == nil {
			return nil, errors.New("不支持的选择记忆版本，未清除")
		}
		delete(out.Extensions, "catalog_choices")
	}
	if raw := out.Extensions["mieli_calibration"]; len(raw) > 0 {
		var evidence map[string]json.RawMessage
		if err = json.Unmarshal(raw, &evidence); err != nil {
			return nil, err
		}
		var version int
		if err = json.Unmarshal(evidence["version"], &version); err != nil {
			return nil, err
		}
		if version != 1 {
			return nil, errors.New("不支持的校准证据版本")
		}
		// Origin/mapping/verification evidence remains part of the built-in data.
		// Developer delta counters describe the previous seed, not player operations.
		if raw := evidence["counts"]; len(raw) > 0 {
			var counts map[string]json.RawMessage
			if err = json.Unmarshal(raw, &counts); err != nil {
				return nil, err
			}
			for key := range counts {
				if strings.HasSuffix(key, "_changed") {
					delete(counts, key)
				}
			}
			evidence["counts"], err = json.Marshal(counts)
			if err != nil {
				return nil, err
			}
		}
		out.Extensions["mieli_calibration"], err = json.Marshal(evidence)
		if err != nil {
			return nil, err
		}
	}
	if err = catalog.Validate(out); err != nil {
		return nil, err
	}
	return out, nil
}
