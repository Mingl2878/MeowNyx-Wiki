//go:build windows

package catalogstore

import "golang.org/x/sys/windows"

// ReplaceFile is a same-volume, write-through replacement; it never removes the
// old file first. Used by the developer CLI as well as available to hosts.
func ReplaceFile(from, to string) error {
	a, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
