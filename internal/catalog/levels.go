package catalog

import "fmt"

// ValidateLevelRange accepts historical records without explicit controls. New
// controls are all-or-nothing and may never silently clamp a supplied default.
func ValidateLevelRange(defaultLevel, min, max, step int) error {
	if min == 0 && max == 0 && step == 0 {
		return nil
	}
	if min < 1 || max > 99 || min > max || step < 1 || step > 98 || defaultLevel < min || defaultLevel > max {
		return fmt.Errorf("等级范围必须在1—99内，步进为1—98，默认等级必须在范围内")
	}
	return nil
}
