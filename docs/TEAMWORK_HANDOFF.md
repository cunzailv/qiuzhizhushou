# 团队模式开发配置 · 自愈韧性智能体架构

> 适用于：Antigravity (AGY) 换账号后快速重建 `/teamwork` 分工
> 其他 AI 平台无子智能体能力时，参考「单智能体串行降级方案」章节

> 📌 **历史归档（2026-11-05）**：M1–M5 已全部完成并推送（commit `bd7464a`）。本文为当时的团队分工配置，仅供追溯，不代表当前待办。

---

## 一、团队角色分工（上次 /teamwork 配置）

### 总体策略
每个里程碑（M3 / M4）启动一次 `/teamwork`，单次团队包含以下角色：

| 角色代号 | 职责 | 对应文件 |
|---------|------|---------|
| **Architect（架构师）** | 读 `PROJECT.md`、`UNFINISHED_PLAN.md`，制定当轮实现方案，分配子任务给其他成员，审查最终 PR | 只读文档，不写代码 |
| **Implementer（实现者）** | 执行核心代码改动（`task-runner.ts`、`action-simulator.ts`、新建 store/types 文件） | 写代码 |
| **Tester（测试者）** | 编写测试文件（`self-healing-mission.test.ts`、`self-healing-diagnostics.test.ts`），运行 `npx vitest run` | 写测试 |
| **Reviewer（审查者）** | 审查 Implementer 的代码，检查边界条件、类型安全、是否破坏现有测试 | 只读代码 |
| **Auditor（审计者）** | 对抗性压测：编写 `adversarial-*.test.ts`，专门找漏洞与边界 bug | 写对抗测试 |

---

## 二、M3 团队提示词（直接粘贴给 /teamwork）

```
我们在开发 Chrome 扩展智能求职助手，代码在 /Users/pc/Desktop/zhipinzhushou。
请先所有成员阅读 docs/UNFINISHED_PLAN.md 和 PROJECT.md 了解背景。

当前任务：实现 M3（任务优先保障与单岗位故障隔离）

## 角色分工

### Architect
- 读 docs/UNFINISHED_PLAN.md M3 章节
- 制定 try-finally 改造方案，明确每个 return 的改造路径
- 审查 Implementer 和 Tester 的输出，确认符合 PROJECT.md 接口契约

### Implementer
文件：src/content/task-runner.ts
任务：
1. 给 executeCampaignTask 加 try-finally 边界（详见 UNFINISHED_PLAN.md Task 3.1）
2. 加强 cleanupUi（Task 3.2）：补充 activeElement 失焦、body.overflow 恢复
3. 保持所有现有测试通过（npx vitest run 验证）

### Tester
文件：tests/self-healing-mission.test.ts（新建）
任务：按 UNFINISHED_PLAN.md Task 3.3 编写 5 个 Suite，共约 15-20 个用例
运行：npx vitest run tests/self-healing-mission.test.ts

### Reviewer
- 检查 try-finally 结构是否正确（TypeScript 不允许 finally 里 return）
- 检查 cleanupUi 是否有 .catch(() => {}) 防止清理异常外溢
- 检查所有现有测试是否仍然通过

### Auditor
文件：tests/adversarial-m3-stress.test.ts（新建）
任务：
- 测试 cleanupUi 内部抛出异常时不影响主链路
- 测试并发多个 executeCampaignTask 时 cleanupUi 不互相干扰
- 测试 adapter 为 undefined 时 cleanupUi 安全返回

## 验收标准
- npx tsc -b 零 error
- npx vitest run tests/self-healing-mission.test.ts 全绿
- npx vitest run（全量）不新增任何失败
```

---

## 三、M4 团队提示词（直接粘贴给 /teamwork）

