// F 层后台浏览器验收：智能体页（角色预设 / 提示词编辑 / 技能管理）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext, type Worker, type Page } from 'playwright'
import path from 'node:path'

const extensionPath = path.resolve('dist')
let context: BrowserContext
let serviceWorker: Worker

beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  })
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
})

afterAll(async () => {
  await context?.close()
})

async function openOptions(page: Page): Promise<void> {
  const extensionId = new URL(serviceWorker.url()).host
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`)
  await page.waitForSelector('text=求职数据看板', { timeout: 15_000 })
}

async function openAgentPage(page: Page): Promise<void> {
  await openOptions(page)
  await page.getByText('智能体', { exact: true }).click()
  await page.waitForSelector('text=智能体配置', { timeout: 10_000 })
}

/** 清理测试写入的配置（避免污染用户真实设置） */
async function cleanupSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const chromeStorage: any = (globalThis as any).chrome?.storage?.local
    if (chromeStorage) {
      await chromeStorage.remove(['setting_agentRole', 'setting_prompt_ai.match', 'setting_enableAiMatch', 'setting_applyMode'])
    }
  })
}

describe('F 层智能体配置 E2E', () => {
  it('智能体页：角色三卡片 + 提示词 8 区块 + 技能空态渲染', async () => {
    const page = await context.newPage()
    await cleanupSettings(page)
    await openAgentPage(page)

    // 角色预设
    for (const name of ['激进海投', '保守精投', '自定义']) {
      await page.getByText(name, { exact: true }).waitFor()
    }

    // 提示词编辑（三类分组 + 8 个保存按钮）
    expect(await page.getByText('AI 分析', { exact: true }).count()).toBeGreaterThan(0)
    expect(await page.getByText('管家沟通', { exact: true }).count()).toBeGreaterThan(0)
    expect(await page.getByText('自动化 Agent', { exact: true }).count()).toBeGreaterThan(0)
    expect(await page.locator('button:has-text("保存")').count()).toBe(8)

    // 技能管理空态
    await page.getByText('暂无已沉淀技能').waitFor()
    await page.screenshot({ path: '/tmp/ui-agent-page.png' })
    await page.close()
  }, 90_000)

  it('提示词编辑：修改 AI 匹配提示词并保存，刷新后值保留', async () => {
    const page = await context.newPage()
    await cleanupSettings(page)
    await openAgentPage(page)

    // 找到 ai.match 的 textarea（第一类「AI 分析」第一项）
    const aiMatchBox = page.locator('textarea').first()
    const original = (await aiMatchBox.inputValue()).slice(0, 20)
    const custom = `你是测试版匹配分析师。${original}`
    await aiMatchBox.fill(custom)
    await page.locator('button:has-text("保存")').first().click()
    await page.getByText('提示词已保存').waitFor({ timeout: 10_000 })

    // 刷新页面后重新导航到智能体页，验证持久化（等待异步加载覆盖值）
    await page.reload()
    await page.waitForSelector('text=求职数据看板', { timeout: 15_000 })
    await page.getByText('智能体', { exact: true }).click()
    await page.waitForSelector('text=智能体配置', { timeout: 10_000 })
    await page.waitForFunction(() => {
      const ta = document.querySelector('textarea')
      return !!ta && ta.value.startsWith('你是测试版匹配分析师。')
    }, undefined, { timeout: 10_000 })
    const afterReload = await page.locator('textarea').first().inputValue()
    expect(afterReload.startsWith('你是测试版匹配分析师。')).toBe(true)

    await page.screenshot({ path: '/tmp/ui-agent-prompt.png' })
    await cleanupSettings(page)
    await page.close()
  }, 90_000)

  it('角色切换：点保守精投后 agentRole 与参数写入存储', async () => {
    const page = await context.newPage()
    await cleanupSettings(page)
    await openAgentPage(page)

    await page.getByText('保守精投', { exact: true }).click()
    await page.getByText('已切换到「保守精投」').waitFor({ timeout: 10_000 })

    const stored = await page.evaluate(async () => {
      const res: any = await (globalThis as any).chrome.storage.local.get(['setting_agentRole', 'setting_enableAiMatch', 'setting_applyMode'])
      return {
        role: res['setting_agentRole'],
        enableAiMatch: res['setting_enableAiMatch'],
        applyMode: res['setting_applyMode'],
      }
    })
    expect(stored.role).toBe('conservative')
    expect(stored.enableAiMatch).toBe(true)
    expect(stored.applyMode).toBe('recommend')

    await page.screenshot({ path: '/tmp/ui-agent-role.png' })
    await cleanupSettings(page)
    await page.close()
  }, 90_000)

  it('技能管理：注入技能后列表显示，可停用与删除', async () => {
    const page = await context.newPage()
    await openAgentPage(page)

    // 直接向扩展域 IndexedDB（Dexie 库 BossZhipinAssistant）注入一条技能
    await page.evaluate(async () => {
      const skill = {
        id: 'f3test', platform: 'boss', pageType: 'detail', goal: 'send_greeting',
        steps: [{ thinking: '点发送', action: { type: 'click', target: { kind: 'button_text', value: '发送' } } }],
        successCount: 2, failCount: 0, createdAt: Date.now(), lastUsedAt: Date.now(),
        expiresAt: Date.now() + 14 * 86400000, selectorSignature: '发送', enabled: true,
      }
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('BossZhipinAssistant')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('agentSkills', 'readwrite')
          const store = tx.objectStore('agentSkills')
          store.put(skill)
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
      })
    })

    // 刷新后重新导航到智能体页，技能列表应显示该条
    await page.reload()
    await page.waitForSelector('text=求职数据看板', { timeout: 15_000 })
    await page.getByText('智能体', { exact: true }).click()
    await page.waitForSelector('text=智能体配置', { timeout: 10_000 })
    await page.getByText('send_greeting', { exact: true }).waitFor({ timeout: 10_000 })

    // 停用
    await page.getByText('启用中', { exact: true }).click()
    await page.getByText('技能已停用').waitFor({ timeout: 10_000 })
    await page.getByText('已停用', { exact: true }).waitFor()

    // 删除
    await page.getByText('删除', { exact: true }).click()
    await page.getByText('技能已删除').waitFor({ timeout: 10_000 })
    await page.getByText('暂无已沉淀技能').waitFor()

    // 清理注入数据
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('BossZhipinAssistant')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('agentSkills', 'readwrite')
          tx.objectStore('agentSkills').delete('f3test')
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onerror = () => reject(tx.error)
        }
      })
    })

    await page.screenshot({ path: '/tmp/ui-agent-skill.png' })
    await page.close()
  }, 90_000)
})
