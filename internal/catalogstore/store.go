// Package catalogstore commits a whole catalog by switching one small pointer.
// Catalogs and images are immutable, content-addressed objects. Network code must
// never write the active catalog directly. An incomplete generation is harmless.
package catalogstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const MaxCatalogBytes = 32 << 20

var ErrConflict = errors.New("资料已发生变化，请重新检查更新后再应用")
var ErrFutureVersion = errors.New("资料版本比本程序新，已拒绝降级写入")
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var imagePattern = regexp.MustCompile(`^[a-f0-9]{64}\.(png|jpg|jpeg)$`)

type Options struct {
	Root      string
	BackupDir string
	// CanonicalFile opts into direct, byte-preserving catalog-file storage.
	// It must name an existing absolute regular file. Empty retains pointer mode.
	CanonicalFile string
	// ExistingBackupFile is a developer-only opt-in to reuse an independently
	// created, exact backup instead of writing an unnecessary duplicate. It must
	// be a regular, non-symlink file strictly inside BackupDir and outside Root.
	// Commit verifies it read-only before staging. Ordinary app callers leave
	// this empty and retain the original write-before-commit backup behavior.
	ExistingBackupFile string
	Baseline           []byte
	Validate           func([]byte) error
	// Replace must replace a same-volume file atomically. Windows callers supply
	// MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH), never remove-and-copy.
	Replace func(from, to string) error
}
type Snapshot struct {
	Revision string `json:"revision"`
	Data     []byte `json:"-"`
	Recovery string `json:"recovery,omitempty"`
}
type pointer struct {
	Version   int    `json:"version"`
	Revision  string `json:"revision"`
	UpdatedAt string `json:"updated_at"`
}
type Store struct {
	mu           sync.RWMutex
	opts         Options
	current      Snapshot
	pointerBytes []byte
}

func Hash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func Open(opts Options) (*Store, error) {
	if !filepath.IsAbs(opts.Root) || !filepath.IsAbs(opts.BackupDir) {
		return nil, errors.New("图鉴与备份目录必须是绝对路径")
	}
	if opts.Validate == nil || opts.Replace == nil {
		return nil, errors.New("缺少资料校验或原子替换实现")
	}
	s := &Store{opts: opts}
	if opts.CanonicalFile != "" {
		return s.openCanonicalFile()
	}
	if err := s.validate(opts.Baseline); err != nil {
		return nil, fmt.Errorf("内置资料不可用: %w", err)
	}
	s.current = Snapshot{Revision: Hash(opts.Baseline), Data: bytes.Clone(opts.Baseline)}
	current, err := readBounded(filepath.Join(opts.Root, "current.json"), 4096)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取活动资料版本失败: %w", err)
	}
	s.pointerBytes = bytes.Clone(current)
	snap, err := s.loadPointer(current)
	if err == nil {
		s.current = snap
		return s, nil
	}
	if errors.Is(err, ErrFutureVersion) {
		return nil, err
	}
	previous, prevErr := readBounded(filepath.Join(opts.Root, "previous.json"), 4096)
	if prevErr == nil {
		if previousSnap, e := s.loadPointer(previous); e == nil {
			previousSnap.Recovery = "活动资料校验失败，已使用上一有效版本；原文件未被删除。"
			s.current = previousSnap
			return s, nil
		} else if errors.Is(e, ErrFutureVersion) {
			return nil, e
		}
	}
	// Never silently hide a lost user catalog behind an empty or bundled database.
	return nil, fmt.Errorf("活动资料损坏且上一版本不可用；请从备份恢复，原文件未改动: %w", err)
}
func (s *Store) validate(data []byte) error {
	if len(data) == 0 || len(data) > MaxCatalogBytes {
		return errors.New("图鉴资料为空或超过大小限制")
	}
	var version struct {
		SchemaVersion int `json:"schema_version"`
	}
	if err := json.Unmarshal(data, &version); err != nil {
		return err
	}
	if version.SchemaVersion > 2 {
		return ErrFutureVersion
	}
	return s.opts.Validate(data)
}
func (s *Store) loadPointer(data []byte) (Snapshot, error) {
	var p pointer
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return Snapshot{}, err
	}
	if d.Decode(new(any)) != io.EOF {
		return Snapshot{}, errors.New("资料版本指针包含额外内容")
	}
	if p.Version > 1 {
		return Snapshot{}, ErrFutureVersion
	}
	if p.Version != 1 || !hashPattern.MatchString(p.Revision) {
		return Snapshot{}, errors.New("资料版本指针无效")
	}
	b, err := readBounded(filepath.Join(s.opts.Root, "versions", p.Revision+".json"), MaxCatalogBytes)
	if err != nil {
		return Snapshot{}, err
	}
	if Hash(b) != p.Revision {
		return Snapshot{}, errors.New("资料文件校验和不一致")
	}
	if err = s.validate(b); err != nil {
		return Snapshot{}, err
	}
	return Snapshot{Revision: p.Revision, Data: b}, nil
}
func (s *Store) Current() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Snapshot{Revision: s.current.Revision, Data: bytes.Clone(s.current.Data), Recovery: s.current.Recovery}
}

