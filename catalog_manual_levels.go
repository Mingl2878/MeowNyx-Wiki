package main

import (
	"bytes"
	"encoding/json"
	"errors"

	"xhmwiki/internal/catalog"
)

func applyManualLevelControls(monster map[string]interface{}, raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil // Old/partial editors never erase independently stored controls.
	}
	var controls struct {
		Enabled *bool `json:"enabled"`
		Default int   `json:"default"`
		Min     int   `json:"min"`
		Max     int   `json:"max"`
		Step    int   `json:"step"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&controls); err != nil || controls.Enabled == nil {
		return errors.New("无效的等级控件设置")
	}
	if controls.Min == 0 || controls.Max == 0 || controls.Step == 0 {
		return errors.New("请提供等级范围、步进和默认等级")
	}
	if err := catalog.ValidateLevelRange(controls.Default, controls.Min, controls.Max, controls.Step); err != nil {
		return err
	}
	monster["level_configurable"] = *controls.Enabled
	monster["default_level"] = controls.Default
	monster["level_min"] = controls.Min
	monster["level_max"] = controls.Max
	monster["level_step"] = controls.Step
	return nil
}
