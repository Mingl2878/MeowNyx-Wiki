package officialdex

import (
	"html"
	"strings"
	"unicode"
)

// The legacy UI has HTML/attribute interpolation sites. Refuse suspicious
// upstream display text instead of sanitizing it into a different definition.
// Chinese quotation marks and game punctuation are retained. This is a second
// boundary, not a replacement for output-context escaping in the UI.
func safeDisplayText(s string, multiline bool) bool {
	if strings.ContainsAny(s, "<>\"'`") || html.UnescapeString(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) && !(multiline && (r == '\n' || r == '\r' || r == '\t')) {
			return false
		}
	}
	return true
}
