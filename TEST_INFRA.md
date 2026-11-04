# Test Infrastructure & Opaque-Box E2E Testing Architecture
## 自愈韧性智能体架构 (Self-Healing Resilient Agent Architecture)

---

## 1. Testing Architecture Overview

This document specifies the testing infrastructure, runner contracts, mock sandboxes, and 4-tier opaque-box test suites for the Self-Healing Resilient Chrome Extension Agent.

The test infrastructure is designed around the **Mission-First & Zero-Breakage** principle:
- **Opaque-Box Evaluation**: Tests exercise only external interface contracts, DOM behaviors, and database persistence layers without relying on internal implementation private states.
- **Hermetic Isolation**: Every test execution creates a clean in-memory jsdom DOM tree, an isolated Dexie database instance backed by `fake-indexeddb/auto`, and isolated mock interfaces for Chrome Extension APIs (`chrome.storage.local`, `chrome.runtime`, `chrome.tabs`, `chrome.notifications`).
- **No Residual Side Effects**: Clean teardown after every test ensures zero leaking timers, unhandled promises, or DOM remnants.

```
+---------------------------------------------------------------------------------------+
|                                4-Tier Test Harness                                    |
+---------------------------------------------------------------------------------------+
|  Tier 1: Feature Coverage (>=5 test cases per feature, 10 features = >=50 tests)      |
|  Tier 2: Boundary & Corner Cases (>=5 test cases per feature, 10 features = >=50 tests)|
|  Tier 3: Pairwise Cross-Feature Combinations (Interactions between fallbacks)         |
|  Tier 4: Real-World End-to-End Recruitment Pipelines (Multi-Job Disaster Recovery)    |
+---------------------------------------------------------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------------+
|                               Mock & Sandbox Layers                                   |
+---------------------------------------------------------------------------------------+
|  • jsdom: Virtual DOM with full Event Dispatcher (PointerEvent, MouseEvent, Keyboard)  |
|  • fake-indexeddb: Full in-memory IndexedDB backing Dexie v8 schema (`agentSkills`)    |
|  • Chrome Sandbox: `chrome.storage.local`, `chrome.runtime`, `chrome.tabs` mocks      |
|  • AI Model Sandbox: Mocked `chatCompletion` with instant, retry, and fault injectors  |
+---------------------------------------------------------------------------------------+
```

---

## 2. 10 Feature Inventory & Coverage Mapping

The test harness covers all 10 features defined in `PROJECT.md`:

| # | Feature | Core Capability | Test Tier Coverage |
|---|---------|-----------------|--------------------|
| **F1** | 去行政后缀模糊多词匹配 | Strips company administrative suffixes (有限责任公司, 科技, etc.), location prefixes (深圳, 广州, etc.), and matches multi-word slash/bracket job titles (`技术经理/架构师`, `全栈工程师(AI方向)`). | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F2** | 后台 URL 静默跳转直达投递 | When job card is absent from DOM/virtual-scroll viewport, navigates directly via job detail URL and initializes detail container. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F3** | 按钮语义黑白名单启发式点击 | Probes clickable elements via positive whitelist (`立即沟通`, `继续沟通`, `聊一聊`) while strictly rejecting negative blacklist (`不合适`, `不感兴趣`, `放弃`). | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F4** | 按钮点击 LLM 感知与决策 | When CSS classes and heuristics fail to locate an apply button, extracts candidates into structured snapshot and queries LLM for index/selector decision. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F5** | 本地启发式安全回退与不阻断保障 | When LLM is unconfigured (empty apiKey), rate-limited (HTTP 429), or fails, safely reverts to local heuristic fallback without throwing uncaught exceptions. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F6** | 页面阻塞脱困与意外弹窗遮罩强力解除 | Automatically detects dislike/survey/obstruction dialogs (`不合适的原因`), triggers cancel/close buttons, dismisses overlays, and unlocks `body` scrolling. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F7** | 本地技能沉淀与免发版热修复 | Persists discovered action chains and selector fingerprints into IndexedDB `agentSkills`, enabling 0ms Tier 0 reuse on future runs without extension release. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F8** | 任务优先保障与单岗位故障隔离 | Wraps `executeCampaignTask` in strict `try ... finally` boundaries; executes `cleanupUi` to clean DOM on both success and failure; marks irreversible failure as `skipped` and continues queue. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F9** | 自愈绕过事件与拦截根因入库 | Records all self-healing fallback events, intercept reasons, and applied mitigations into `db.errors` and `db.auditLogs`. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |
| **F10** | 管家开发者待修清单展示与导出 | Synthesizes structured diagnostic fix recommendations (`DeveloperFixSuggestion`) in Butler panel with phenomena, self-healing path, suggested code fix, and Markdown export. | Tier 1 (5), Tier 2 (5), Tier 3, Tier 4 |

---

## 3. 4-Tier Test Harness Methodology

