; bridge/deck.ahk — мост Windows: хоткеи, буфер, вставка и трей.
#Requires AutoHotkey v2.0
#SingleInstance Force
#Include %A_ScriptDir%\window.ahk
SendMode "Input"
SetWorkingDir A_ScriptDir "\.."

; ---------- Состояние ----------

global ROOT := A_WorkingDir
global PORT := 8791
global TOKEN := ""
global WATCH := true
global LAST_CLIP := ""
global HK_PICKER := "^+q"
global HK_SAVE := "^+s"
global HK_CLIPS := "^!v"
global HK_WATCH := ""
global FAILED := ""

; Окно, в которое пойдёт вставка. Запоминается ДО открытия нашего окна.
global TARGET := 0

ReadToken()
ReadSettings()
ReadPort()
Register()
SetTimer WatchClipboard, 700
; Сервер ждёт подтверждение вставки 700 мс, поэтому опрашиваем каждые 250 мс.
SetTimer PollPaste, 250
SetTimer PollWindow, 500
TrayMenuSetup()

; ---------- Чтение файлов состояния ----------

ReadToken() {
    global TOKEN
    file := ROOT "\state\token"
    if FileExist(file)
        TOKEN := Trim(FileRead(file, "UTF-8"))
}

ReadPort() {
    global PORT
    file := ROOT "\state\runtime.json"
    if !FileExist(file)
        return
    text := FileRead(file, "UTF-8")
    if RegExMatch(text, '"port"\s*:\s*(\d+)', &m)
        PORT := m[1] + 0
}

; Пустой хоткей означает «не назначено» (V-S-5).
ReadSettings() {
    global HK_PICKER, HK_SAVE, HK_CLIPS, HK_WATCH, WATCH
    file := ROOT "\state\settings.json"
    if !FileExist(file)
        return
    text := FileRead(file, "UTF-8")

    HK_PICKER := JsonStr(text, "open_picker", HK_PICKER)
    HK_SAVE := JsonStr(text, "save_clip", HK_SAVE)
    HK_CLIPS := JsonStr(text, "open_clips", HK_CLIPS)
    HK_WATCH := JsonStr(text, "toggle_watch", HK_WATCH)
    WATCH := !InStr(text, '"enabled": false')
}

JsonStr(text, key, fallback) {
    if RegExMatch(text, '"' key '"\s*:\s*"([^"]*)"', &m)
        return m[1]
    return fallback
}

; ---------- Регистрация хоткеев ----------
; Каждая комбинация регистрируется отдельно, неудачи попадают в трей.

Register() {
    global FAILED
    FAILED := ""
    Bind(HK_PICKER, OpenPicker, "открыть выбор")
    Bind(HK_SAVE, SaveSelection, "сохранить выделенное")
    Bind(HK_CLIPS, OpenClips, "открыть журнал")
    Bind(HK_WATCH, ToggleWatch, "пауза слежки")
    Report()
}

Bind(combo, fn, label) {
    global FAILED
    if (Trim(combo) = "")
        return
    try {
        Hotkey combo, fn, "On"
    } catch as err {
        FAILED .= (FAILED = "" ? "" : "; ") label " (" combo "): " err.Message
    }
}

/** Сообщение о состоянии уходит серверу: панель показывает светофор по нему. */
Report() {
    body := '{"hotkeys":{'
        . '"open_picker":' KeyJson(HK_PICKER) ','
        . '"save_clip":' KeyJson(HK_SAVE) ','
        . '"open_clips":' KeyJson(HK_CLIPS) ','
        . '"toggle_watch":' KeyJson(HK_WATCH)
        . '}}'
    Post("/api/hotkeys", body)
    if (FAILED != "")
        TrayTip "CallMyPromts", "Не зарегистрированы: " FAILED, 3
}

KeyJson(combo) {
    if (Trim(combo) = "")
        return '{"combo":"","state":"none","reason":"не назначена"}'
    if InStr(FAILED, "(" combo ")")
        return '{"combo":"' combo '","state":"bad","reason":"занята другим приложением"}'
    return '{"combo":"' combo '","state":"good"}'
}

; ---------- Действия ----------

; Целевое окно запоминается до показа интерфейса.
OpenPicker(*) {
    global TARGET
    TARGET := WinExist("A")
    Open("#pins")
}

OpenClips(*) {
    global TARGET
    TARGET := WinExist("A")
    Open("#clips")
}

