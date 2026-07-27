# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A Chrome Extension (Manifest V3) that automates job applications on Chinese recruitment platforms — currently **Boss直聘** (zhipin.com) and **猎聘** (liepin.com). It parses job listings, matches them against uploaded PDF/DOCX resumes using local heuristics or remote AI (OpenAI/DeepSeek compatible APIs), and auto-sends greeting messages. Built with React 18 + TypeScript, Vite 5 + `@crxjs/vite-plugin`, Tailwind CSS 3, and Dexie (IndexedDB).

## Commands

```bash
npm install              # Install dependencies
npm run dev              # Dev mode with HMR (load dist/ as unpacked extension)
npm run build            # Type-check (tsc -b) then production bundle (vite build)
npm run lint             # ESLint
npm test                 # Full build + vitest run (includes Playwright e2e tests)
```

After `npm run build`, load the `dist/` directory as an unpacked extension at `chrome://extensions/`.

### Running a single test

```bash
npx vitest run tests/local-matcher.test.ts
```

E2e tests (`tests/extension-flow.test.ts`) require a full `npm run build` first and launch Chromium via Playwright loading the built extension. They can be slow (each test 15-60s).

## Architecture

### Four extension contexts

| Context | Entry | Purpose |
|---------|-------|---------|
| **Background** (Service Worker) | `src/background/index.ts` | Alarm scheduling (daily reset, interview reminders), message relay between popup/content, persisting applications to IndexedDB |
| **Content Script** | `src/content/index.ts` | Injected into zhipin.com / liepin.com pages. Owns the core apply loop: scroll-collect jobs → filter → AI match → click buttons → fill greetings. Communicates with the floating panel via `window.postMessage` and with popup via `chrome.runtime.sendMessage` |
| **Popup** | `src/popup/` | Extension toolbar popup (resume upload/management, dashboard, settings, tracker, one-click "start applying" button that messages the content script) |
| **Options** | `src/options/` | Full-page settings (Dashboard, Settings, Blacklist, Export, Interview Calendar) |

### Platform adapter pattern

Multi-platform support is abstracted through the `PlatformAdapter` interface ([src/shared/platform/types.ts](src/shared/platform/types.ts)). Each platform (boss, liepin) implements ~12 methods: `matchesUrl`, `detectPageType`, `parseJobCardsFromSearchPage`, `collectJobCards` (scroll/pagination), `activateJobCard`, `clickApplyButton`, `fillGreetingMessage`, `getJobSpecificGreeting`, `snapshotCommunicationUi`, `getRiskConfig`, etc.

The `PlatformManager` ([src/shared/platform/index.ts](src/shared/platform/index.ts)) auto-detects the platform by URL or respects a manual override stored in settings. `getActivePlatform()` is the single entry point — the content script never branches on platform name.

To add a new platform, create `src/shared/platform/<name>/`, implement `PlatformAdapter`, and register it in `src/shared/platform/index.ts`.

### Cross-context data flow

The extension has two storage layers with different scopes:

- **chrome.storage.local** — shared state accessible from all contexts. Used for resume metadata/summary + full resume (minus ArrayBuffer `fileData`), applied job IDs, and daily counters. See [src/shared/db/shared-state.ts](src/shared/db/shared-state.ts).
- **IndexedDB (Dexie)** — `BossZhipinDB` in [src/shared/db/index.ts](src/shared/db/index.ts). Stores resumes (with binary `fileData`), applications, blacklist, interview events, and key-value settings. Accessible from extension contexts (popup, options, background) but **not** from content scripts (which use the page's origin).

The content script fetches resume data from `chrome.storage.local` first, falling back to asking the background worker via `chrome.runtime.sendMessage({ type: 'GET_DEFAULT_RESUME' })` which reads IndexedDB and syncs to `chrome.storage.local`.

### Content script floating panel

`src/content/inject-ui.tsx` creates a draggable floating panel (`#boss-assistant-panel`) using Shadow DOM. The panel communicates with the content script's apply loop via `window.postMessage` (types: `BOSS_ASSISTANT_START_APPLY`, `BOSS_ASSISTANT_STOP_APPLY`, `BOSS_ASSISTANT_CHANGE_MODE`, `BOSS_ASSISTANT_CHANGE_SCORING`). The panel is purely presentational — all DOM interaction and AI logic runs in `src/content/index.ts`.

### AI matching pipeline

Two-tier matching in `src/shared/ai/`:
1. **Local matcher** ([local-matcher.ts](src/shared/ai/local-matcher.ts)) — fast keyword/skill overlap scoring. Always runs.
2. **Remote matcher** ([remote-matcher.ts](src/shared/ai/remote-matcher.ts)) — calls LLM API for deeper analysis. Gated by user settings.

The content script can bypass AI scoring entirely (`enableAiMatch: false` → `scoreBypassed: true`) for direct-apply mode.

### Anti-bot / safety

`src/shared/antiBot/` provides `randomDelay`, `scanRisk` (detects rate-limit/block/captcha markers in page text using platform-specific configs from `PlatformRiskConfig`), daily rate limiting via `chrome.storage.local` counters, and human-like behavior simulation (scroll, typing, mouse moves).

### Key shared modules

| Module | Purpose |
|--------|---------|
| `src/shared/types/` | TypeScript interfaces: `JobCard`, `Resume`, `MatchResult`, `ApplyFilters`, `Application`, message types |
| `src/shared/db/` | Dexie DB definition + per-store accessors (resume-store, application-store, settings-store, etc.) |
| `src/shared/parser/` | PDF text extraction (pdfjs-dist) and DOCX parsing (mammoth), structured data extraction |
| `src/shared/export/` | CSV/Excel export of application records |
| `src/shared/utils/` | Logging (with `logGroup`/`logGroupEnd` wrappers), date formatting, messaging helpers |

### Path alias

`@` resolves to `src/` (configured in [vite.config.ts](vite.config.ts) and `tsconfig`).

### Platform-specific DOM selectors

Boss直聘 selectors live in `src/shared/platform/boss/parser.ts` and `action-simulator.ts`. Per CONTRIBUTING.md, annotate selectors with status markers: `🕐 已过期` (outdated), `需要验证` (needs verification), `✅ 已验证` (verified), `🔧 候选方案` (alternative). Boss直聘 frequently changes DOM structure — selector rot is the most common source of bugs.
