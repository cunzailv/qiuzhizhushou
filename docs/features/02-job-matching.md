# 02 · 岗位采集 / 过滤 / AI 评分 / 打招呼

> 一句话职责：把页面上的岗位卡片变成「有分数、有理由、有开场白」的可投递对象。

---

## 四步链路

```
采集 job-discovery → 过滤 job-filter → 评分 remote-matcher → 开场白 greeting
                                              ├─ AI: semantic-matcher（主）
                                              └─ 本地: local-matcher（兜底）
```

### 1. 采集（`src/shared/agent/job-discovery.ts`）

- 滚动页面持续收集卡片，直到 `maxScanCount`（保守档 20，0 = 不限）或页面无新增。
- 每张卡片解析为 `JobCard`：标题、公司、薪资、城市、经验/学历、标签、JD 摘要。

### 2. 过滤（`src/shared/agent/job-filter.ts`）

按「简历职业画像 + 用户筛选偏好」硬过滤，不消耗 AI 额度：

- 薪资区间（`parseSalaryRange` 统一解析"15-25K·15薪"）
- 城市 / 关键词必须命中、排除词命中即剔除
- 公司黑名单（`blacklist` 表）
- 岗位标题与目标岗位相关度

### 3. 评分

| 层 | 文件 | 说明 |
|---|---|---|
| 入口 | `src/shared/ai/remote-matcher.ts` | 决定走 AI 还是本地 |
| AI 评分 | `src/shared/ai/semantic-matcher.ts` | 输出 `MatchResult`：总分、维度分（技能/经验/薪资/行业）、缺口、亮点 |
| JD 解析 | `src/shared/ai/jd-analyzer.ts` | 先抽 JD 要求，再逐条比对，降低"整体印象分"偏差 |
| 本地评分 | `src/shared/ai/local-matcher.ts` | 技能词典命中 + 角色关键词 + 语义相似度（`semantic-refine`），零成本、离线可用 |
| 深度分析 | `src/shared/ai/job-match-analyzer.ts` | 单岗位深度报告：差距 → 行动清单（A4） |

**阈值**：`AuthorizationPolicy.strategy.matchThresholdMin`（默认 60）以下的岗位不投；`enableAiMatch=false` 时跳过评分直接投（用户显式选择）。

### 4. 打招呼语（`src/shared/ai/greeting.ts`）

- 输入：岗位 JD + 简历要点 + 匹配亮点 → 输出 2-3 句个性化开场白。
- 三重降级：LLM 定制 → 超时熔断（默认短超时）→ 模板兜底（按岗位标题/技能拼接），**永不返回空串**。
- HR 追问应答：`src/shared/ai/hr-copilot.ts` 内置经典追问库（薪资、到岗、离职原因…），并与用户底线联动——命中 `forbidTopics`（如薪资流水、家庭情况）时不生成，改为提示用户手动处理。

---

## 依赖的配置

| 配置 | 影响 |
|---|---|
| `maxScanCount` | 单次采集上限（安全阀档位控制） |
| `enableAiMatch` | 是否用 AI 评分 |
| `applyMode` | `recommend` = 评分后确认；`batch` = 批量直投 |
| `aiDailyBudget` | AI 评分/开场白的预算上限 |
| 简历画像 + 底线 | 过滤与评分的事实基础 |

---

## 边界

- 采集只读页面已渲染的公开信息，不调用平台私有接口。
- 生成内容只允许引用简历事实；`text-sanitizer` 会清洗 JD 文本，防止 JD 内的指令注入污染 prompt。
- AI 全链路失败时业务不退化为"乱投"：评分缺失 → 走本地分；开场白缺失 → 模板；仍不满足阈值 → 不投。

---

## 改动指南

- 调过滤规则：`job-filter.ts`（纯函数，易单测）。
- 加评分维度：`MatchDimensions`（`types/job.ts`）+ `semantic-matcher` 的 prompt + `local-matcher` 的权重，三处需同步。
- 相关测试：`local-matcher`、`semantic-matcher`、`jd-analyzer`、`job-discovery`、`job-match-analyzer`、`hr-copilot`、`resume-router`。