// Commit retains a durable copy of the previous catalog BEFORE switching the
// active pointer. A failed/aborted staging operation leaves current unchanged.
// Cancellation belongs outside this short commit section.
func (s *Store) Commit(data []byte, expected string, images map[string][]byte) (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.opts.CanonicalFile != "" {
		return s.commitCanonicalFile(data, expected, images)
	}
	if expected == "" || expected != s.current.Revision {
		return Snapshot{}, ErrConflict
	}
	if err := s.validate(data); err != nil {
		return Snapshot{}, err
	}
	disk, err := readBounded(filepath.Join(s.opts.Root, "current.json"), 4096)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Snapshot{}, err
	}
	if !bytes.Equal(disk, s.pointerBytes) {
		return Snapshot{}, ErrConflict
	}
	for name, b := range images {
		if !imagePattern.MatchString(name) || Hash(b) != name[:64] || len(b) == 0 || len(b) > 8<<20 {
			return Snapshot{}, errors.New("图片名称、大小或校验和无效")
		}
	}
	revision := Hash(data)
	if revision == s.current.Revision && len(s.pointerBytes) > 0 {
		return Snapshot{Revision: revision, Data: bytes.Clone(s.current.Data)}, nil
	}
	reuseBackup := s.opts.ExistingBackupFile != ""
	if reuseBackup {
		if err = s.verifyExistingBackup(expected); err != nil {
			return Snapshot{}, fmt.Errorf("已有图鉴备份校验失败: %w", err)
		}
		// Verification must finish before any object or pointer is written. A
		// caller's schema validator can take time, so check the pointer again.
		if err = s.checkCurrentPointer(); err != nil {
			return Snapshot{}, err
		}
	} else {
		if err = os.MkdirAll(s.opts.BackupDir, 0700); err != nil {
			return Snapshot{}, fmt.Errorf("无法创建图鉴备份目录: %w", err)
		}
		if err = writeImmutable(filepath.Join(s.opts.BackupDir, s.current.Revision+".json"), s.current.Data); err != nil {
			return Snapshot{}, fmt.Errorf("图鉴写前备份失败: %w", err)
		}
	}
	versions := filepath.Join(s.opts.Root, "versions")
	if err = os.MkdirAll(versions, 0700); err != nil {
		return Snapshot{}, err
	}
	if err = writeImmutable(filepath.Join(versions, s.current.Revision+".json"), s.current.Data); err != nil {
		return Snapshot{}, err
	}
	if err = writeImmutable(filepath.Join(versions, revision+".json"), data); err != nil {
		return Snapshot{}, err
	}
	if len(images) > 0 {
		if err = os.MkdirAll(filepath.Join(s.opts.Root, "images"), 0700); err != nil {
			return Snapshot{}, err
		}
		for name, b := range images {
			if err = writeImmutable(filepath.Join(s.opts.Root, "images", name), b); err != nil {
				return Snapshot{}, err
			}
		}
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	previous, _ := json.Marshal(pointer{Version: 1, Revision: s.current.Revision, UpdatedAt: stamp})
	next, _ := json.Marshal(pointer{Version: 1, Revision: revision, UpdatedAt: stamp})
	if reuseBackup {
		if err = s.checkCurrentPointer(); err != nil {
			return Snapshot{}, err
		}
	}
	if err = s.replace(filepath.Join(s.opts.Root, "previous.json"), previous); err != nil {
		return Snapshot{}, fmt.Errorf("保存恢复指针失败: %w", err)
	}
	if reuseBackup {
		if err = s.checkCurrentPointer(); err != nil {
			return Snapshot{}, err
		}
	}
	if err = s.replace(filepath.Join(s.opts.Root, "current.json"), next); err != nil {
		return Snapshot{}, fmt.Errorf("切换资料版本失败，旧资料仍有效: %w", err)
	}
	s.pointerBytes = bytes.Clone(next)
	s.current = Snapshot{Revision: revision, Data: bytes.Clone(data)}
	return Snapshot{Revision: revision, Data: bytes.Clone(data)}, nil
}

// checkCurrentPointer is an additional guard for the explicit reuse path. The
// caller's atomic Replace guard still owns the final check at replacement time.
func (s *Store) checkCurrentPointer() error {
	disk, err := readBounded(filepath.Join(s.opts.Root, "current.json"), 4096)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if !bytes.Equal(disk, s.pointerBytes) {
		return ErrConflict
	}
	return nil
}