### Tier 1: Feature Coverage (>=5 test cases per feature)
Verifies nominal happy-path behaviors for all 10 features under normal operating assumptions.
- F1: Standard company suffix stripping, city prefix removal, title qualifier normalization, exact match, multi-word partition.
- F2: URL direct navigation detection, detail container detection, query parameter preservation, offline status marking, fallback return.
- F3: Positive text matching, class-based `.btn-startchat` prioritization, container scoping, visible element filtering, click event propagation.
- F4: Candidate extraction, prompt payload formation, LLM decision parsing, mock LLM click execution, decision logging.
- F5: Unconfigured API key fallback, HTTP 429 fallback, malformed JSON fallback, timeout fallback, zero throw guarantee.
- F6: "不合适的原因" modal cancellation, backdrop mask removal, multiple masks cleanup, ESC key dispatch, body overflow restoration.
- F7: `upsertSkill` persistence, `findBestSkill` matching, success count increment, selector fingerprint storage, lastUsedAt update.
- F8: Successful task execution with final cleanup, low score skipping with cleanup, button failure handling with cleanup, campaign status update, task queue continuity.
- F9: Self-healing audit logging, error record storage, context JSON serialization, category classification, recent records retrieval.
- F10: Diagnostic recommendation generation, suggestion card grouping, suggested rule formulation, Markdown format export, empty state handling.

### Tier 2: Boundary & Corner Cases (>=5 test cases per feature)
Verifies defensive resilience under adversarial, malformed, or extreme inputs.
- F1: Empty strings, purely generic words ("网络科技"), zero-width unicode spaces, symbols only, nested brackets.
- F2: Malformed URL formats, non-HTTP protocols, 404/closed job page text, DOM detached right before navigation, infinite redirect loops.
- F3: Mixed keywords ("立即沟通并拒绝"), zero-dimension elements (`offsetWidth === 0`), `display: none` candidates, nested spans, disabled buttons.
- F4: Empty LLM response, index out of range response, JSON syntax error, 500ms timeout simulation, hallucinated non-existent selectors.
- F5: Completely absent `settings` store, network offline (`TypeError: Failed to fetch`), exhausted quota (budget 0), empty prompt fallback.
- F6: Heavily nested modals, stubborn modal refusing click (fallback style.display = none), locked scroll on both `html` and `body`, dynamic modal recreation, SVG close button.
- F7: Expired skills (`expiresAt < now`), high failure count (`failCount >= 3`), disabled skills (`enabled === false`), conflicting skills, schema version upgrade.
- F8: Uncaught error thrown in inner loop, DOM mutation removing target mid-click, missing greeting template, frozen window object, multi-exception cascade.
- F9: Audit log cap (>200 records trimming), invalid non-serializable context, duplicate error deduplication, null fields safety.
- F10: 100+ diagnostic events aggregation stress, empty error store, suggestion deduplication, long error stack trace formatting, special character escaping in Markdown.

### Tier 3: Pairwise Cross-Feature Combinations
Verifies multi-layer interactions where two or more self-healing systems trigger simultaneously:
- Card Fallback + Button Fallback (F1/F2 + F3/F4)
- Unexpected Modal Popup during LLM Fallback (F6 + F4/F5)
- Skill Cache Hit + UI Cleanup Verification (F7 + F8)
- Offline Job Detection + Audit Logging + Safe Skip (F2 + F9 + F8)
- LLM Perception Failure + Local Heuristic Safe Recovery + Skill Hot-Patching (F4 + F5 + F7)
- Persistent Modal Mask Lock + CleanupUi + Next Task Continuation (F6 + F8)

### Tier 4: Real-World Application Scenarios
Simulates realistic end-to-end multi-job recruitment campaigns:
- **Scenario A (5-Job Multi-Tier Failure Campaign)**: A 5-job queue containing 1 clean job, 1 fuzzy-matched job, 1 obfuscated-button job requiring fallback, 1 job obstructed by a dislike modal, and 1 offline job. Verifies that the queue processes all jobs, skips the offline job, cleans up the DOM after every job, logs all audit events, and leaves the campaign in `finished` status with 100% safety score.
- **Scenario B (Skill Hot-Patching Lifecycle)**: First execution encounters unknown DOM structure, uses fallback to discover click target, persists skill; second execution reuses skill memory (Tier 0) in 0ms without executing fallback; third execution respects administrative disabling of skill and seamlessly reverts.
- **Scenario C (Catastrophic Error Isolation)**: Unhandled runtime rejection in delivery phase is strictly caught by `try ... finally`, triggers `cleanupUi`, marks task `skipped`, and permits subsequent tasks to deliver successfully.

---

## 4. Test Environment & Runner

### Prerequisites
- Node.js >= 18
- Vitest 2.1.x
- jsdom
- fake-indexeddb

### Running the E2E Self-Healing Test Suite
```bash
npx vitest run tests/e2e-self-healing.test.ts
```

### Running the Entire Project Verification Suite
```bash
npm test
```
This executes `npm run build && vitest run tests`.

---

## 5. Pass/Fail Exit Criteria
1. `tests/e2e-self-healing.test.ts` compiles with 0 TypeScript errors.
2. All 4 tiers (>115 total test assertions) pass with 100% pass rate.
3. Total execution time for the E2E self-healing suite is under 15 seconds.
4. Zero unhandled promise rejections or leaked timers.
