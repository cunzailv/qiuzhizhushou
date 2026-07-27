# Scoring and Floating Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local job scores reflect the actual card metadata and make the BOSS floating panel draggable, viewport-safe, and complete after reopening.

**Architecture:** Build a richer `jobDescription` from already-visible card fields and tokenize mixed Chinese/English text inside the pure local matcher. Keep one floating-panel host alive for the page lifetime; hide and restore it instead of recreating it, and isolate pointer dragging and viewport clamping inside `inject-ui.tsx`.

**Tech Stack:** TypeScript 5.6, React 18, Chrome Extension Manifest V3, Vitest 2, Playwright 1.60, Shadow DOM.

## Global Constraints

- Do not lower the default 60-point matching threshold.
- Do not add background requests for every job detail page.
- Do not increase automatic application frequency.
- Real-browser verification must not submit any job application.
- The current project has no `.git` directory, so commit steps are replaced by explicit test checkpoints.

---

### Task 1: Rich Job Matching Text

**Files:**
- Modify: `src/content/dom-parser.ts`
- Modify: `src/shared/ai/local-matcher.ts`
- Create: `tests/local-matcher.test.ts`
- Modify: `tests/extension-flow.test.ts`

**Interfaces:**
- Consumes: `JobCard`, `Resume`, and the existing `computeLocalMatch(resume, job): MatchResult`.
- Produces: `buildJobMatchingText(fields): string` in `dom-parser.ts` and mixed-language tokenization internal to `local-matcher.ts`.

- [ ] **Step 1: Write a failing local matcher test**

Create `tests/local-matcher.test.ts` with a representative resume and two jobs. One job contains matching React/TypeScript/前端 metadata; the other contains Java/Spring/后端 metadata. Assert that the matching job scores at least 60 and scores at least 20 points above the unrelated job.

```ts
expect(computeLocalMatch(resume, matchingJob).score).toBeGreaterThanOrEqual(60)
expect(computeLocalMatch(resume, matchingJob).score - computeLocalMatch(resume, unrelatedJob).score)
  .toBeGreaterThanOrEqual(20)
```

- [ ] **Step 2: Add a failing browser parsing assertion**

In `tests/extension-flow.test.ts`, serve a card without `.job-detail` but with `.job-tag` elements containing `React` and `TypeScript`. Start recommend-mode analysis and assert the rendered score is greater than the resume-only base score of 14.

```ts
const panelText = await page.locator('#boss-assistant-panel').evaluate(
  (host) => host.shadowRoot?.textContent ?? '',
)
expect(panelText).not.toContain('14分')
expect(panelText).toMatch(/[6-9]\d分/)
```

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
npx vitest run tests/local-matcher.test.ts tests/extension-flow.test.ts -t "card metadata|local matcher"
```

Expected: the matcher score remains at the base score and/or the browser panel contains `14分`.

- [ ] **Step 4: Build complete card matching text**

In `src/content/dom-parser.ts`, add a pure helper:

```ts
export function buildJobMatchingText(fields: {
  title: string
  companyName: string
  salary: string
  location: string
  experience: string
  education: string
  tags: string[]
  description: string
}): string {
  return [
    fields.title,
    fields.companyName,
    fields.salary,
    fields.location,
    fields.experience,
    fields.education,
    ...fields.tags,
    fields.description,
  ].map((value) => value.trim()).filter(Boolean).join(' ')
}
```

Use this helper for every parsed card instead of the current description-only fallback.

- [ ] **Step 5: Add mixed Chinese/English tokenization**

In `src/shared/ai/local-matcher.ts`, replace whitespace-only splitting with a pure tokenizer that:

- lowercases English tokens;
- retains `+`, `#`, `.`, and `/` inside technical tokens;
- extracts contiguous Chinese text and emits two-character shingles;
- removes duplicate tokens.

Use the resulting sets for Jaccard similarity and keep the existing 30-point maximum. Build the resume comparison text from summary, skills, positions, work descriptions, education major, and project descriptions rather than summary alone.

- [ ] **Step 6: Run scoring tests and verify GREEN**

Run:

```bash
npx vitest run tests/local-matcher.test.ts tests/extension-flow.test.ts -t "card metadata|local matcher"
```

Expected: both tests pass, matching and unrelated cards receive materially different scores, and the default threshold remains unchanged.

---

### Task 2: Draggable, Reopen-Safe Floating Panel

**Files:**
- Modify: `src/content/inject-ui.tsx`
- Modify: `tests/extension-flow.test.ts`

**Interfaces:**
- Consumes: existing `createFloatingPanel(): HTMLElement`, `updatePanelContent(host, content)`, and `showPanelToast(host, ...)`.
- Produces: the same public API; closing and reopening must retain the same host identity.

- [ ] **Step 1: Write failing reopen and viewport tests**

Add a browser test that:

