// catalogctl is a developer-only migration/audit tool. The desktop updater uses
// the same Go model/importer in-process and does not launch this executable.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/officialdex"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	root := flag.String("root", ".", "source project root")
	source := flag.String("source", "", "previously downloaded official JSON; no network requests")
	output := flag.String("out", "", "write the validated canonical catalog (omitted: audit only)")
	report := flag.String("report", "", "write full proposal report outside the project")
	backup := flag.String("backup-dir", "", "required external backup directory for replacing output")
	export := flag.String("export-legacy", "", "export compatibility fixtures to an empty directory")
	safePartial := flag.Bool("accept-safe-partial", false, "acknowledge reviews: preserve unresolved items and apply only safe changes")
	initial := flag.Bool("initial-data", false, "developer-only: make calibrated data a clean factory baseline; remove preset policies, preserve source acknowledgements")
	flag.Parse()
	if *initial && *source != "" {
		return errors.New("初始资料整理不能与来源覆盖同时执行")
	}
	c, _, err := load(*root)
	if err != nil {
		return err
	}
	if *source != "" {
		rootExtensions := c.Extensions
		raw, err := os.ReadFile(*source)
		if err != nil {
			return err
		}
		p, err := officialdex.BuildCatalogProposal(c, raw)
		if err != nil {
			return err
		}
		if *report != "" {
			b, _ := json.MarshalIndent(p, "", "  ")
			if err = writeNew(*report, b); err != nil {
				return err
			}
		}
		counts := map[string]int{}
		for _, issue := range p.Issues {
			counts[issue.Severity+":"+issue.Code]++
		}
		summary, _ := json.MarshalIndent(map[string]any{"stats": p.Stats, "change_count": len(p.Changes), "issue_counts": counts}, "", "  ")
		fmt.Println(string(summary))
		if *output != "" {
			if p.HasBlockingIssues() {
				return errors.New("存在阻止应用的冲突；仅生成报告，未写资料")
			}
			for _, issue := range p.Issues {
				if issue.Severity == "review" && !*safePartial {
					return errors.New("存在待确认项；检查报告后可用 -accept-safe-partial 保留未解决项，仅应用安全部分")
				}
			}
		}
		c, err = catalog.ImportLegacy(catalog.LegacyFiles{Monsters: p.Files.Monsters, Moves: p.Files.Moves, Types: p.Files.Types, Wiki: p.Files.Wiki})
		if err != nil {
			return err
		}
		c.Extensions = rootExtensions
	}
	if *initial {
		c, err = initialCatalog(c)
		if err != nil {
			return err
		}
	}
	canonical, err := catalog.Marshal(c)
	if err != nil {
		return err
	}
	fmt.Printf("Catalog: %d monsters, %d skills, %d traits, %d learnsets; %d bytes; sha256 %s\n", len(c.Monsters), len(c.Skills), len(c.Traits), len(c.Learnsets), len(canonical), catalogstore.Hash(canonical))
	if *output != "" {
		if err = writeCatalog(*output, *backup, canonical); err != nil {
			return err
		}
	}
	if *export != "" {
		f, err := catalog.ExportLegacy(c)
		if err != nil {
			return err
		}
		for name, b := range map[string][]byte{"monsters.json": f.Monsters, "moves.json": f.Moves, "types.json": f.Types, "wiki_monster_data.json": f.Wiki} {
			if err = writeNew(filepath.Join(*export, name), b); err != nil {
				return err
			}
		}
	}
	return nil
}
func load(root string) (*catalog.Catalog, catalog.LegacyFiles, error) {
	raw, err := os.ReadFile(filepath.Join(root, "data", "catalog.json"))
	if err == nil {
		c, e := catalog.Parse(raw)
		if e != nil {
			return nil, catalog.LegacyFiles{}, e
		}
		f, e := catalog.ExportLegacy(c)
		return c, f, e
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, catalog.LegacyFiles{}, err
	}
	f := catalog.LegacyFiles{}
	for _, item := range []struct {
		name   string
		target *[]byte
	}{{"monsters.json", &f.Monsters}, {"moves.json", &f.Moves}, {"types.json", &f.Types}, {"wiki_monster_data.json", &f.Wiki}} {
		*item.target, err = os.ReadFile(filepath.Join(root, "data", item.name))
		if err != nil {
			return nil, f, err
		}
	}
	c, err := catalog.ImportLegacy(f)
	return c, f, err
}
func writeNew(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
func writeCatalog(target, backup string, data []byte) error {
	absolute, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	before, err := os.ReadFile(absolute)
	if err == nil {
		if backup == "" || !filepath.IsAbs(backup) {
			return errors.New("替换已有资料需要指定绝对的项目外备份目录")
		}
		if err = writeNew(filepath.Join(backup, "catalog-"+catalogstore.Hash(before)+".json"), before); err != nil && !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("备份失败: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(absolute), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(absolute), ".catalog-migrate-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return catalogstore.ReplaceFile(name, absolute)
}
