# 贡献指南

感谢你对智能求职助手的关注！欢迎任何形式的贡献。

## 如何贡献

### 报告 Bug

1. 使用 [Bug Report](https://github.com/cunzailv/qiuzhizhushou/issues/new?template=bug_report.yml) 模板
2. 描述清晰的操作步骤和期望行为
3. 提供浏览器版本、操作系统等环境信息

### 功能建议

1. 使用 [Feature Request](https://github.com/cunzailv/qiuzhizhushou/issues/new?template=feature_request.yml) 模板
2. 描述功能的价值和使用场景
3. 如有设计思路，欢迎附加

### 提交代码

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/your-feature`
3. 安装依赖：`npm install`
4. 开发并确保代码通过检查：
   ```bash
   npm run lint
   npm run build
   npm test
   ```
5. 提交 commit，遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式
6. Push 并创建 Pull Request

### 开发约定

- **TypeScript 严格模式**：避免 `any`，使用明确的类型定义
- **React 组件**：使用函数组件 + Hooks
- **平台适配器**：新增平台在 `src/shared/platform/<name>/` 下实现 `PlatformAdapter` 接口
- **测试**：核心逻辑应有单元测试，端到端测试放在 `tests/` 目录

### 选择器标注

针对招聘平台 DOM 选择器，请在代码中标注：

- 🕐 已过期
  
- 需要验证
  
- ✅ 已验证
  
- 🔧 候选方案

  ```typescript
  const JOB_CARD_SELECTOR = '.job-list-box .job-card' // 需要验证
  ```

## 本地开发

```bash
npm install       # 安装依赖
npm run dev       # 开发模式
npm run build     # 生产构建
```

然后在 `chrome://extensions/` 加载 `dist` 目录。

## 目录结构

```
src/
├── background/     # Service Worker
├── components/ui/  # 共享 UI 组件
├── content/        # Content Script
├── options/        # 完整设置页
├── popup/          # 弹窗页
└── shared/
    ├── ai/         # AI 对接
    ├── antiBot/    # 防封策略
    ├── db/         # 数据库层
    ├── platform/   # 平台适配器
    │   ├── boss/   # Boss 直聘
    │   └── liepin/ # 猎聘
    └── types/      # 类型定义
```

## 协议

贡献的代码将在 [MIT License](LICENSE) 下发布。
