package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"xhmwiki/internal/catalog"
)

// Show only after the raw backup and the initial Store.Commit both succeed.
const catalogLegacyBootstrapMessage = "已保留旧版本地资料作为当前图鉴，未与新内置资料自动合并；请通过官方更新检查核对后再应用。"

// prepareCatalogBaseline only reads the explicitly named bundled data files.
// hasActive means the caller has found a current.json pointer (even if that
// pointer later fails validation): leftover legacy files must never become a
// recovery path which silently replaces an already initialized user catalog.
func prepareCatalogBaseline(read func(...string) ([]byte, error), hasActive bool) (data []byte, legacy *catalog.LegacyFiles, err error) {
	return prepareCatalogBaselineValidated(read, hasActive, func(b []byte) error {
		_, err := catalog.Parse(b)
		return err
	})
}

// The runtime supplies its exact-byte validation cache so preparing and opening
// the same immutable baseline do not independently decode it. Other callers keep
// the full catalog.Parse boundary above; legacy import/marshal is unchanged.
func prepareCatalogBaselineValidated(read func(...string) ([]byte, error), hasActive bool, validate func([]byte) error) (data []byte, legacy *catalog.LegacyFiles, err error) {
	if read == nil || validate == nil {
		return nil, nil, errors.New("缺少图鉴资料读取入口")
	}
	readCanonical := func() ([]byte, *catalog.LegacyFiles, error) {
		b, e := read("data", "catalog.json")
		if e != nil {
			return nil, nil, fmt.Errorf("读取内置图鉴失败: %w", e)
		}
		if e = validate(b); e != nil {
			return nil, nil, fmt.Errorf("内置图鉴校验失败: %w", e)
		}
		return bytes.Clone(b), nil, nil
	}
	if hasActive {
		return readCanonical()
	}
	var files catalog.LegacyFiles
	missing := []string{}
	for _, part := range catalogBootstrapLegacyParts(&files) {
		b, e := read("data", part.name)
		if errors.Is(e, os.ErrNotExist) {
			missing = append(missing, part.name)
			continue
		}
		if e != nil {
			return nil, nil, fmt.Errorf("读取旧图鉴 %s 失败，未忽略旧本地资料: %w", part.name, e)
		}
		*part.data = bytes.Clone(b)
	}
	if len(missing) == 4 {
		return readCanonical()
	}
	if len(missing) != 0 {
		return nil, nil, fmt.Errorf("旧图鉴文件不完整（缺少 %s），为避免丢失本地资料已停止初始化", strings.Join(missing, "、"))
	}
	// Do not read, merge, or prefer the newly distributed canonical document when
	// an uninitialized installation still has its complete local legacy dataset.
	c, e := catalog.ImportLegacy(files)
	if e != nil {
		return nil, nil, fmt.Errorf("旧本地图鉴迁移校验失败，未使用新内置资料覆盖: %w", e)
	}
	b, e := catalog.Marshal(c)
	if e != nil {
		return nil, nil, fmt.Errorf("旧本地图鉴归一化失败: %w", e)
	}
	return b, &files, nil
}

type catalogBootstrapLegacyPart struct {
	name string
	data *[]byte
}

func catalogBootstrapLegacyParts(files *catalog.LegacyFiles) []catalogBootstrapLegacyPart {
	return []catalogBootstrapLegacyPart{{"monsters.json", &files.Monsters}, {"moves.json", &files.Moves}, {"types.json", &files.Types}, {"wiki_monster_data.json", &files.Wiki}}
}

// A domain tag, fixed filenames, and byte lengths make the bundle boundary
// unambiguous. Whitespace and every otherwise retired legacy field are covered.
func catalogBootstrapBackupName(files catalog.LegacyFiles) string {
	h := sha256.New()
	_, _ = io.WriteString(h, "meownyx-legacy-catalog-backup/1\x00")
	for _, part := range catalogBootstrapLegacyParts(&files) {
		_, _ = fmt.Fprintf(h, "%s\x00%d\x00", part.name, len(*part.data))
		_, _ = h.Write(*part.data)
	}
	return "legacy-" + hex.EncodeToString(h.Sum(nil))
}

var catalogBootstrapBackupMu sync.Mutex

