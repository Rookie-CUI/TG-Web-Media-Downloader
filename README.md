# TG Feiji Downloader

[简体中文](README.zh-CN.md)

TG Feiji Downloader is a Manifest V3 browser extension aiming to provide more flexible media file downloads in Telegram Web (TG 飞机网页版).

**Development stage:** behavior and compatibility are still being developed. A successful build does not guarantee every Telegram media source will work. Use only media accessible to your signed-in account and which you are authorized to download.

## Project scope

- Telegram Web page integration and media discovery.
- Individual and selected batch media download workflows.
- Download tasks, progress, pause/resume, and local history.
- Popup, options, side panel, and in-page media controls.
- Local extension storage; no separate product account or subscription is required.

The repository contains Vue 3 and TypeScript source, Vite build configuration, and automated tests. It targets Chromium browsers with Manifest V3 support, including Chrome and Edge. Telegram Web UI changes may affect compatibility.

## Development

Use Node.js 22 or newer with npm. From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` builds the extension before running the tests. `npm run build` creates `dist/`; dependencies and generated output are intentionally excluded from Git.

## Load the extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode and choose **Load unpacked**.
3. Select the generated `dist/` directory.
4. Open or refresh [Telegram Web](https://web.telegram.org/) and sign in through Telegram.
5. After rebuilding, reload the extension and refresh Telegram tabs.

## Source layout

```text
src/
  background/   Extension background worker
  content/      Isolated-world page integration
  telegram/     Telegram adapters and page controls
  downloader/   Download tasks and media validation
  components/   Shared Vue components
  popup/        Popup application
  options/      Settings application
  side-panel/   Side panel application
  storage/      Local settings and history
  exporter/     Export helpers
  types/        Shared types
  utils/        Utilities
  i18n/         Interface labels
public/         MAIN-world page bridge
scripts/        Build script, tests, and synthetic fixtures
```

## Data and permissions

The extension requests Telegram host access, local storage, tab access, side panel support, and declarative network rules. It reads accessible page media and keeps settings and download history in `chrome.storage.local`.

Do not commit session data, real media links, cookies, credentials, personal chat exports, screenshots, or local debug logs. Generic IDs and synthetic test data are part of the source and tests.

This project is not affiliated with Telegram. Actual download completion and playback must be checked in the browser and a media player; automated checks do not establish those outcomes.
