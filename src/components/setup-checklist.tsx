// 配置引导卡片（Setup Checklist）
// 作用：把「首次上手必须配的 3 项 + 安全阀」和「可以后置、用到再开的 4 项」显性化，
// 避免用户装完扩展不知道下一步该干什么，也避免一上来就被高级配置淹没。
// 只读探测现有配置状态，不修改任何设置。
import React, { useEffect, useMemo, useState } from 'react'
import { Card } from './ui/card'
import {
  ArrowRight, CheckCircle2, Circle, ChevronDown, ChevronUp, Sparkles, Info,
} from 'lucide-react'
import { getAllResumes } from '../shared/db/resume-store'
import { getSetting } from '../shared/db/settings-store'
import { checkPlatformAuth } from '../shared/platform/auth-checker'
import { PLATFORM_IDS, type PlatformId } from '../shared/agent/quota'
import { SAFETY_PROFILE_LABELS, type SafetyProfileId } from '../shared/types/safety-preset'

interface SetupChecklistProps {
  /** 点击条目的跳转回调（由 App 注入，切到对应管理页） */
  onNavigate?: (navId: string) => void
}

interface StepState {
  done: boolean
  detail: string
}

const LATER_ITEMS: Array<{ navId: string; label: string; hint: string }> = [
  {
    navId: 'settings',
    label: 'AI 自主权限（自动执行 / 需确认 / 禁止）',
    hint: '默认「需确认」。跑顺了再考虑把投递/发送放开为自动。',
  },
  {
    navId: 'settings',
    label: '通知推送（飞书 / 钉钉 / 企微 / Server酱 / Bark）',
    hint: '想第一时间收到面试邀约时再配，不配也能在「面试日历」里看。',
  },
  {
    navId: 'blacklist',
    label: '公司黑名单',
    hint: '遇到外包、已投过、不想再看到的公司，随时加进去。',
  },
  {
    navId: 'export',
    label: '数据导出与备份',
    hint: '投递记录随时可导出 Excel/CSV；数据全部保存在本机浏览器。',
  },
]

export function SetupChecklist({ onNavigate }: SetupChecklistProps) {
  const [resumeCount, setResumeCount] = useState<number | null>(null)
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [loggedPlatforms, setLoggedPlatforms] = useState<PlatformId[] | null>(null)
  const [safetyProfile, setSafetyProfile] = useState<SafetyProfileId>('conservative')
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    let alive = true

    async function load() {
      try {
        const resumes = await getAllResumes()
        if (alive) setResumeCount(resumes.length)
      } catch { if (alive) setResumeCount(0) }

      try {
        const [key, enabled, profile] = await Promise.all([
          getSetting<string>('apiKey', ''),
          getSetting<boolean>('aiEnabled', false),
          getSetting<SafetyProfileId>('safetyProfile', 'conservative'),
        ])
        if (alive) {
          setHasApiKey(!!key)
          setAiEnabled(!!enabled)
          setSafetyProfile(profile)
        }
      } catch { /* ignore */ }

      try {
        const results = await Promise.all(PLATFORM_IDS.map((p) => checkPlatformAuth(p)))
        if (alive) setLoggedPlatforms(results.filter((r) => r.isLoggedIn).map((r) => r.platform))
      } catch { if (alive) setLoggedPlatforms([]) }
    }

    void load()
    return () => { alive = false }
  }, [])

  const steps: Array<{ navId: string; title: string; state: StepState }> = useMemo(() => [
    {
      navId: 'resumes',
      title: '① 简历与求职信息',
      state: resumeCount === null
        ? { done: false, detail: '检查中…' }
        : resumeCount > 0
          ? { done: true, detail: `已导入 ${resumeCount} 份简历` }
          : { done: false, detail: '还没导入简历，AI 无法判断匹配度' },
    },
    {
      navId: 'settings',
      title: '② 大模型配置',
      state: hasApiKey === null
        ? { done: false, detail: '检查中…' }
        : hasApiKey && aiEnabled
          ? { done: true, detail: 'API Key 已填写，AI 已启用' }
          : hasApiKey
            ? { done: false, detail: 'Key 已填，但「启用 AI 分析」还没打开' }
            : { done: false, detail: '未填 API Key，只能走本地规则匹配' },
    },
    {
      navId: 'settings',
      title: '③ 招聘平台登录',
      state: loggedPlatforms === null
        ? { done: false, detail: '检查中…' }
        : loggedPlatforms.length > 0
          ? { done: true, detail: `已登录 ${loggedPlatforms.length} 个平台` }
          : { done: false, detail: '未检测到登录态，请先在浏览器登录 Boss/猎聘等平台' },
    },
    {
      navId: 'settings',
      title: '④ 安全阀（投递节奏）',
      state: {
        done: true,
        detail: `当前「${SAFETY_PROFILE_LABELS[safetyProfile] ?? '保守'}」档，默认已按保守参数就绪`,
      },
    },
  ], [resumeCount, hasApiKey, aiEnabled, loggedPlatforms, safetyProfile])

  const doneCount = steps.filter((s) => s.state.done).length

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
      >
        <Sparkles className="w-5 h-5 text-primary" />
        <span className="font-semibold text-text-primary">配置引导</span>
        <span className="text-xs text-text-muted">
          {doneCount}/{steps.length} 已完成
        </span>
        <span className="ml-auto text-text-muted">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {expanded && (
        <>
          <p className="text-xs text-text-muted mt-1.5">
            首次使用只需要配前 3 项 + 确认节奏档位，就能开始跑。其余配置可以以后再开。
          </p>

          <div className="mt-3 space-y-1">
            {steps.map((step) => (
              <div key={step.title} className="flex items-start gap-2.5 py-1.5">
                {step.state.done
                  ? <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  : <Circle className="w-4 h-4 text-text-muted shrink-0 mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text-primary leading-tight">{step.title}</p>
                  <p className="text-[11px] text-text-muted mt-0.5 leading-tight">{step.state.detail}</p>
                </div>
                {!step.state.done && onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate(step.navId)}
                    className="flex items-center gap-0.5 text-[11px] text-primary-light hover:underline shrink-0 mt-0.5"
                  >
                    去配置<ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-black/10">
            <p className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-text-muted" />
              后续可配置（不配也能用）
            </p>
            <div className="mt-2 space-y-1.5">
              {LATER_ITEMS.map((item) => (
                <div key={item.label} className="flex items-start gap-2">
                  <span className="w-1 h-1 rounded-full bg-text-muted mt-1.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-text-secondary leading-tight">{item.label}</p>
                    <p className="text-[11px] text-text-muted leading-tight mt-0.5">{item.hint}</p>
                  </div>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate(item.navId)}
                      className="text-[11px] text-primary-light hover:underline shrink-0"
                    >
                      去看看
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-[10px] text-text-muted mt-2.5 leading-relaxed">
              详细说明见项目文档 docs/CONFIG_GUIDE.md（配置项）与 docs/FEATURES.md（功能说明）。
            </p>
          </div>
        </>
      )}
    </Card>
  )
}

export default SetupChecklist
