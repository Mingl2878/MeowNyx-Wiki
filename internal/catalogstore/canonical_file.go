package catalogstore

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Direct-file mode never consults or bootstraps the legacy pointer tree. The
// selected file is the only catalog source, including on the first startup.
func (s *Store) openCanonicalFile() (*Store, error) {
	data, err := s.readCanonicalFile()
	if err != nil {
		return nil, fmt.Errorf("读取指定图鉴文件失败，原文件未改动: %w", err)
	}
	if err = s.validate(data); err != nil {
		return nil, fmt.Errorf("指定图鉴文件不可用，原文件未改动: %w", err)
	}
	s.current = Snapshot{Revision: Hash(data), Data: bytes.Clone(data)}
	return s, nil
}

func canonicalFileInfo(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("指定图鉴文件必须是绝对路径")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > MaxCatalogBytes {
		return nil, errors.New("指定图鉴文件不是普通文件、是链接或超过限制")
	}
	physical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if !sameCanonicalPath(path, physical) {
		return nil, errors.New("指定图鉴文件路径包含链接或目录跳转")
	}
	return info, nil
}

func sameCanonicalPath(a, b string) bool {
	rel, err := filepath.Rel(a, b)
	return err == nil && rel == "."
}

func (s *Store) readCanonicalFile() ([]byte, error) {
	info, err := canonicalFileInfo(s.opts.CanonicalFile)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(s.opts.CanonicalFile)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !opened.Mode().IsRegular() || opened.Size() > MaxCatalogBytes || !os.SameFile(info, opened) {
		return nil, ErrConflict
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxCatalogBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxCatalogBytes {
		return nil, errors.New("指定图鉴文件超过限制")
	}
	checked, err := canonicalFileInfo(s.opts.CanonicalFile)
	if err != nil {
		return nil, err
	}
	if !os.SameFile(opened, checked) {
		return nil, ErrConflict
	}
	return data, nil
}

func (s *Store) checkCanonicalFile() error {
	disk, err := s.readCanonicalFile()
	if err != nil {
		return err
	}
	if !bytes.Equal(disk, s.current.Data) {
		return ErrConflict
	}
	return nil
}

// Check physical as well as lexical directories before creating any backup or
// image objects. Neither staging nor the canonical replacement may mutate the
// independent backup tree. Missing image/backup directories are not created here.
func (s *Store) checkCanonicalDirectories() error {
	backup, err := resolveStoreRoot(s.opts.BackupDir)
	if err != nil {
		return err
	}
	for _, dir := range []string{filepath.Dir(s.opts.CanonicalFile), s.opts.Root, filepath.Join(s.opts.Root, "images")} {
		physical, err := resolveStoreRoot(dir)
		if err != nil {
			return err
		}
		if !sameCanonicalPath(dir, physical) {
			return errors.New("图鉴写入目录包含链接或目录跳转")
		}
		if sameCanonicalPath(backup, physical) || strictlyWithin(backup, physical) || strictlyWithin(physical, backup) {
			return errors.New("图鉴写入目录与备份目录重叠")
		}
	}
	return nil
}

func (s *Store) canonicalBackupInfo() (os.FileInfo, error) {
	return s.canonicalBackupPathInfo(s.opts.ExistingBackupFile)
}

func (s *Store) canonicalBackupPathInfo(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || !strictlyWithin(s.opts.BackupDir, path) || strictlyWithin(s.opts.Root, path) {
		return nil, errors.New("已有备份必须是备份目录内、图鉴目录外的绝对文件路径")
	}
	if err := s.checkCanonicalDirectories(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > MaxCatalogBytes {
		return nil, errors.New("已有备份不是独立普通文件或超过限制")
	}
	backup, err := filepath.EvalSymlinks(s.opts.BackupDir)
	if err != nil {
		return nil, err
	}
	physical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	if !strictlyWithin(backup, physical) {
		return nil, errors.New("已有备份路径越出备份目录")
	}
	current, err := canonicalFileInfo(s.opts.CanonicalFile)
	if err != nil {
		return nil, err
	}
	if os.SameFile(info, current) {
		return nil, errors.New("已有备份与指定图鉴是同一文件")
	}
	return info, nil
}

// The caller holds s.mu. Only a successful same-volume Replace publishes the
// staged bytes and advances memory; late failures may leave inactive images.
func (s *Store) commitCanonicalFile(data []byte, expected string, images map[string][]byte) (Snapshot, error) {
	if expected == "" || expected != s.current.Revision {
		return Snapshot{}, ErrConflict
	}
	data = bytes.Clone(data)
	if err := s.validate(data); err != nil {
		return Snapshot{}, err
	}
	if err := s.checkCanonicalFile(); err != nil {
		return Snapshot{}, err
	}
	for name, b := range images {
		if !imagePattern.MatchString(name) || Hash(b) != name[:64] || len(b) == 0 || len(b) > 8<<20 {
			return Snapshot{}, errors.New("图片名称、大小或校验和无效")
		}
	}
	revision := Hash(data)
	if revision == s.current.Revision {
		return Snapshot{Revision: revision, Data: bytes.Clone(s.current.Data)}, nil
	}
	if err := s.checkCanonicalDirectories(); err != nil {
		return Snapshot{}, err
	}
	if s.opts.ExistingBackupFile != "" {
		if err := s.verifyExistingBackup(expected); err != nil {
			return Snapshot{}, fmt.Errorf("已有图鉴备份校验失败: %w", err)
		}
	} else {
		if err := os.MkdirAll(s.opts.BackupDir, 0700); err != nil {
			return Snapshot{}, fmt.Errorf("无法创建图鉴备份目录: %w", err)
		}
		backup := filepath.Join(s.opts.BackupDir, s.current.Revision+".json")
		if _, err := s.canonicalBackupPathInfo(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Snapshot{}, fmt.Errorf("图鉴写前备份失败: %w", err)
		}
		if err := writeImmutable(backup, s.current.Data); err != nil {
			return Snapshot{}, fmt.Errorf("图鉴写前备份失败: %w", err)
		}
	}
	// Backup validation can invoke a slow caller validator. Refuse a changed
	// canonical file before staging anything, not merely at the final switch.
	if err := s.checkCanonicalFile(); err != nil {
		return Snapshot{}, err
	}
	if len(images) > 0 {
		if err := os.MkdirAll(filepath.Join(s.opts.Root, "images"), 0700); err != nil {
			return Snapshot{}, err
		}
		if err := s.checkCanonicalDirectories(); err != nil {
			return Snapshot{}, err
		}
		for name, b := range images {
			if err := writeImmutable(filepath.Join(s.opts.Root, "images", name), b); err != nil {
				return Snapshot{}, err
			}
		}
	}
	if err := s.replaceCanonicalFile(data); err != nil {
		return Snapshot{}, fmt.Errorf("替换图鉴文件失败，旧资料仍有效: %w", err)
	}
	s.current = Snapshot{Revision: revision, Data: bytes.Clone(data)}
	return Snapshot{Revision: revision, Data: bytes.Clone(data)}, nil
}

func (s *Store) replaceCanonicalFile(data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(s.opts.CanonicalFile), ".catalog-file-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() { f.Close(); os.Remove(name) }()
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	// The exact disk bytes are checked after the same-volume temp is complete,
	// immediately before the host's atomic replacement. Never remove/copy.
	if err = s.checkCanonicalFile(); err != nil {
		return err
	}
	return s.opts.Replace(name, s.opts.CanonicalFile)
}