// backupLegacyCatalog writes only four fixed filenames under a content-named
// child of the caller's configured, absolute external backup root. It never
// accepts a filename from JSON, follows a symlink, overwrites an existing file,
// or changes the input. Successful repeats reuse exactly identical raw bytes.
// A partially missing backup can be completed; differing/truncated bytes stop
// the operation so the caller must not commit the initialization.
func backupLegacyCatalog(dir string, files catalog.LegacyFiles) error {
	clean := filepath.Clean(dir)
	if strings.TrimSpace(dir) == "" || !filepath.IsAbs(dir) || filepath.Dir(clean) == clean {
		return errors.New("旧图鉴备份必须使用已配置的绝对外部目录，不能使用磁盘根目录")
	}
	for _, part := range catalogBootstrapLegacyParts(&files) {
		if len(*part.data) == 0 {
			return fmt.Errorf("旧图鉴备份缺少原始 %s 字节", part.name)
		}
	}
	catalogBootstrapBackupMu.Lock()
	defer catalogBootstrapBackupMu.Unlock()
	root, err := catalogBootstrapOpenDirectory(clean)
	if err != nil {
		return fmt.Errorf("打开旧图鉴备份根目录失败: %w", err)
	}
	defer root.Close()
	name := catalogBootstrapBackupName(files)
	if err = root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("创建旧图鉴备份目录失败: %w", err)
	}
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("旧图鉴备份子目录不是普通目录，拒绝跟随链接")
	}
	bundle, err := root.OpenRoot(name)
	if err != nil {
		return err
	}
	defer bundle.Close()
	// Check all existing files before writing any missing member: a corrupt
	// content-addressed directory must not be "repaired" by silently replacing it.
	missing := []catalogBootstrapLegacyPart{}
	for _, part := range catalogBootstrapLegacyParts(&files) {
		if err = catalogBootstrapVerifyFile(bundle, part.name, *part.data); errors.Is(err, os.ErrNotExist) {
			missing = append(missing, part)
		} else if err != nil {
			return err
		}
	}
	for _, part := range missing {
		f, e := bundle.OpenFile(part.name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(e, os.ErrExist) { // Another process may have initialized it.
			if e = catalogBootstrapVerifyFile(bundle, part.name, *part.data); e != nil {
				return e
			}
			continue
		}
		if e != nil {
			return fmt.Errorf("创建旧图鉴备份 %s 失败: %w", part.name, e)
		}
		n, writeErr := f.Write(*part.data)
		if writeErr == nil && n != len(*part.data) {
			writeErr = io.ErrShortWrite
		}
		if writeErr == nil {
			writeErr = f.Sync()
		}
		closeErr := f.Close()
		if writeErr != nil {
			return fmt.Errorf("写入或同步旧图鉴备份 %s 失败: %w", part.name, writeErr)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	// Flush each complete file, including verified files from an interrupted or
	// repeated initialization, before the caller may publish the active pointer.
	for _, part := range catalogBootstrapLegacyParts(&files) {
		if err = catalogBootstrapVerifyFile(bundle, part.name, *part.data); err != nil {
			return err
		}
		f, e := bundle.OpenFile(part.name, os.O_RDWR, 0)
		if e != nil {
			return fmt.Errorf("打开备份进行持久化同步失败: %w", e)
		}
		syncErr := f.Sync()
		closeErr := f.Close()
		if syncErr != nil {
			return fmt.Errorf("同步旧图鉴备份失败: %w", syncErr)
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if err = catalogBootstrapSyncDirectory(bundle); err != nil {
		return err
	}
	return catalogBootstrapSyncDirectory(root)
}

// Rooted traversal prevents source metadata or a replaced child from escaping
// the configured directory. Existing symlinks/junctions are rejected component
// by component, including the configured backup root itself.
func catalogBootstrapOpenDirectory(dir string) (*os.Root, error) {
	volume := filepath.VolumeName(dir)
	base := volume + string(filepath.Separator)
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	rest := strings.TrimPrefix(dir, base)
	for _, component := range strings.Split(rest, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		if component == ".." {
			root.Close()
			return nil, errors.New("备份路径不得包含上级目录")
		}
		info, e := root.Lstat(component)
		if errors.Is(e, os.ErrNotExist) {
			if e = root.Mkdir(component, 0700); e != nil && !errors.Is(e, os.ErrExist) {
				root.Close()
				return nil, e
			}
			if e = catalogBootstrapSyncDirectory(root); e != nil {
				root.Close()
				return nil, e
			}
			info, e = root.Lstat(component)
		}
		if e != nil {
			root.Close()
			return nil, e
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, fmt.Errorf("备份路径组件 %s 不是普通目录，拒绝跟随链接", component)
		}
		next, e := root.OpenRoot(component)
		root.Close()
		if e != nil {
			return nil, e
		}
		root = next
	}
	return root, nil
}

func catalogBootstrapVerifyFile(root *os.Root, name string, want []byte) error {
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("已有备份 %s 不是普通文件，拒绝覆盖或跟随链接", name)
	}
	if info.Size() != int64(len(want)) {
		return fmt.Errorf("已有备份 %s 内容或长度不一致，拒绝覆盖", name)
	}
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, opened) {
		return fmt.Errorf("已有备份 %s 在校验时发生变化", name)
	}
	got, err := io.ReadAll(io.LimitReader(f, int64(len(want))+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(got, want) {
		return fmt.Errorf("已有备份 %s 内容不一致，拒绝覆盖", name)
	}
	return nil
}

func catalogBootstrapSyncDirectory(root *os.Root) error {
	// Windows does not support File.Sync on directory handles; every ordinary
	// backup file above is still flushed with FlushFileBuffers before success.
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
