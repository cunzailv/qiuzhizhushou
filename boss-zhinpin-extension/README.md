<p align="center">
  <h1 align="center">🧠 智能求职助手</h1>
  <p align="center">
    多平台 AI 驱动的 Chrome 扩展，自动打招呼、智能投递、简历管理。
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/cunzailv/qiuzhizhushou/stargazers"><img src="https://img.shields.io/github/stars/cunzailv/qiuzhizhushou?style=flat" alt="Stars"></a>
  <a href="https://github.com/cunzailv/qiuzhizhushou/issues"><img src="https://img.shields.io/github/issues/cunzailv/qiuzhizhushou" alt="Issues"></a>
  <img src="https://img.shields.io/badge/platform-Chrome%20|%20Edge-brightgreen" alt="Platform">
  <img src="https://img.shields.io/badge/manifest-v3-blueviolet" alt="Manifest V3">
</p>

---

## ✨ 功能

| 模块 | 说明 |
|------|------|
| 📄 **简历管理** | 上传 PDF / DOCX，自动解析为结构化数据 |
| 🤖 **AI 匹配** | 接入 DeepSeek / OpenAI / 自定义模型，分析岗位与简历匹配度 |
| 🎯 **智能筛选** | 岗位/地点/薪资/学历多维度过滤，关键词排除 |
| 🚀 **一键投递** | 批量自动沟通，支持 Boss 直聘 & 猎聘 |
| 🛡️ **防封策略** | 可配置延迟范围、每日上限、风险评估 |
| 📊 **数据追踪** | 投递记录、面试日历、黑名单管理、Excel 导出 |

## 🎬 快速开始

### 安装

```bash
git clone https://github.com/cunzailv/qiuzhizhushou.git
cd qiuzhizhushou
npm install
npm run build
```

### 加载扩展

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目的 `dist` 目录

### 使用流程

1. 点击扩展图标 → **简历** → 上传 PDF / DOCX 简历
2. 确认简历解析完毕，自动设为默认
3. 打开 **Boss 直聘**或**猎聘**的搜索/推荐页
4. 在扩展 **概览** 中设置筛选条件
5. 点击 **开始投递**，右下角面板实时显示进度
6. 回到 **追踪** 页查看投递记录

## 🏗️ 技术栈

| 层 | 技术选型 |
|----|---------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 + crxjs |
| 样式 | Tailwind CSS 3 |
| 数据 | Dexie (IndexedDB) + chrome.storage |
| AI | OpenAI / DeepSeek / 自定义兼容接口 |
| 测试 | Vitest + Playwright |
| UI 组件 | Lucide React + Recharts |

## 📁 项目结构

```
src/
├── background/         # Service Worker
├── content/            # Content Script（页面注入）
├── popup/              # 弹窗 UI
├── options/            # 完整设置页
├── components/ui/      # 共享 UI 组件
└── shared/
    ├── ai/             # AI 模型对接
    ├── antiBot/        # 防封 & 延迟引擎
    ├── db/             # 数据库 & 状态同步
    ├── platform/       # 多平台适配
    │   ├── boss/       #   Boss 直聘
    │   └── liepin/      #   猎聘
    └── types/          # 全局类型定义
```

## 🔌 接入新平台

1. 在 `src/shared/platform/<name>/` 新建目录
2. 实现 `PlatformAdapter` 接口（约 12 个方法）
3. 在 `src/shared/platform/index.ts` 注册适配器
4. 写测试并校准选择器

参考 `src/shared/platform/liepin/` 的完整实现。

## 🤝 贡献

欢迎任何形式的贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 🐛 [报告 Bug](https://github.com/cunzailv/qiuzhizhushou/issues/new?template=bug_report.yml)
- 💡 [功能建议](https://github.com/cunzailv/qiuzhizhushou/issues/new?template=feature_request.yml)
- 📦 [提交 PR](CONTRIBUTING.md#提交代码)

## ☕ 赞助

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="docs/sponsor-qr.jpg" alt="微信收款码" width="280">
</p>

**微信**：`AQuan12070310`

## ⚠️ 免责声明

本工具仅供学习和技术研究使用。使用自动化功能时请遵守招聘平台的服务条款，合理控制操作频率。使用者对自身行为负责，项目作者不对滥用导致的账号封禁等后果承担责任。

## 📄 协议

[MIT License](LICENSE) © cunzailv
