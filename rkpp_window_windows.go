package main

import (
	"errors"
	"log"
	"syscall"
	"unsafe"
)

const (
	SW_HIDE     = 0
	SW_SHOW     = 5
	WM_APP_TRAY = 0x8011
	trayShowID  = 1
	trayExitID  = 2
)

var (
	modShell32          = syscall.NewLazyDLL("shell32.dll")
	procNotifyIcon      = modShell32.NewProc("Shell_NotifyIconW")
	procLoadIcon        = modUser32.NewProc("LoadIconW")
	procCreatePopupMenu = modUser32.NewProc("CreatePopupMenu")
	procAppendMenu      = modUser32.NewProc("AppendMenuW")
	procTrackPopupMenu  = modUser32.NewProc("TrackPopupMenu")
	procDestroyMenu     = modUser32.NewProc("DestroyMenu")
	procGetCursorPos    = modUser32.NewProc("GetCursorPos")
	procGetModuleHandle = modKernel32.NewProc("GetModuleHandleW")
	trayInstalled       bool         // accessed only by the native window thread
	gCloseToBackground  bool         // guarded by gCloseMu; true only after tray installation
	gRealExitRequested  bool         // guarded by gCloseMu; skips hide/minimize, never the flush
	gWindowDispatch     func(func()) // installed by main, guarded by gCloseMu
)

// Full NOTIFYICONDATAW, including the post-Windows-2000 tail. No dependency or
// separate message-loop/window is needed: the existing hooked HWND receives it.
type rkppNotifyIconData struct {
	Size                       uint32
	Hwnd                       uintptr
	ID, Flags, CallbackMessage uint32
	Icon                       uintptr
	Tip                        [128]uint16
	State, StateMask           uint32
	Info                       [256]uint16
	Version                    uint32
	InfoTitle                  [64]uint16
	InfoFlags                  uint32
	GUID                       [16]byte
	BalloonIcon                uintptr
}

func trayData() rkppNotifyIconData {
	n := rkppNotifyIconData{Hwnd: mainHwnd, ID: 1, Flags: 7, CallbackMessage: WM_APP_TRAY}
	n.Size = uint32(unsafe.Sizeof(n))
	instance, _, _ := procGetModuleHandle.Call(0)
	n.Icon, _, _ = procLoadIcon.Call(instance, 1) // bundled application icon
	if n.Icon == 0 {
		n.Icon, _, _ = procLoadIcon.Call(0, 32512)
	} // IDI_APPLICATION
	tip, _ := syscall.UTF16FromString(applicationTitle())
	copy(n.Tip[:], tip)
	return n
}

func updateBackgroundTray(enabled bool) error {
	if !enabled {
		removeBackgroundTray()
		gCloseMu.Lock()
		wasBackground := gCloseToBackground
		gCloseToBackground = false
		gCloseMu.Unlock()
		// Only leaving background restores the window; ordinary saves preserve
		// the user's existing minimized/close behavior and window state.
		if wasBackground && mainHwnd != 0 {
			showHiddenWindow(mainHwnd)
		}
		return nil
	}
	if mainHwnd == 0 {
		return errors.New("native window is not ready for the background tray")
	}
	if !trayInstalled {
		for _, p := range []*syscall.LazyProc{procNotifyIcon, procLoadIcon, procCreatePopupMenu, procAppendMenu, procTrackPopupMenu, procDestroyMenu, procGetCursorPos, procGetModuleHandle} {
			if err := p.Find(); err != nil {
				return errors.New("native background tray APIs are unavailable")
			}
		}
		n := trayData()
		ok, _, _ := procNotifyIcon.Call(0, uintptr(unsafe.Pointer(&n))) // NIM_ADD
		if ok == 0 {
			return errors.New("cannot install native background tray")
		}
		trayInstalled = true
	}
	gCloseMu.Lock()
	gCloseToBackground = true
	gCloseMu.Unlock()
	return nil
}

func removeBackgroundTray() {
	if trayInstalled {
		n := rkppNotifyIconData{Hwnd: mainHwnd, ID: 1}
		n.Size = uint32(unsafe.Sizeof(n))
		procNotifyIcon.Call(2, uintptr(unsafe.Pointer(&n))) // NIM_DELETE
		trayInstalled = false
	}
}

// SW_RESTORE alone does not show a SW_HIDE window. Keep restored/maximized state
// for visible windows, but always SW_SHOW so hotkey/single-instance/tray work.
func showHiddenWindow(hwnd uintptr) {
	iconic, _, _ := procIsIconic.Call(hwnd)
	if iconic != 0 {
		procShowWindow.Call(hwnd, SW_RESTORE)
	}
	procShowWindow.Call(hwnd, SW_SHOW)
	procSetForeground.Call(hwnd)
}

func applySavedCloseSettings(s UserSettings) {
	gCloseMu.Lock()
	gCloseBehavior = s.CloseBehavior
	dispatch := gWindowDispatch
	gCloseMu.Unlock()
	if dispatch != nil {
		dispatch(func() {
			if err := updateBackgroundTray(s.CloseToBackground); err != nil {
				// Fail open to the old flush-safe close behavior, never hide a window
				// without a working route back to it. Persistence is not rolled back.
				gCloseMu.Lock()
				gCloseToBackground = false
				gCloseMu.Unlock()
				log.Printf("后台托盘不可用，保留安全关闭行为: %v", err)
			}
		})
	}
}

func requestRealWindowExit() {
	gCloseMu.Lock()
	gRealExitRequested = true
	gCloseMu.Unlock()
	// Same close path: __xhmCloseReady must acknowledge all queued writes before
	// WM_CLOSE is forwarded to WebView2. No direct DestroyWindow/Terminate.
	procPostMessage.Call(mainHwnd, WM_CLOSE, 0, 0)
}

func handleBackgroundTrayMessage(lParam uintptr) {
	msg := uint32(lParam)
	if msg == 0x0203 {
		showHiddenWindow(mainHwnd)
		return
	} // WM_LBUTTONDBLCLK
	if msg != 0x0205 && msg != 0x007B {
		return
	} // right-click/context menu
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)
	showText, _ := syscall.UTF16PtrFromString("显示窗口")
	exitText, _ := syscall.UTF16PtrFromString("退出")
	procAppendMenu.Call(menu, 0, trayShowID, uintptr(unsafe.Pointer(showText)))
	procAppendMenu.Call(menu, 0, trayExitID, uintptr(unsafe.Pointer(exitText)))
	var point struct{ X, Y int32 }
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	procSetForeground.Call(mainHwnd)
	chosen, _, _ := procTrackPopupMenu.Call(menu, 0x0100|0x0080|0x0002, uintptr(point.X), uintptr(point.Y), 0, mainHwnd, 0)
	procPostMessage.Call(mainHwnd, 0, 0, 0) // WM_NULL dismisses tray-menu foreground
	switch chosen {
	case trayShowID:
		showHiddenWindow(mainHwnd)
	case trayExitID:
		requestRealWindowExit()
	}
}

// Pure policy entry point used by isolated tests, not native-window tests.
func closeWindowAction(approved, realExit, background bool, behavior string, iconic bool) string {
	if approved {
		return "close"
	}
	if !realExit {
		if background {
			return "hide"
		}
		if behavior == "minimize" && !iconic {
			return "minimize"
		}
	}
	return "flush"
}