; Чтение выделения не должно менять прежний буфер.
SaveSelection(*) {
    saved := ClipboardAll()
    A_Clipboard := ""
    Send "^c"
    if !ClipWait(0.6) {
        ; Ничего не выделено — берём текущее содержимое буфера (S-03, путь 1).
        A_Clipboard := saved
        if (Trim(A_Clipboard) = "") {
            TrayTip "CallMyPromts", "Нечего сохранять: ни выделения, ни буфера", 2
            return
        }
    }
    text := A_Clipboard
    A_Clipboard := saved
    Post("/api/clips", '{"text":' JsonQuote(text) ',"sourceApp":' JsonQuote(ActiveExe()) '}')
    Open("#clips")
}

ToggleWatch(*) {
    global WATCH
    WATCH := !WATCH
    Post("/api/watch", '{"enabled":' (WATCH ? "true" : "false") '}')
    TrayTip "CallMyPromts", WATCH ? "Слежка включена" : "Слежка на паузе", 1
}

; Опрос не ловит собственное восстановление буфера как новое событие.
WatchClipboard() {
    global LAST_CLIP
    if !WATCH
        return
    text := ""
    try text := A_Clipboard
    catch
        return
    if (text = "" || text = LAST_CLIP)
        return
    LAST_CLIP := text
    Post("/api/clips", '{"text":' JsonQuote(text) ',"sourceApp":' JsonQuote(ActiveExe()) '}')
}

; Буфер может быть кратковременно занят, поэтому делаются три попытки.
PasteTo(hwnd, text) {
    ; Refuse an absent target BEFORE touching the clipboard or sending keys.
    if !hwnd || !WinExist("ahk_id " hwnd)
        return false
    saved := ClipboardAll()
    ok := false
    loop 3 {
        try {
            A_Clipboard := text
            ok := true
            break
        } catch {
            Sleep 50
        }
    }
    if !ok {
        TrayTip "Prompt Deck", "Не удалось получить буфер обмена", 2
        return false
    }
    try {
        WinActivate "ahk_id " hwnd
        if !WinWaitActive("ahk_id " hwnd, , 0.4)
            return false
        if !WinActive("ahk_id " hwnd)
            return false
        Send "^v"
        Sleep 120
        return true
    } catch {
        return false
    } finally {
        A_Clipboard := saved
    }
}

; ---------- Связь с сервером ----------

Post(path, body) {
    try {
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("POST", "http://127.0.0.1:" PORT path, true)
        http.SetRequestHeader("Content-Type", "application/json")
        http.SetRequestHeader("X-Deck-Token", TOKEN)
        http.Send(body)
        http.WaitForResponse(2)
    } catch {
        ; Сервис остановлен. Молчим намеренно: всплывающее сообщение на каждое
        ; копирование при выключенном сервисе было бы хуже самой проблемы.
    }
}

; Синхронный GET гарантирует забор текста до ответа интерфейсу.
Get(path) {
    try {
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("GET", "http://127.0.0.1:" PORT path, false)
        http.SetRequestHeader("X-Deck-Token", TOKEN)
        http.Send()
        if (http.Status != 200)
            return ""
        return http.ResponseText
    } catch {
        ; Сервис остановлен — ожидаемое состояние, не ошибка.
        return ""
    }
}

; Одноразовую заявку вставляем в окно, активное до открытия интерфейса.
PollPaste() {
    body := Get("/api/paste")
    if (body = "" || !InStr(body, '"has":true'))
        return
    if !RegExMatch(body, 's)"text"\s*:\s*"(.*)"\s*,\s*"has"', &m)
        return
    if !RegExMatch(body, '"id"\s*:\s*"([a-f0-9-]+)"', &delivery)
        return
    success := PasteTo(TARGET, JsonUnquote(m[1]))
    Post("/api/paste/ack", '{"id":"' delivery[1] '","success":' (success ? "true" : "false") '}')
}

/**
 * Цепочкой StrReplace это не делается ни в каком порядке, и это не вопрос
 * вкуса. Промпт с текстом `\n` (слэш и буква) приходит как `\\n`. Замена
 * `\n` → перевод строки увидит второй слэш вместе с `n` и даст слэш + перевод
 * строки. Обратный порядок сначала сожмёт `\\` до `\`, а следующая замена
 * превратит остаток в перевод строки. Оба результата неверны, поэтому каждый
 * экран разбирается ровно один раз — как его и записали.
 */
