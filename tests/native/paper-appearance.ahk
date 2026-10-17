#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon
#Include %A_ScriptDir%\..\..\bridge\window.ahk
global ROOT := A_Args[2]
global PORT := Integer(A_Args[1]), trace := Map(), before := Map(), owned := []
global output := A_ScriptDir "\..\..\.bro\work\PAPER-APPEARANCE-native-v6.json"
DllCall("SetThreadDpiAwarenessContext", "ptr", -4, "ptr")
for hwnd in WinGetList("ahk_exe msedge.exe")
    before[hwnd] := true
callback := CallbackCreate(WindowEvent, "", 7)
hook := 0
try {
    if FileExist(output)
        throw Error("Previous appearance report exists; inspect before rerun")
    hook := DllCall("SetWinEventHook", "uint", 0x8002, "uint", 0x800B, "ptr", 0, "ptr", callback, "uint", 0, "uint", 0, "uint", 2, "ptr")
    if !hook
        throw Error("Visibility hook unavailable")
    SetTimer SampleWindows, 10
    MonitorGetWorkArea 1, &left, &top, &right, &bottom
    point := {x:right-16,y:bottom+8}, summaries := [], failures := 0
    for spec in [{hash:"#crm",label:"CRM",quick:false}, {hash:"#pins",label:"Закреплённые",quick:true}] {
        if !Open(spec.hash, point)
            throw Error("Fresh owned app window not found")
        title := "CallMyPromts · " spec.label " [" PORT "]"
        hwnd := WinExist(title)
        if !hwnd || DllCall("GetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr") != PORT
            throw Error("Test window ownership not confirmed")
        owned.Push(hwnd)
        Sleep 300
        if !Open(spec.hash, point)
            throw Error("Warm reopen failed")
        Sleep 300
        WinMinimize "ahk_id " hwnd
        if !Open(spec.hash, point)
            throw Error("Minimized restore failed")
        Sleep 200
        WinHide "ahk_id " hwnd
        if !Open(spec.hash, point)
            throw Error("Hidden restore failed")
        Sleep 200
        bounds := MenuWorkArea(point.x, point.y), dpi := MenuDpi(point.x, point.y)
        g := spec.quick ? MenuGeometry(point.x,point.y,bounds,dpi) : CRMGeometry(point.x,point.y,bounds,dpi)
        visible := 0, bad := 0, positions := Map()
        if trace.Has(hwnd) {
            for sample in trace[hwnd] {
                if sample.visible {
                    visible += 1
                    key := sample.x "," sample.y "," sample.w "," sample.h
                    positions[key] := positions.Has(key) ? positions[key]+1 : 1
                    if sample.x != g.x || sample.y != g.y || sample.w != g.width || sample.h != g.height
                        bad += 1
                }
            }
        }
        if visible < 3 || bad > 0
            failures += 1
        rects := []
        for rect, samples in positions
            rects.Push('"' rect '":' samples)
        summaries.Push('{"panel":"' spec.label '","visibleSamples":' visible ',"wrongVisibleBounds":' bad ',"expected":"' g.x ',' g.y ',' g.width ',' g.height '","rectangles":{' Join(rects) '}}')
    }
    for spec in [{hash:"#crm",label:"CRM",quick:false}, {hash:"#pins",label:"Закреплённые",quick:true}] {
        title := "CallMyPromts · " spec.label " [" PORT "]"
        oldHwnd := WinExist(title)
        WinClose "ahk_id " oldHwnd
        Sleep 400
        other := {x:left+40,y:top+100}
        if !Open(spec.hash, other)
            throw Error("Cold reopen failed")
        hwnd := WinExist(title)
        owned.Push(hwnd)
        Sleep 300
        bounds := MenuWorkArea(other.x,other.y), dpi := MenuDpi(other.x,other.y)
        g := spec.quick ? MenuGeometry(other.x,other.y,bounds,dpi) : CRMGeometry(other.x,other.y,bounds,dpi)
        visible := 0, bad := 0, positions := Map()
        if trace.Has(hwnd) {
            for sample in trace[hwnd] {
                if sample.visible {
                    visible += 1
                    key := sample.x "," sample.y "," sample.w "," sample.h
                    positions[key] := positions.Has(key) ? positions[key]+1 : 1
                    if sample.x != g.x || sample.y != g.y || sample.w != g.width || sample.h != g.height
                        bad += 1
                }
            }
        }
        if visible < 3 || bad > 0
            failures += 1
        rects := []
        for rect, samples in positions
            rects.Push('"' rect '":' samples)
        summaries.Push('{"panel":"' spec.label ' cold reopen","visibleSamples":' visible ',"wrongVisibleBounds":' bad ',"expected":"' g.x ',' g.y ',' g.width ',' g.height '","rectangles":{' Join(rects) '}}')
    }
    FileAppend '{"ok":' (failures=0?"true":"false") ',"failures":' failures ',"freshAndWarm":true,"syntheticData":true,"clipboardTouched":false,"videoRecorded":false,"panels":[' Join(summaries) ']}', output, "UTF-8-RAW"
    exitCode := failures ? 1 : 0
} catch Error as err {
    FileAppend err.Message, "*", "UTF-8"
    exitCode := 2
} finally {
    SetTimer SampleWindows, 0
    if hook
        DllCall("UnhookWinEvent", "ptr", hook)
    CallbackFree callback
    DetectHiddenWindows true
    for hwnd in WinGetList("CallMyPromts") {
        if DllCall("GetPropW", "ptr", hwnd, "str", "CallMyPromts.OwnerPort", "ptr") = PORT
            WinClose "ahk_id " hwnd
    }
}
ExitApp exitCode

WindowEvent(hook,event,hwnd,objectId,childId,eventThread,time) {
    if objectId = 0 && childId = 0
        SampleWindows()
}
SampleWindows() {
    for hwnd in WinGetList("ahk_exe msedge.exe") {
        if before.Has(hwnd)
            continue
        try {
            if WinGetClass("ahk_id " hwnd) != "Chrome_WidgetWin_1"
                continue
            WinGetPos &x,&y,&w,&h,"ahk_id " hwnd
            alpha := 255, color := 0, flags := 0
            if WinGetExStyle("ahk_id " hwnd) & 0x80000
                DllCall("GetLayeredWindowAttributes","ptr",hwnd,"uint*",&color,"uchar*",&alpha,"uint*",&flags)
            visible := DllCall("IsWindowVisible","ptr",hwnd) && !DllCall("IsIconic","ptr",hwnd) && alpha > 0
            if !trace.Has(hwnd)
                trace[hwnd] := []
            trace[hwnd].Push({x:x,y:y,w:w,h:h,visible:visible})
        }
    }
}
Join(rows) {
    result := ""
    for row in rows
        result .= (result = "" ? "" : ",") row
    return result
}
Get(path) {
    return ""
}
