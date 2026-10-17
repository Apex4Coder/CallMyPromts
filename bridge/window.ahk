; Native windows are marked by this application and scoped to its current server port.
Open(hash, point := unset) {
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
                PositionMenu(hwnd, point)
            else if mini
                PositionCRM(hwnd, point)
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
    Run Format('"{}" --app="{}" --window-size=780,520', edge, url)
    deadline := A_TickCount + 3000
    while A_TickCount < deadline {
        for hwnd in WinGetList(title) {
            if !previous.Has(hwnd) && StrLower(WinGetProcessPath("ahk_id " hwnd)) = StrLower(edge) {
                DllCall("SetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr", PORT)
                if quick
                    PositionMenu(hwnd, point)
                else if mini
                    PositionCRM(hwnd, point)
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

PositionMenu(hwnd, point := unset) {
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
        WinSetStyle "-0x50000", "ahk_id " hwnd
        WinMove x, y, width, height, "ahk_id " hwnd
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
PositionCRM(hwnd, point) {
    previous := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    try {
        bounds := MenuWorkArea(point.x, point.y), dpi := MenuDpi(point.x, point.y)
        geometry := CRMGeometry(point.x, point.y, bounds, dpi)
        WinRestore "ahk_id " hwnd
        WinSetStyle "-0x10000", "ahk_id " hwnd
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

