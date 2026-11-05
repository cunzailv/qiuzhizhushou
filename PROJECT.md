# Project: 自愈韧性智能体架构 (Self-Healing Resilient Agent Architecture)

## Architecture
自愈韧性智能体架构旨在为智能求职助手 Chrome 扩展提供面对 DOM 变动、反爬遮罩、类名混淆及复杂运行时异常下的全流程自愈兜底能力。
系统分为四大核心能力系统与两大工程主线（Implementation Track 与 E2E Testing Track）：

1. **运行时多阶弹性降级系统 (Multi-Path Fallback & De-blocking)**:
   - 目标卡片激活：常规定位 ➔ 去行政后缀模糊多词匹配 (Fuzzy Multi-Word) ➔ 独立 URL 详情页后台静默跳转直达投递。
   - 按钮点击感知：动态技能缓存 ➔ 预设类名 ➔ 语义黑白名单启发式 ➔ LLM 感知决策 ➔ 本地启发式安全回退。
   - 页面阻塞脱困：扩展 `dismissUnexpectedModals` 规则库与全屏半透明遮罩/滚动锁死强力清除。
2. **本地免发版热修复与技能沉淀系统 (Skill Memory Hot-Patching)**:
   - 动态选择器指纹提取 (`buildSelectorFingerprint`) 与动作链沉淀。
   - 升级 Dexie 数据库至 Version 8，扩展 `agentSkills` 存储结构与 `[platform+goal]` 复合索引。
   - 跨进程（Content Script ↔ Background Service Worker ↔ Extension Pages）同步路由。
   - 投递前优先复用已沉淀技能（Tier 0），实现 0ms 免发版即时自愈。
3. **任务优先连续性保障系统 (Mission-First & Fault Isolation)**:
   - 在 `executeCampaignTask` 建立严格 `try ... finally` 故障隔离边界。
   - 强化无残留现场复原 (`cleanupUi`)：清除残留弹窗、移除遮罩、恢复 body 滚动锁死、失焦活跃元素。
   - 单岗位不可逆异常标记为 `skipped` 并继续投递队列，坚决保障流水线连续性。
4. **事后归因与开发者待修清单系统 (Post-Mortem Diagnostics)**:
   - 定义统一的 `SelfHealingEvent` 与 `DeveloperFixSuggestion` 结构。
   - 本地审计库与错误库 (`db.errors`, `db.auditLogs`) 记录自愈事件。
   - 管家（Butler）扩展面板与后台诊断中心提供结构化待修建议卡片与 Markdown 一键复制。

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | 去行政后缀模糊多词匹配 | 列表常规定位失败时，剥离公司/地名行政后缀并分词匹配 | M2 | R2.1 |
| 2 | 后台 URL 静默跳转直达投递 | 列表完全无法定位目标卡片时，降级为详情页 URL 直接访问投递 | M2 | R2.1 |
| 3 | 按钮语义黑白名单启发式点击 | 预设选择器失效时，基于文本白名单与严格黑名单启发式探测 | M2 | R2.2 |
| 4 | 按钮点击 LLM 感知与决策 | 启发式未命中时，提取候选元素由 LLM 感知并决策沟通按钮 | M2 | R2.2 |
| 5 | 本地启发式安全回退与不阻断保障 | LLM 未配置、超额或调用失败时，平滑回退本地启发式，不抛出异常 | M2 | R2.2 |
| 6 | 页面阻塞脱困与意外弹窗遮罩强力解除 | 升级 dismissUnexpectedModals，自动清除各类弹窗、遮罩并解除滚动锁定 | M2 | R2.3 |
| 7 | 本地技能沉淀与免发版热修复 | 动态选择器指纹与动作链写入 IndexedDB (agentSkills)，后续优先复用 | M1 | R3 |
| 8 | 任务优先保障与单岗位故障隔离 | 建立 try-finally 现场无残留复原 (cleanupUi)，隔离不可逆异常 | M3 | R4 |
| 9 | 自愈绕过事件与拦截根因入库 | 记录自愈绕过事件、拦截原因、绕过手段至本地审计与错误库 | M4 | R5 |
| 10 | 管家开发者待修清单展示与导出 | 管家面板/管理后台集中展示结构化待修建议卡片并支持一键导出 | M4 | R5 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | 存储层升级与技能热修复引擎 | Dexie v8 升级、agentSkills 结构强化、技能沉淀/检索与跨进程同步 | none | ✅ DONE |
| M2 | 运行时多阶弹性降级与脱困体系 | 卡片模糊多词与 URL 直达、按钮语义启发式与 LLM 感知、弹窗遮罩解除 | M1 | ✅ DONE |
| M3 | 任务优先保障与单岗位故障隔离 | executeCampaignTask try-finally 边界、cleanupUi 现场无残留复原 | M2 | ✅ DONE |
| M4 | 事后归因与管家开发者待修清单 | 自愈事件记录与查询、管家/后台开发者待修建议视图与导出 | M1, M2, M3 | ✅ DONE |
| M5 | 全量自动化测试验收与对抗性加固 | 100% 通过 E2E 完整套件 (Tiers 1-4) + Tier 5 白盒对抗性测试加固 | M1, M2, M3, M4 | ✅ DONE |

