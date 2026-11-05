package officialdex

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Reject duplicate object keys, invalid UTF-8, trailing JSON, and excessive
// nesting instead of accepting encoding/json's last-key-wins behavior.
func decode(data []byte) (any, error) {
	if len(data) == 0 || len(data) > 32<<20 || !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid JSON size or UTF-8")
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	v, err := decodeValue(d, 0)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing JSON content")
	}
	return v, nil
}

func decodeValue(d *json.Decoder, depth int) (any, error) {
	if depth > 64 {
		return nil, fmt.Errorf("JSON nesting exceeds 64")
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, composite := t.(json.Delim)
	if !composite {
		return t, nil
	}
	switch delim {
	case '{':
		out := object{}
		for d.More() {
			t, err := d.Token()
			if err != nil {
				return nil, err
			}
			k, ok := t.(string)
			if !ok {
				return nil, fmt.Errorf("invalid object key")
			}
			if _, exists := out[k]; exists {
				return nil, fmt.Errorf("duplicate JSON key %q", k)
			}
			v, err := decodeValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		if t, err := d.Token(); err != nil || t != json.Delim('}') {
			return nil, fmt.Errorf("unterminated object")
		}
		return out, nil
	case '[':
		out := []any{}
		for d.More() {
			v, err := decodeValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		if t, err := d.Token(); err != nil || t != json.Delim(']') {
			return nil, fmt.Errorf("unterminated array")
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unexpected delimiter")
	}
}

func asObject(v any) object { m, _ := v.(map[string]any); return m }
func text(v any) string     { s, _ := v.(string); return s }
func integer(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		i, e := n.Int64()
		if e == nil && i >= 0 && i <= 9007199254740991 {
			return int(i), true
		}
	case int:
		if n >= 0 {
			return n, true
		}
	}
	return 0, false
}
func idOf(m object) int         { i, _ := integer(m["id"]); return i }
func localName(m object) string { return text(asObject(asObject(m["localized"])["zh"])["name"]) }
func zhString(m object) string  { return text(asObject(m["localized"])["zh"]) }
func description(m object) string {
	return text(asObject(asObject(m["localized"])["zh"])["description"])
}
func keys(m object) []string {
	k := make([]string, 0, len(m))
	for key := range m {
		k = append(k, key)
	}
	sort.Strings(k)
	return k
}
func equal(a, b any) bool {
	aa, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return bytes.Equal(aa, bb)
}
func clone(v any) any {
	switch a := v.(type) {
	case map[string]any:
		b := object{}
		for k, v := range a {
			b[k] = clone(v)
		}
		return b
	case []any:
		b := make([]any, len(a))
		for i, v := range a {
			b[i] = clone(v)
		}
		return b
	default:
		return a
	}
}
func ensure(m object, path ...string) object {
	for _, k := range path {
		child := asObject(m[k])
		if child == nil {
			child = object{}
			m[k] = child
		}
		m = child
	}
	return m
}
func field(m object, path string) any {
	parts := strings.Split(path, ".")
	for _, k := range parts[:len(parts)-1] {
		m = asObject(m[k])
	}
	return m[parts[len(parts)-1]]
}
func (p *Proposal) set(m object, entity string, id int, name, path string, value any) {
	old := field(m, path)
	if equal(old, value) {
		return
	}
	parts := strings.Split(path, ".")
	dst := ensure(m, parts[:len(parts)-1]...)
	dst[parts[len(parts)-1]] = clone(value)
	p.Changes = append(p.Changes, Change{entity, id, name, path, clone(old), clone(value), "update"})
}
func encodePreserving(original []byte, before, after any) ([]byte, error) {
	if reflect.DeepEqual(before, after) || equal(before, after) {
		return append([]byte(nil), original...), nil
	}
	b, e := json.MarshalIndent(after, "", "  ")
	if e != nil {
		return nil, e
	}
	return append(b, '\n'), nil
}
func objectArray(data []byte, label string) ([]any, error) {
	v, e := decode(data)
	if e != nil {
		return nil, fmt.Errorf("%s: %w", label, e)
	}
	a, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", label)
	}
	seen := map[int]bool{}
	for _, v := range a {
		m := asObject(v)
		id, ok := integer(m["id"])
		if m == nil || !ok || id <= 0 || seen[id] {
			return nil, fmt.Errorf("%s contains invalid/duplicate ID", label)
		}
		seen[id] = true
	}
	return a, nil
}
func numericString(v any, allowEmpty bool) (any, bool) {
	s, ok := v.(string)
	if !ok {
		return nil, false
	}
	if s == "" && allowEmpty {
		return nil, true
	}
	if s == "" || strings.TrimSpace(s) != s {
		return nil, false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return nil, false
		}
	}
	i, e := strconv.Atoi(s)
	if e != nil || i > 1000000 {
		return nil, false
	}
	return i, true
}
