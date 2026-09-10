//go:build windows

package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const defaultCharset = 1

type logfontW struct {
	Height         int32
	Width          int32
	Escapement     int32
	Orientation    int32
	Weight         int32
	Italic         byte
	Underline      byte
	StrikeOut      byte
	CharSet        byte
	OutPrecision   byte
	ClipPrecision  byte
	Quality        byte
	PitchAndFamily byte
	FaceName       [32]uint16
}

var (
	modGDI32                = syscall.NewLazyDLL("gdi32.dll")
	procEnumFontFamiliesExW = modGDI32.NewProc("EnumFontFamiliesExW")
	procGetDCForFonts       = modUser32.NewProc("GetDC")
	procReleaseDCForFonts   = modUser32.NewProc("ReleaseDC")
	fontCatalogOnce         sync.Once
	fontCatalog             []string
	fontCatalogCollecting   map[string]string
)

func enumFontCallback(lf *logfontW, _ uintptr, _ uintptr, _ uintptr) uintptr {
	end := 0
	for end < len(lf.FaceName) && lf.FaceName[end] != 0 {
		end++
	}
	name := strings.TrimSpace(string(utf16.Decode(lf.FaceName[:end])))
	if name == "" || strings.HasPrefix(name, "@") || len([]rune(name)) > 120 {
		return 1
	}
	fontCatalogCollecting[strings.ToLower(name)] = name
	return 1
}

func installedFontFamilies() []string {
	fontCatalogOnce.Do(func() {
		fontCatalogCollecting = make(map[string]string)
		hdc, _, _ := procGetDCForFonts.Call(0)
		if hdc != 0 {
			lf := logfontW{CharSet: defaultCharset}
			callback := syscall.NewCallback(enumFontCallback)
			procEnumFontFamiliesExW.Call(hdc, uintptr(unsafe.Pointer(&lf)), callback, 0, 0)
			procReleaseDCForFonts.Call(0, hdc)
		}
		fontCatalog = make([]string, 0, len(fontCatalogCollecting))
		for _, name := range fontCatalogCollecting {
			fontCatalog = append(fontCatalog, name)
		}
		sort.Slice(fontCatalog, func(i, j int) bool {
			return strings.ToLower(fontCatalog[i]) < strings.ToLower(fontCatalog[j])
		})
		fontCatalogCollecting = nil
	})
	return append([]string(nil), fontCatalog...)
}

func normalizedFontKey(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r >= 0x4e00 {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// selectedUserFontFile 仅解析当前用户 Fonts 目录中的已验证字体，不接受外部路径。
// 系统 Fonts 仍由 Chromium 的原生字体解析处理，找不到文件时前端会回退 CSS family。
func selectedUserFontFile(fontFamily string) (string, bool) {
	fontFamily, ok := canonicalInstalledFont(fontFamily)
	if !ok || fontFamily == "" {
		return "", false
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return "", false
	}
	root := filepath.Join(localAppData, "Microsoft", "Windows", "Fonts")
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	wanted := normalizedFontKey(fontFamily)
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".ttf" && ext != ".otf" && ext != ".ttc" {
			continue
		}
		base := strings.TrimSuffix(entry.Name(), ext)
		if normalizedFontKey(base) == wanted {
			candidate := filepath.Join(root, entry.Name())
			if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() {
				return candidate, true
			}
		}
	}
	return "", false
}

func canonicalInstalledFont(requested string) (string, bool) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", true
	}
	if len([]rune(requested)) > 120 ||
		strings.ContainsAny(requested, "\"'();{}[]\\") ||
		strings.ContainsAny(requested, "\n\r\t") {
		return "", false
	}
	for _, name := range installedFontFamilies() {
		if strings.EqualFold(name, requested) {
			return name, true
		}
	}
	return "", false
}