```
接上一轮，M3 已完成。现在实现 M4（事后归因与开发者待修清单）。
代码在 /Users/pc/Desktop/zhipinzhushou，请先读 docs/UNFINISHED_PLAN.md M4 章节。

## 角色分工

### Architect
- 读 src/shared/types/diagnostics.ts（M4 类型已完成，直接复用）
- 读 src/shared/db/audit-store.ts 和 error-store.ts 了解现有存储模式
- 决定 diagnostics-store.ts 是复用 auditLogs 表还是 errors 表（避免新增 Dexie 版本号）
- 给出最终方案后协调各角色

### Implementer-Backend（后端）
文件1：src/shared/db/diagnostics-store.ts（新建）
- 实现 recordSelfHealingEvent / listSelfHealingEvents / getDeveloperFixSuggestions / clearSelfHealingEvents
- 参考 UNFINISHED_PLAN.md Task 4.2

文件2：src/shared/platform/boss/action-simulator.ts（修改）
- 在 7 个关键埋点接入 recordSelfHealingEvent（见 UNFINISHED_PLAN.md Task 4.3 表格）
- 所有调用：void recordSelfHealingEvent({...}).catch(() => {})

文件3：src/content/task-runner.ts（修改）
- 在 catch 块记录 task_isolated 事件（见 Task 4.4）

### Implementer-UI（前端）
文件：src/popup/pages/Butler.tsx（修改）
- 在 subTab 枚举中添加 'fixes'
- 添加 Tab 按钮（参考现有 'errors' Tab 的写法）
- 新增 fixes 视图：标题栏 + 建议卡片列表 + 一键复制 Markdown（见 Task 4.5）
- 导入 getDeveloperFixSuggestions 并在 useEffect 中调用

### Tester
文件：tests/self-healing-diagnostics.test.ts（新建）
- 按 UNFINISHED_PLAN.md Task 4.6 编写 5 个 Suite，共约 20-25 个用例

### Reviewer
- 检查 diagnostics-store 是否复用现有表（无新增 Dexie 版本号）
- 检查所有埋点调用均有 .catch(() => {}) 防止诊断异常阻断主链路
- 检查 Butler.tsx 是否有 TypeScript 类型错误
- 确认 npm run build 成功

### Auditor
文件：tests/adversarial-m4-stress.test.ts（新建）
- 测试 recordSelfHealingEvent 在 DB 写入失败时不抛出
- 测试 getDeveloperFixSuggestions 在无数据时返回空数组
- 测试 500+ 条事件时自动淘汰最老记录

## 验收标准
- npx tsc -b 零 error
- npx vitest run tests/self-healing-diagnostics.test.ts 全绿
- npx vitest run（全量）不新增任何失败
- npm run build 成功
```

---

## 四、M5 验收提示词（最后一轮）

```
M3 和 M4 均已完成。请执行 M5 全量验收并提交。
代码在 /Users/pc/Desktop/zhipinzhushou。

任务：
1. npx vitest run —— 预期全部通过，记录测试文件数和用例总数
2. npx tsc -b —— 预期零 error
3. npm run build —— 预期零构建错误
4. 如有失败，修复后重新验收
5. 全部通过后：
   git add -A
   git commit -m "feat(self-healing): M3 故障隔离 + M4 诊断归因与开发者待修清单 + M5 全量验收"
   git push origin main
6. 汇报：每个里程碑的测试用例数、build 大小、发现并修复的 bug 列表
```

---

## 五、单智能体串行降级方案（其他 AI / 无子智能体时）

如果换到 ChatGPT、Claude.ai 等不支持子智能体的平台，按以下顺序串行执行：

```
# 第1轮对话：实现 M3
读 /Users/pc/Desktop/zhipinzhushou/docs/UNFINISHED_PLAN.md M3 章节，
实现 Task 3.1-3.3，完成后运行 npx vitest run 验证，输出测试结果。

# 第2轮对话（或继续同一对话）：实现 M4 后端
读 UNFINISHED_PLAN.md M4 章节，实现 Task 4.1-4.4（diagnostics-store + 埋点），
运行 npx vitest run 验证不破坏现有测试。

# 第3轮对话：实现 M4 UI
修改 src/popup/pages/Butler.tsx，添加"开发者待修清单"Tab（Task 4.5），
运行 npm run build 验证。

# 第4轮对话：测试 + 验收
创建 tests/self-healing-mission.test.ts 和 tests/self-healing-diagnostics.test.ts，
全量 npx vitest run + npx tsc -b，全绿后 git add -A && git commit && git push。
```

---

## 六、子智能体能力要求速查

| 能力 | Antigravity (AGY) | ChatGPT | Claude.ai | Cursor |
|------|:-----------------:|:-------:|:---------:|:------:|
| 多子智能体并行 | ✅ `/teamwork` | ❌ | ❌ | ❌ |
| 读写文件 | ✅ | ✅（部分） | ❌ | ✅ |
| 运行终端命令 | ✅ | ✅（部分） | ❌ | ✅ |
| 单智能体串行开发 | ✅ | ✅ | ✅ | ✅ |

> **结论：** 只有 Antigravity/AGY 支持 `/teamwork` 多智能体并行。换账号但还在 AGY 内，直接用上面的团队提示词。换到其他 AI，用串行降级方案，只是开发时间更长（约 2-3 倍）。

---

## 七、换账号后第一件事

```bash
# 在新账号第一条消息前，先在本机终端确认基线：
cd /Users/pc/Desktop/zhipinzhushou
git log --oneline -3
npx vitest run tests/self-healing-skill.test.ts tests/self-healing-button.test.ts \
  tests/self-healing-card.test.ts tests/self-healing-modal.test.ts
# 预期：110 passed

# 然后把上面的 M3 团队提示词粘给新会话的 /teamwork
```