func strictlyWithin(base, path string) bool {
	rel, err := filepath.Rel(base, path)
	return err == nil && rel != "." && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// resolveStoreRoot also handles a first commit whose Root does not exist yet.
// Resolve its nearest existing ancestor so an ancestor symlink cannot disguise
// a backup physically inside the store as an independent external file.
func resolveStoreRoot(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		return resolved, err
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", err
	}
	resolved, err = resolveStoreRoot(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}

func (s *Store) existingBackupInfo() (os.FileInfo, error) {
	if s.opts.CanonicalFile != "" {
		return s.canonicalBackupInfo()
	}
	path := s.opts.ExistingBackupFile
	if !filepath.IsAbs(path) || !strictlyWithin(s.opts.BackupDir, path) || strictlyWithin(s.opts.Root, path) {
		return nil, errors.New("已有备份必须是备份目录内、图鉴目录外的绝对文件路径")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > MaxCatalogBytes {
		return nil, errors.New("已有备份不是独立普通文件或超过限制")
	}
	backupDir, err := filepath.EvalSymlinks(s.opts.BackupDir)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	root, err := resolveStoreRoot(s.opts.Root)
	if err != nil {
		return nil, err
	}
	if !strictlyWithin(backupDir, resolved) || strictlyWithin(root, resolved) {
		return nil, errors.New("已有备份路径越出备份目录或位于图鉴目录内")
	}
	// A backup directory containing Root, or a versions/images directory linked
	// into it, would make ordinary staging mutate the supposedly read-only
	// backup tree. Reject those overlaps before any staging operation too.
	for _, dir := range []string{s.opts.Root, filepath.Join(s.opts.Root, "versions"), filepath.Join(s.opts.Root, "images")} {
		physical, e := resolveStoreRoot(dir)
		if e != nil {
			return nil, e
		}
		rel, e := filepath.Rel(backupDir, physical)
		if (e == nil && rel == ".") || strictlyWithin(backupDir, physical) {
			return nil, errors.New("图鉴写入目录与只读备份目录重叠")
		}
	}
	for _, stored := range []string{
		filepath.Join(s.opts.Root, "versions", s.current.Revision+".json"),
		filepath.Join(s.opts.Root, "current.json"),
		filepath.Join(s.opts.Root, "previous.json"),
	} {
		other, e := os.Stat(stored)
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
		if e == nil && os.SameFile(info, other) {
			return nil, errors.New("已有备份与活动资料或版本指针是同一文件")
		}
	}
	return info, nil
}

func (s *Store) verifyExistingBackup(expected string) error {
	info, err := s.existingBackupInfo()
	if err != nil {
		return err
	}
	f, err := os.Open(s.opts.ExistingBackupFile)
	if err != nil {
		return err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return err
	}
	if !opened.Mode().IsRegular() || opened.Size() > MaxCatalogBytes || !os.SameFile(info, opened) {
		return errors.New("已有备份在读取前发生变化")
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxCatalogBytes+1))
	if err != nil {
		return err
	}
	if err = s.validate(data); err != nil {
		return err
	}
	if Hash(data) != expected || !bytes.Equal(data, s.current.Data) {
		return errors.New("已有备份与当前资料字节或预期版本不一致")
	}
	// Recheck path, identity and bytes after validation; never accept a replaced
	// file, a new directory escape, or a backup tampered during verification.
	checked, err := s.existingBackupInfo()
	if err != nil {
		return err
	}
	if !os.SameFile(opened, checked) {
		return errors.New("已有备份在校验时被替换")
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	again, err := io.ReadAll(io.LimitReader(f, MaxCatalogBytes+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(data, again) {
		return errors.New("已有备份在校验时发生变化")
	}
	return nil
}

func (s *Store) Image(name string) ([]byte, error) {
	if !imagePattern.MatchString(name) {
		return nil, os.ErrNotExist
	}
	b, err := readBounded(filepath.Join(s.opts.Root, "images", name), 8<<20)
	if err != nil {
		return nil, err
	}
	if Hash(b) != name[:64] {
		return nil, errors.New("图片校验失败")
	}
	return b, nil
}
func (s *Store) replace(target string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(target), ".catalog-pointer-*")
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
	return s.opts.Replace(name, target)
}
func readBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > limit {
		return nil, errors.New("资料文件不是普通文件或超过限制")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("资料文件超过限制")
	}
	return b, nil
}
func writeImmutable(path string, data []byte) error {
	old, err := readBounded(path, int64(len(data)))
	if err == nil {
		if !bytes.Equal(old, data) {
			return errors.New("已有不可变对象校验失败")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Do not leave a partial object under its final hash after a crash. A
	// generation or image becomes visible only after the complete file is synced.
	f, err := os.CreateTemp(filepath.Dir(path), ".catalog-object-*")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer func() { f.Close(); os.Remove(temporary) }()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return ReplaceFile(temporary, path)
}
