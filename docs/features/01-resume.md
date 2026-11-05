# 01 · 简历解析与求职画像

> 一句话职责：把一份 PDF/Word 简历变成「可被评分与投递调用的结构化对象」，并生成 AI 求职画像。

---

## 用户视角流程

1. 简历管理 → 上传 PDF / Word（也支持粘贴文本）。
2. 本地解析出原文 → 抽取结构化字段（基本信息、技能、项目、工作经历、教育）。
3. 勾选「设为默认简历」→ 后续投递都用它。
4. 可选：AI 生成求职画像（期望岗位、技能等级、优势短板），作为评分与打招呼语的上下文。
5. 可选：配置底线（最低薪资、排除公司、到岗时间）与自主授权契约。

---

## 关键实现

| 环节 | 文件 | 说明 |
|---|---|---|
| PDF 解析 | `src/shared/parser/pdf-parser.ts` | `pdfjs-dist`，逐页取文本 |
| Word 解析 | `src/shared/parser/word-parser.ts` | `mammoth` 转 HTML/文本 |
| 结构化抽取 | `src/shared/parser/structure-extractor.ts` | 技能等级、项目、经历；依赖 `skills-dict.ts` 技能词典 |
| 本地质量分析 | `src/shared/ai/resume-analyzer.ts` | 先本地算完整度/缺失项，再可选让 AI 补充建议 |
| AI 画像 | `src/shared/ai/resume-enricher.ts` | 生成 `ResumeProfile`（期望岗位、技能等级、亮点） |
| 存储 | `src/shared/db/resume-store.ts` | 原文经 `vault.encryptText` 加密后落 `resumes` 表 |
| 画像沉淀 | `src/shared/db/career-store.ts` | 职业状态、技能、提升方向（加密存 `careerProfiles`） |

---

## 数据

- 表：`resumes`（索引 `isDefault`、`createdAt`）、`careerProfiles`。
- 类型：`src/shared/types/resume.ts`（`Resume`、`ResumeAnalysis`、`ResumeProfile`）。
- 加密：`enc:v1:<iv>:<cipher>` 格式；无前缀老数据透传，不做一次性迁移。

---

## 依赖的配置

| 配置 | 用途 | 缺省行为 |
|---|---|---|
| `aiEnabled` + `apiKey` | AI 画像、简历优化建议 | 关闭时只做本地规则分析，页面明确标注"本地分析" |
| `aiDailyBudget` | 画像/分析消耗预算 | 超限回退本地，不阻断 |

---

## 边界与降级

- **事实不可改写**：`AuthorizationPolicy.facts.allowRewrite` 恒为 `false`，AI 只能引用简历里已有的事实，画像不允许新增经历。
- 解析失败（扫描版 PDF 无文本层）：提示用户改用文本粘贴，不静默产出空简历。
- 未设默认简历 → 投递前置检查直接拦截，提示去设置，不会盲投。

---

## 改动指南

- 加新文件格式：实现 `parser/` 下新的解析器，在 `parser/index.ts` 导出，在 `Resumes` 页的 accept 列表与分支里接入。
- 改技能词典：`src/shared/parser/skills-dict.ts`，会同时影响本地评分与结构化抽取。
- 相关测试：`tests/resume-enricher.test.ts`、`tests/resume-router.test.ts`、`tests/experience-store.test.ts`、`tests/h1-vault.test.ts`。
