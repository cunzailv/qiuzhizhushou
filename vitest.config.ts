import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

// 浏览器 E2E 需要 headed Chromium + 已构建的 dist 扩展。
// CI 上若 Chromium 下载失败，ci.yml 会写入 SKIP_BROWSER_E2E=1，
// 此时仅跳过这些套件，其余逻辑/单测门禁照常执行；本地运行不受影响。
const BROWSER_E2E_SUITES = [
  '**/tests/aibot-browser-e2e.test.ts',
  '**/tests/butler-flow.test.ts',
  '**/tests/e3-confirm-ui.test.ts',
  '**/tests/e4-options.test.ts',
  '**/tests/extension-flow.test.ts',
  '**/tests/f2-agent-ui.test.ts',
  '**/tests/g1-memory-ui.test.ts',
  '**/tests/h2-h5-ui.test.ts',
  '**/tests/multi-platform-flow.test.ts',
  '**/tests/liepin-flow.test.ts',
]

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    exclude: process.env.SKIP_BROWSER_E2E === '1'
      ? [...configDefaults.exclude, ...BROWSER_E2E_SUITES]
      : configDefaults.exclude,
    testTimeout: 30000,
    hookTimeout: 30000,
    maxThreads: 2,
    minThreads: 1,
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 2,
      },
    },
  },
})