1. Stores marker text in `#panel-content`.
2. Clicks `#btn-close`.
3. Confirms the host remains connected but hidden and `#boss-assistant-trigger` is visible.
4. Clicks the trigger.
5. Confirms the same host is visible, marker text remains, and its bounding box fits inside the viewport.

```ts
expect(await host.evaluate((node) => node.isConnected)).toBe(true)
expect(await host.evaluate((node) => getComputedStyle(node).display)).not.toBe('none')
expect(box!.x).toBeGreaterThanOrEqual(8)
expect(box!.y).toBeGreaterThanOrEqual(8)
expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width - 8)
expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height - 8)
```

- [ ] **Step 2: Write a failing drag test**

Dispatch `pointerdown` on `.panel-header`, followed by `pointermove` and `pointerup` on `window`. Assert the host moves and remains clamped when dragged beyond the top-left and bottom-right edges.

```ts
await header.dispatchEvent('pointerdown', { pointerId: 1, clientX: 300, clientY: 100 })
await page.dispatchEvent('body', 'pointermove', { pointerId: 1, clientX: -500, clientY: -500 })
await page.dispatchEvent('body', 'pointerup', { pointerId: 1 })
```

- [ ] **Step 3: Run panel tests and verify RED**

Run:

```bash
npx vitest run tests/extension-flow.test.ts -t "floating panel"
```

Expected: the existing close handler removes the host, the marker disappears, and no drag position change occurs.

- [ ] **Step 4: Preserve one host across close and reopen**

Change the close handler to hide the host and create a single trigger. Change the trigger handler to remove itself, reset minimized state, show the existing host, restore full panel/body/filter display, and clamp it to the viewport. `createFloatingPanel()` must return an existing connected host instead of removing and recreating it.

- [ ] **Step 5: Implement pointer dragging and clamping**

Add internal helpers in `inject-ui.tsx`:

```ts
function clampPanelToViewport(host: HTMLElement): void
function installPanelDragging(host: HTMLElement, header: HTMLElement): void
function restoreFloatingPanel(host: HTMLElement): void
```

Use an 8-pixel viewport margin, ignore pointer starts inside `.header-actions`, set `left` and `top` during movement, clear `right`, and release capture on `pointerup`/`pointercancel`.

- [ ] **Step 6: Make dimensions viewport-safe**

Set host maximum width to `calc(100vw - 16px)`. Set `.panel` to `max-width: calc(100vw - 16px)` and `max-height: calc(100vh - 16px)`. Make `.panel` a column flex container and `.panel-body` use `min-height: 0; overflow-y: auto; flex: 1`, while retaining a reasonable 420-pixel content cap on large screens.

Install one `resize` listener that reclamps the connected host. Remove any duplicate trigger before creating a new one.

- [ ] **Step 7: Run panel tests and verify GREEN**

Run:

```bash
npx vitest run tests/extension-flow.test.ts -t "floating panel"
```

Expected: drag, boundary, close, reopen, content preservation, and viewport sizing assertions all pass.

---

### Task 3: Full Regression and Real Chrome Verification

**Files:**
- Verify: `public/manifest.json`
- Verify: `dist/manifest.json`
- Verify: all files changed in Tasks 1–2

**Interfaces:**
- Consumes: built extension in `dist`.
- Produces: evidence that the extension works in automated and current-user Chrome without applying to a real job.

- [ ] **Step 1: Run static and full automated checks**

Run:

```bash
npm run build
npm run lint
npm test -- --reporter=verbose
```

Expected: TypeScript build passes, ESLint reports no errors, and every browser test passes.

- [ ] **Step 2: Reload the unpacked extension in Chrome**

Open `chrome://extensions`, locate “Boss直聘智能求职助手”, and click its existing reload button. Refresh the BOSS jobs tab so the current content script is active.

- [ ] **Step 3: Verify scoring safely**

Use recommend-confirm mode or a deliberately impossible job-title filter so no communication button can be submitted. Start analysis and confirm:

- scores are not all identical;
- cards with visible matching tags receive higher scores;
- no application record or sent greeting is created.

- [ ] **Step 4: Verify floating panel interaction**

On the real BOSS tab:

- drag the panel from the title bar;
- drag it toward each viewport edge and confirm it stays visible;
- close it and reopen it from the trigger;
- confirm the result list and filters remain complete;
- resize the window or use a smaller viewport and confirm the body scrolls without clipping.

- [ ] **Step 5: Restore user state**

Remove temporary impossible filters, leave the BOSS tab open, and ensure the extension remains enabled.

- [ ] **Step 6: Completion audit**

Compare the final runtime evidence against every acceptance criterion in `docs/superpowers/specs/2026-07-26-scoring-and-floating-panel-design.md`. Do not mark complete unless each scoring, drag, viewport, reopen, regression, and no-real-application requirement has direct evidence.