> **验收基线（2026-11-05，commit `bd7464a`）**：`npx vitest run` 51 文件 / 697 用例全绿；`npx tsc -b` 零 error；`npm run build` 零构建错误。M1–M5 已全部合并至 `main` 并推送 GitHub。
>
> **质量收尾基线（2026-11-05）**：`npx vitest run tests` 53 文件 / 718 用例全绿；`npm run lint` 0 error；`npx tsc -b` 0 error；`npx vite build` success。补齐猎聘测试覆盖与 CI 可靠性修复后重新验收。
>
> **统一控制基线（2026-11-05，v1.1.1）**：新增 F 层「悬浮窗 / AIbot 统一控制状态」，页面浮窗与后台 campaign 共用 `assistant-state` 单一真源；悬浮窗支持右侧收缩三态、配置页双向同步、关闭即终止 bot 与当前任务。`npx vitest run tests` 54 文件 / 728 用例全绿；`npm run lint` 0 error；`npx tsc -b` 0 error；`npx vite build` success。

---

## Interface Contracts

### M1 ↔ M2: Skill Memory Hot-Patching Contract
- `findBestSkill(platform: string, pageType: string, goal: string): Promise<AgentSkill | null>`
- `upsertSkill(params: { platform: string, pageType: string, goal: string, steps: AgentStep[], selectorSignature: string, patchSource?: SkillPatchSource, remediationNotes?: string }): Promise<AgentSkill>`
- `recordSkillFail(skill: AgentSkill): Promise<void>`
- `buildSelectorFingerprint(el: Element, container?: Element): string`

### M2 ↔ M3: Action & Cleanup Contract
- `clickApplyButtonWithResilience(jobCard: HTMLElement, context: { platform: string, jobTitle: string, company: string, allowLlm?: boolean }): Promise<{ success: boolean, path: string, usedSkill?: AgentSkill }>`
- `activateJobCardWithFallback(jobUrl: string, jobId: string, title: string, company: string): Promise<HTMLElement | null>`
- `dismissUnexpectedModals(doc?: Document): boolean`
- `cleanupUi(adapter?: PlatformAdapter): Promise<void>`

### M2/M3 ↔ M4: Diagnostics & Event Logging Contract
- `recordSelfHealingEvent(event: Omit<SelfHealingEvent, 'id' | 'createdAt'>): Promise<SelfHealingEvent>`
- `listSelfHealingEvents(limit?: number): Promise<SelfHealingEvent[]>`
- `getDeveloperFixSuggestions(): Promise<DeveloperFixSuggestion[]>`（契约兼容别名 `getDiagnosticFixRecommendations`）
- `clearSelfHealingEvents(): Promise<void>`
- 存储复用 `db.auditLogs`（`source='self_healing'`），Dexie 保持 v8；事件上限 500 条；所有 DB 异常静默降级，不阻断业务

---

## Code Layout
- `src/shared/types/diagnostics.ts`: `SelfHealingEvent`, `DeveloperFixSuggestion`, `SelfHealingCategory`
- `src/shared/agent/types.ts`: `AgentSkill`, `SelectorFingerprint`, `SkillPatchSource`
- `src/shared/agent/skill-memory.ts`: `findBestSkill`, `upsertSkill`, `recordSkillFail`, `buildSelectorFingerprint`
- `src/shared/db/index.ts`: Dexie v8 migration with `agentSkills` compound indexes
- `src/shared/types/diagnostics.ts`: `SelfHealingEvent`, `DeveloperFixSuggestion`, `SelfHealingCategory`, `CATEGORY_FIX_TEMPLATES`, `ALL_SELF_HEALING_CATEGORIES`
- `src/shared/db/diagnostics-store.ts`: `recordSelfHealingEvent`, `listSelfHealingEvents`, `getDeveloperFixSuggestions`, `getDiagnosticFixRecommendations`, `clearSelfHealingEvents`
- `src/shared/platform/boss/action-simulator.ts`: `fuzzyMultiWordMatch`, `activateJobCardWithFallback`, `clickApplyButtonWithResilience`, `dismissUnexpectedModals`（7 处诊断埋点）
- `src/content/task-runner.ts`: `executeCampaignTask` (try-finally), `cleanupUi` (exported & fortified)
- `src/background/index.ts`: Message router for skills and diagnostics
- `src/popup/pages/Butler.tsx`: 独立 `fixes` subtab「开发者待修清单」+ 一键复制 Markdown
- `tests/`: Unit and integration test suites:
  - `tests/self-healing-card.test.ts`
  - `tests/self-healing-button.test.ts`
  - `tests/self-healing-modal.test.ts`
  - `tests/self-healing-skill.test.ts`
  - `tests/self-healing-mission.test.ts`
  - `tests/self-healing-diagnostics.test.ts`
  - `tests/adversarial-m3-stress.test.ts`
  - `tests/adversarial-m4-stress.test.ts`
  - `tests/e2e-self-healing.test.ts`
