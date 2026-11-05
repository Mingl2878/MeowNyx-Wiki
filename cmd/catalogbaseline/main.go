// catalogbaseline creates a release-time acknowledgement snapshot. It never
// fetches remote data, changes the input file, or copies proposed business data.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/officialdex"
	"xhmwiki/internal/sourcebaseline"
)

func run() error {
	input := flag.String("catalog", "", "calibrated canonical catalog input")
	source := flag.String("source", "", "complete Tencent d.json snapshot input")
	output := flag.String("out", "", "NEW output catalog path (must not exist)")
	flag.Parse()
	if *input == "" || *source == "" || *output == "" {
		return fmt.Errorf("usage: catalogbaseline -catalog <calibrated.json> -source <d.json> -out <new-output.json>")
	}
	inAbs, err := filepath.Abs(*input)
	if err != nil {
		return err
	}
	outAbs, err := filepath.Abs(*output)
	if err != nil {
		return err
	}
	if inAbs == outAbs {
		return fmt.Errorf("output must not overwrite input")
	}
	data, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	c, err := catalog.Parse(data)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(*source)
	if err != nil {
		return err
	}
	seeded, p, err := officialdex.SeedTencentBaseline(c, raw)
	if err != nil {
		return err
	}
	result, err := catalog.Marshal(seeded)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(*output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(result)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	baseline, _ := sourcebaseline.Decode(seeded.Extensions[sourcebaseline.Extension])
	fmt.Printf("Seeded %d normalized source entries; source SHA256 %s; %d details / %d skills; %d nonblocking review/warning items. Business data and policies unchanged. Output: %s\n", len(baseline.Entries), p.SourceSHA256, p.Stats.SourceDetails, p.Stats.SourceMoves, len(p.Issues), outAbs)
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
