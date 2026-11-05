//go:build !windows

package catalogstore

import "os"

func ReplaceFile(from, to string) error { return os.Rename(from, to) }
