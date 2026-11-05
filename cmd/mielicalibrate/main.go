// mielicalibrate audits/calibrates a canonical catalog from explicitly supplied
// offline tables. Player installations never download or execute this tool.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/mielicalibrate"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	input := flag.String("catalog", "data/catalog.json", "input canonical catalog")
	dir := flag.String("tables", "", "directory containing the six pinned client JSON tables")
	output := flag.String("out", "", "new candidate path; never overwrite")
	report := flag.String("report", "", "new development report path; never overwrite")
	asOf := flag.String("as-of", "", "explicit RFC3339 snapshot cutoff")
	flag.Parse()
	if *dir == "" || *asOf == "" {
		return fmt.Errorf("-tables and -as-of are required")
	}
	when, err := time.Parse(time.RFC3339, *asOf)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	c, err := catalog.Parse(raw)
	if err != nil {
		return err
	}
	tables, err := mielicalibrate.Load(*dir)
	if err != nil {
		return err
	}
	next, r, err := mielicalibrate.Calibrate(c, tables, when)
	if r != nil && *report != "" {
		b, e := json.MarshalIndent(r, "", "  ")
		if e != nil {
			return e
		}
		if e = writeNew(*report, b); e != nil {
			return e
		}
	}
	if err != nil {
		return err
	}
	fmt.Println(r.Summary())
	if *output != "" {
		b, e := catalog.Marshal(next)
		if e != nil {
			return e
		}
		if e = writeNew(*output, b); e != nil {
			return e
		}
		fmt.Println("Candidate:", *output)
	}
	return nil
}
func writeNew(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(b); err != nil {
		return err
	}
	return f.Sync()
}
