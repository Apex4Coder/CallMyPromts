; Native windows are marked by this application and scoped to its current server port.
Open(hash, point := unset) {
    hiddenBefore := A_DetectHiddenWindows
    DetectHiddenWindows true
    try {
        return IsSet(point) ? OpenOwnedPanel(hash, point) : OpenOwnedPanel(hash)
    } finally {
        DetectHiddenWindows hiddenBefore
    }
}

OpenOwnedPanel(hash, point := unset) {
    ; Capture the tray click before Edge launch or pointer movement.
    CoordMode "Mouse", "Screen"
    if !IsSet(point) {
        MouseGetPos &mx, &my
        point := {x:mx, y:my}
    }
    mini := hash = "#crm"
    quick := hash = "#pins"
    label := quick ? "Закреплённые" : (hash = "#crm" || InStr(hash, "#edit-") = 1) ? "CRM" : hash = "#clips" ? "Журнал" : "Управление"
    title := "CallMyPromts · " label " [" PORT "]"
    for hwnd in WinGetList(title) {
        if DllCall("GetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr") = PORT {
            if quick
                PositionMenu(hwnd, point, true)
            else if mini
                PositionCRM(hwnd, point, true)
            WinActivate "ahk_id " hwnd
            return true
        }
    }
    url := "http://127.0.0.1:" PORT "/" hash
    edge := FindEdge()
    if (edge = "") {
        ; A default browser may reuse a personal tab: never resize that window.
        Run url
        return false
    }
    previous := Map()
    for hwnd in WinGetList(title)
        previous[hwnd] := true
    ; A fresh browser must never paint its saved top-left placement.
    flags := (mini || quick) ? PanelLaunchFlags(quick, point) : ""
    command := Format('"{}" --app="{}"{}', edge, url, flags)
    if mini || quick
        Run command, , "Hide"
    else
        Run command
    deadline := A_TickCount + 3000
    while A_TickCount < deadline {
        for hwnd in WinGetList(title) {
            if !previous.Has(hwnd) && StrLower(WinGetProcessPath("ahk_id " hwnd)) = StrLower(edge) {
                DllCall("SetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr", PORT)
                if quick
                    PositionMenu(hwnd, point, true)
                else if mini
                    PositionCRM(hwnd, point, true)
                WinActivate "ahk_id " hwnd
                return true
            }
        }
        Sleep 50
    }
    return false
}

MenuWorkArea(x, y) {
    MonitorGetWorkArea 1, &left, &top, &right, &bottom
    loop MonitorGetCount() {
        MonitorGet A_Index, &l, &t, &r, &b
        if (x >= l && x < r && y >= t && y < b) {
            MonitorGetWorkArea A_Index, &left, &top, &right, &bottom
            break
        }
    }
    return {left:left, top:top, right:right, bottom:bottom}
}

MenuDpi(x, y) {
    dpiX := 96, dpiY := 96, detected := false
    monitor := DllCall("MonitorFromPoint", "int64", (y << 32) | (x & 0xffffffff), "uint", 2, "ptr")
    try {
        detected := DllCall("Shcore\GetDpiForMonitor", "ptr", monitor, "int", 0, "uint*", &dpiX, "uint*", &dpiY, "int") = 0
    }
    return {x:dpiX, y:dpiY, detected:detected}
}

PositionMenu(hwnd, point := unset, reveal := false) {
    previous := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    try {
        CoordMode "Mouse", "Screen"
        if IsSet(point)
            x := point.x, y := point.y
        else
            MouseGetPos &x, &y
        bounds := MenuWorkArea(x, y), dpi := MenuDpi(x, y)
        geometry := MenuGeometry(x, y, bounds, dpi)
        x := geometry.x, y := geometry.y, width := geometry.width, height := geometry.height
        ; Fixed quick menu: no resize frame or maximize box. Main CRM is unchanged.
        if reveal
            RevealPanelAt(hwnd, geometry, true)
        else {
            WinSetStyle "-0x50000", "ahk_id " hwnd
            WinMove x, y, width, height, "ahk_id " hwnd
        }
        return {x:x, y:y, width:width, height:height, dpi:dpi, bounds:bounds}
    } finally {
        if previous
            DllCall("SetThreadDpiAwarenessContext", "ptr", previous, "ptr")
    }
}