JsonUnquote(s) {
    static PAIRS := Map("n", "`n", "t", "`t", "r", "`r", "b", "`b", "f", "`f")
    out := ""
    i := 1
    while (i <= StrLen(s)) {
        c := SubStr(s, i, 1)
        if (c != "\") {
            out .= c
            i += 1
        } else if (SubStr(s, i + 1, 1) = "u") {
            out .= Chr("0x" SubStr(s, i + 2, 4))
            i += 6
        } else {
            e := SubStr(s, i + 1, 1)
            out .= PAIRS.Has(e) ? PAIRS[e] : e
            i += 2
        }
    }
    return out
}

ActiveExe() {
    try return WinGetProcessName("A")
    catch
        return ""
}

/**
 * Экранирование для тела запроса. Слэш первым: иначе слэш, вставленный при
 * экранировании кавычки, сам попал бы под замену и ушёл в данные.
 */
JsonQuote(s) {
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`r`n", "\n")
    s := StrReplace(s, "`n", "\n")
    s := StrReplace(s, "`r", "\n")
    s := StrReplace(s, "`t", "\t")

    ; Остальные управляющие знаки JSON запрещает буквально. Без этой замены
    ; текст с Chr(1) давал бы неразбираемое тело: сервер ответил бы bad_json, а
    ; Post молчит намеренно — запись исчезла бы без следа и без объяснения.
    loop 32 {
        code := A_Index - 1
        if (code = 9 || code = 10 || code = 13)
            continue
        s := StrReplace(s, Chr(code), Format("\u{:04x}", code))
    }
    return '"' s '"'
}

; ---------- Трей ----------

StartService(*) {
    ; После остановки мост остаётся владельцем трея. Новый единый запуск поднимет
    ; Node, дождётся readiness и создаст новый AHK; старый мост затем завершается.
    Run 'node "' ROOT '\bridge\index.mjs"', ROOT, "Hide"
    ExitApp
}

DisableBridge() {
    global WATCH
    WATCH := false
    SetTimer WatchClipboard, 0
    SetTimer PollPaste, 0
    SetTimer PollWindow, 0

    ; Отключаем каждую назначенную комбинацию отдельно: сбой одной не должен
    ; помешать снять остальные горячие клавиши.
    for combo in [HK_PICKER, HK_SAVE, HK_CLIPS, HK_WATCH] {
        if (Trim(combo) = "")
            continue
        try Hotkey combo, "Off"
    }
}

StopService(*) {
    Post("/api/service", '{"action":"stop","confirm":true}')
    DisableBridge()
    TrayTip "CallMyPromts", "Сервис остановлен", 2
    ; Сервер удаляет runtime.json при мягком завершении; после этого меню должно
    ; предложить запуск, а не оставлять недействующие остановку и перезапуск.
    SetTimer TrayMenuSetup, -500
}

RestartService(*) {
    Post("/api/service", '{"action":"restart","confirm":true}')
    ; Новый Node-процесс должен успеть записать runtime.json до перечитывания
    ; порта мостом. Reload также применяет изменённые горячие клавиши.
    Sleep 1000
    Reload
}

ExitWholeApp(*) {
    ; «Выход» завершает обе части приложения, а не оставляет Node в фоне.
    Post("/api/service", '{"action":"stop","confirm":true}')
    DisableBridge()
    ExitApp
}

TrayMenuSetup() {
    running := FileExist(ROOT "\state\runtime.json")
    m := A_TrayMenu
    m.Delete()
    m.Add "Мини-CRM", (*) => Open("#crm")
    m.Add "Открыть выбор", (*) => OpenPicker()
    m.Add "Журнал буфера", (*) => OpenClips()
    m.Add "Настройки", (*) => Open("#deck")
    m.Add
    m.Add "Пауза слежки", (*) => ToggleWatch()
    m.Add "Перечитать настройки", (*) => Reload()
    m.Add
    m.Add "Запустить сервис", StartService
    m.Add "Перезапустить сервис", RestartService
    m.Add "Остановить сервис", StopService
    if running {
        m.Disable "Запустить сервис"
    } else {
        m.Disable "Мини-CRM"
        m.Disable "Открыть выбор"
        m.Disable "Журнал буфера"
        m.Disable "Настройки"
        m.Disable "Пауза слежки"
        m.Disable "Перезапустить сервис"
        m.Disable "Остановить сервис"
    }
    m.Add
    m.Add "Выход", ExitWholeApp
    m.Default := "Мини-CRM"
    m.ClickCount := 1
    A_IconTip := running
        ? "CallMyPromts" (FAILED = "" ? "" : " — есть незарегистрированные хоткеи")
        : "CallMyPromts — сервис остановлен"
}
