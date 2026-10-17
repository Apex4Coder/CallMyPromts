#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon
#Include %A_ScriptDir%\..\..\bridge\window.ahk
global PORT := 0
; Hidden synthetic window only. No cursor movement, clipboard, browser or user state.
DetectHiddenWindows true
out := A_ScriptDir "\..\..\.bro\work\PAPER-W2-geometry-v2.json"
try {
    previous := DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    window := Gui("+Resize +MaximizeBox", "Paper geometry probe")
    window.Show("Hide w340 h370")
    rows := [], failed := 0, count := MonitorGetCount()
    loop count {
        index := A_Index
        MonitorGet index, &l, &t, &r, &b
        for point in [{x:(l+r)//2,y:(t+b)//2}, {x:r-1,y:b-1}, {x:l,y:t}] {
            result := PositionMenu(window.Hwnd, point)
            WinGetPos &x, &y, &width, &height, "ahk_id " window.Hwnd
            bounds := result.bounds
            style := WinGetStyle("ahk_id " window.Hwnd)
            ok := x >= bounds.left && y >= bounds.top && x+width <= bounds.right && y+height <= bounds.bottom
                && width = result.width && height = result.height && !(style & 0x50000)
            if !ok
                failed += 1
            rows.Push('{"monitor":' index ',"x":' x ',"y":' y ',"width":' width ',"height":' height ',"dpi":' result.dpi.x ',"ok":' (ok?"true":"false") '}')
        }
    }
    virtual := VirtualGeometryChecks()
    failed += virtual.failed
    window.Destroy()
    if previous
        DllCall("SetThreadDpiAwarenessContext", "ptr", previous, "ptr")
    if FileExist(out)
        throw Error("Previous geometry report exists; read before a fresh run")
    FileAppend '{"monitors":' count ',"failures":' failed ',"synthetic":true,"virtualChecks":[' JoinRows(virtual.rows) '],"checks":[' JoinRows(rows) ']}', out, "UTF-8-RAW"
    ExitApp failed ? 1 : 0
} catch Error as err {
    FileAppend err.Message, "*", "UTF-8"
    ExitApp 2
}
JoinRows(rows) {
    result := ""
    for row in rows
        result .= (result = "" ? "" : ",") row
    return result
}

; Unused HTTP polling in the included window helper is deliberately inert.
Get(path) {
    return ""
}

VirtualGeometryChecks() {
    rows := [], failed := 0
    for spec in [{left:-1920,top:-100,right:0,bottom:980,dpi:96}, {left:0,top:0,right:2560,bottom:1400,dpi:144}, {left:2560,top:-600,right:4480,bottom:440,dpi:192}] {
        geometry := MenuGeometry(spec.right-1, spec.bottom-1, spec, {x:spec.dpi,y:spec.dpi})
        ok := geometry.x >= spec.left && geometry.y >= spec.top && geometry.x+geometry.width <= spec.right && geometry.y+geometry.height <= spec.bottom
            && geometry.width = Min(Round(340*spec.dpi/96),spec.right-spec.left) && geometry.height = Min(Round(370*spec.dpi/96),spec.bottom-spec.top)
        if !ok
            failed += 1
        rows.Push('{"dpi":' spec.dpi ',"negativeOrigin":' (spec.left<0 || spec.top<0?"true":"false") ',"ok":' (ok?"true":"false") '}')
    }
    return {rows:rows,failed:failed}
}
