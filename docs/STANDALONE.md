# Standalone Windows package

`node packaging/build.cjs` builds a self-contained Windows x64 EXE using the installed .NET 8 SDK, Node and AutoHotkey v2 runtimes. Build on Windows; the build may fetch public runtime notices, AutoHotkey corresponding source, and .NET publishing dependencies. No account credentials are requested by the builder.

The distributable is in `dist/standalone/<manifest-id>/`. Publish the EXE **together with** its AutoHotkey source ZIP, third-party notices and SHA256SUMS. Runtime licenses are embedded under `licenses/`. This is not a signed binary: Windows may display SmartScreen. Do not disable Windows protection; signing is a separate release prerequisite if required by the distributor.

On first normal launch the EXE verifies and extracts its allowlisted application payload under `%LOCALAPPDATA%\CallMyPromts\runtime\<payload-hash>`. Persistent settings and prompts live under `%LOCALAPPDATA%\CallMyPromts\shared\`. No original development library, clipboard history, access keys or `.bro` task files are included. Installing a new payload reuses the shared data. Symlinked installation homes are rejected. Microsoft Edge is used for the compact native app window; a default-browser fallback cannot promise native window sizing. Windows 10/11 x64 is the intended target; clean-machine acceptance remains required.

`CallMyPromts.exe --self-test` checks embedded hashes without launching the app or changing user data. It is **not** native insertion, tray, OAuth or multi-monitor acceptance. A source build's hidden-window `tests/native/paper-geometry.ahk` checks monitor clamping without moving the pointer or modifying the clipboard.

Google Drive settings snapshots require a publisher-registered Desktop OAuth client ID and explicit account sign-in in the system browser. No embedded account credentials, third-party application ID or automatic consent are supplied. Snapshots contain interface settings, order and hotkeys, not prompt contents. Donation action remains disabled until the owner's recipient URL is verified.

Do not rerun a build with an unknown outcome: inspect `.bro/build/standalone-status.json`, build logs, the output directory and `packaging/.payload/` first. Publishing is a separate action after tests and release review, never proof of owner acceptance.
