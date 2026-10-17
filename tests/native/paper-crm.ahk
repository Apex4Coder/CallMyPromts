#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon
#Include %A_ScriptDir%\..\..\bridge\window.ahk
global PORT := A_Args.Length ? Integer(A_Args[1]) : 0
out := A_ScriptDir "\..\..\.bro\work\PAPER-W2G-crm-native.json"
try {
    DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
    if PORT < 1 || FileExist(out)
        throw Error("Invalid port or existing native report; do not replay")
    CoordMode "Mouse", "Screen"
    MouseGetPos &mx, &my
    bounds := MenuWorkArea(mx, my)
    point := {x:bounds.right-16, y:bounds.bottom+8}
    title := "CallMyPromts · CRM [" PORT "]"
    previous := 0
    for hwnd in WinGetList(title) {
        if DllCall("GetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr") = PORT
            previous := hwnd
    }
    if !Open("#crm", point)
        throw Error("Owned native CRM window not found or Edge unavailable")
    hwnd := WinExist(title)
    geometry := CRMGeometry(point.x, point.y, bounds, MenuDpi(point.x, point.y))
    WinGetPos &x, &y, &width, &height, "ahk_id " hwnd
    owned := DllCall("GetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr") = PORT
    reused := previous = 0 || hwnd = previous
    ok := owned && reused && width = geometry.width && height = geometry.height
        && x = geometry.x && y = geometry.y && WinGetMinMax("ahk_id " hwnd) = 0
    virtual := CheckCRMEdges()
    ok := ok && virtual = 0
    FileAppend '{"ok":' (ok?"true":"false") ',"owned":' (owned?"true":"false") ',"existingReused":' (reused?"true":"false") ',"x":' x ',"y":' y ',"width":' width ',"height":' height ',"virtualFailures":' virtual ',"clipboardTouched":false}', out, "UTF-8-RAW"
    ExitApp ok ? 0 : 1
} catch Error as err {
    FileAppend err.Message, "*", "UTF-8"
    ExitApp 2
}
Get(path) {
    return ""
}
CheckCRMEdges() {
    failed := 0
    for spec in [{left:-1920,top:-100,right:0,bottom:980,dpi:96}, {left:0,top:0,right:2560,bottom:1400,dpi:144}, {left:2560,top:-600,right:4480,bottom:440,dpi:192}] {
        for point in [{x:spec.right-12,y:spec.bottom+8}, {x:spec.left-8,y:spec.top+20}, {x:spec.left+20,y:spec.top-8}, {x:spec.right+8,y:spec.top+200}] {
            g := CRMGeometry(point.x, point.y, spec, {x:spec.dpi,y:spec.dpi})
            if !(g.x >= spec.left && g.y >= spec.top && g.x+g.width <= spec.right && g.y+g.height <= spec.bottom)
                failed += 1
        }
    }
    return failed
}
