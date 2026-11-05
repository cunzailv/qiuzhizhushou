import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

// 浏览器 E2E 需要 headed Chromium + 已构建的 dist 扩展。
// SKIP_BROWSER_E2E=1 仅作为本地应急开关：跳过这些套件，逻辑/单测照常执行。
// CI 固定 ubuntu-24.04 并完整执行这些套件，Chromium 装不上会直接让 job 失败。
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

// GitHub runner 的 CPU / 图形栈较弱，CI 上单线程跑避免多个 headed Chromium 抢占资源
const maxThreads = process.env.CI ? 1 : 2

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
    maxThreads,
    minThreads: 1,
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads,
      },
    },
  },
})
