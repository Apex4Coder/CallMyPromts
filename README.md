# CallMyPromts · Paper

Windows mini-CRM for local prompts with a tray panel and Ctrl+Shift+Q pinned menu.

## Release candidate

This is a candidate for owner acceptance, not a claim of completed live acceptance.
Tests on the development Windows machine: 984 unit/API passed, 1 symlink test skipped; 237 browser E2E passed; six project gates passed. The owned native CRM window was measured at 780×520 and reused near the taskbar work area. Real paste, animation feel, three physical monitors and clean-machine installation still need owner acceptance.

## Download

Download CallMyPromts.exe from Releases. Keep its AutoHotkey source ZIP, SHA256SUMS and THIRD-PARTY-NOTICES.md together for redistribution. No Node, AutoHotkey or .NET runtime installation is required. Microsoft Edge is required for the native app window. The EXE is unsigned; Windows may show SmartScreen.

## Data and backup

Your prompts and clipboard history remain local. Settings → Cloud provides a named JSON backup and explicit restore without an account; this is a file backup, not automatic cloud sync. It contains only UI, order and hotkeys. Google Drive is optional and not configured in this candidate: a publisher-owned Desktop OAuth client registration is required before browser sign-in can work. No borrowed client ID is bundled.

## Build and test

Use Node 24 on Windows and AutoHotkey v2 for source execution. Run npm ci, npx playwright install chromium, npm run test:all and npm run gate. Build with node packaging/build.cjs on Windows with .NET 8 SDK and the documented Node/AutoHotkey build inputs; see docs/STANDALONE.md. No private prompts, state, pairing identities or working-session reports are included in this repository.

## License

Project source: MIT (LICENSE). Bundled runtimes retain their own licenses.