MenuGeometry(x, y, bounds, dpi) {
    width := Min(Round(340 * dpi.x / 96), bounds.right - bounds.left)
    height := Min(Round(370 * dpi.y / 96), bounds.bottom - bounds.top)
    x := Max(bounds.left, Min(x, bounds.right - width))
    y := Max(bounds.top, Min(y, bounds.bottom - height))
    return {x:x, y:y, width:width, height:height}
}

FindEdge() {
    suffix := "\Microsoft\Edge\Application\msedge.exe"
    for root in [EnvGet("ProgramFiles(x86)"), EnvGet("ProgramFiles"), EnvGet("LocalAppData")] {
        if (root != "" && FileExist(root suffix))
            return root suffix
    }
    return ""
}

PollWindow() {
    body := Get("/api/window")
    if InStr(body, '"window":"crm"')
        Open("#crm")
}

; CRM is an actual compact native window, not a small card inside a large browser.
PositionCRM(hwnd, point, reveal := false) {
    previous := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    try {
        bounds := MenuWorkArea(point.x, point.y), dpi := MenuDpi(point.x, point.y)
        geometry := CRMGeometry(point.x, point.y, bounds, dpi)
        if reveal
            RevealPanelAt(hwnd, geometry, false)
        else
            WinMove geometry.x, geometry.y, geometry.width, geometry.height, "ahk_id " hwnd
        return geometry
    } finally {
        if previous
            DllCall("SetThreadDpiAwarenessContext", "ptr", previous, "ptr")
    }
}

CRMGeometry(x, y, bounds, dpi) {
    scale := dpi.x / 96
    width := Min(Round(780 * scale), bounds.right - bounds.left)
    height := Min(Round(520 * dpi.y / 96), bounds.bottom - bounds.top)
    gap := Round(8 * scale), edge := Round(64 * scale)
    px := x - width + Round(24 * scale), py := y - height - gap
    if y <= bounds.top + edge
        py := y + gap
    else if x <= bounds.left + edge
        px := x + gap, py := y - height // 2
    else if x >= bounds.right - edge && y < bounds.bottom - edge
        px := x - width - gap, py := y - height // 2
    return {x:Max(bounds.left, Min(px, bounds.right-width)), y:Max(bounds.top, Min(py, bounds.bottom-height)), width:width, height:height}
}

; Restore/resize only while invisible; reveal after the compositor has final bounds.
; Disable transitions on this owned panel only, never global Windows animation settings.
RevealPanelAt(hwnd, geometry, quick) {
    hiddenBefore := A_DetectHiddenWindows
    DetectHiddenWindows true
    target := "ahk_id " hwnd
    disabled := Buffer(4, 0)
    NumPut "Int", 1, disabled
    DllCall("dwmapi\DwmSetWindowAttribute", "ptr", hwnd, "uint", 3, "ptr", disabled, "uint", 4)
    WinSetTransparent 0, target
    try {
        WinHide target
        WinRestore target
        WinSetStyle quick ? "-0x50000" : "-0x10000", target
        WinMove geometry.x, geometry.y, geometry.width, geometry.height, target
        DllCall("dwmapi\DwmFlush")
        DllCall("ShowWindow", "ptr", hwnd, "int", 4)
        DllCall("dwmapi\DwmFlush")
    } finally {
        if WinExist(target)
            WinSetTransparent "Off", target
        DetectHiddenWindows hiddenBefore
    }
}

PanelLaunchFlags(quick, point) {
    global ROOT
    if !IsSet(ROOT) || ROOT = ""
        throw Error("Application root is required before launching a panel")
    bounds := MenuWorkArea(point.x, point.y), dpi := MenuDpi(point.x, point.y)
    geometry := quick ? MenuGeometry(point.x, point.y, bounds, dpi) : CRMGeometry(point.x, point.y, bounds, dpi)
    ; A separate app-owned profile prevents a personal Edge process from ignoring
    ; first-window startup flags. Never read or modify the personal browser profile.
    profile := ROOT "\state\edge-panels\" (quick ? "pins" : "crm")
    DirCreate profile
    return Format(' --user-data-dir="{}" --no-first-run --no-default-browser-check --disable-background-mode --start-minimized --window-position={},{} --window-size={},{}', profile, geometry.x, geometry.y, geometry.width, geometry.height)
}

