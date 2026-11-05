// 求职者画像与底线配置面板（服务于 HR 经典追问智能应答 Copilot）

import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import {
  MessageSquareText,
  ShieldAlert,
  Clock,
  DollarSign,
  UserCheck,
  Phone,
  Sparkles,
  Check,
} from 'lucide-react'
import type {
  CandidateProfilePreferences,
  EmploymentStatus,
  AvailableDaysOption,
  AuthorizationPolicy,
  StrategyTuneKey,
} from '../../shared/types/candidate-profile'
import {
  PRESET_BOTTOM_LINES,
  DEFAULT_CANDIDATE_PREFERENCES,
  DEFAULT_AUTHORIZATION_POLICY,
} from '../../shared/types/candidate-profile'
import { resetAuthorizationCache } from '../../shared/agent/authorization'
import {
  getCandidatePreferences,
  saveCandidatePreferences,
} from '../../shared/db/settings-store'

interface CandidatePreferencesCardProps {
  onNotify?: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void
}

export const CandidatePreferencesCard: React.FC<CandidatePreferencesCardProps> = ({
  onNotify,
}) => {
  const [prefs, setPrefs] = useState<CandidateProfilePreferences>(
    DEFAULT_CANDIDATE_PREFERENCES,
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCandidatePreferences()
      .then((data) => setPrefs(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const updateField = async <K extends keyof CandidateProfilePreferences>(
    field: K,
    val: CandidateProfilePreferences[K],
  ) => {
    const next = { ...prefs, [field]: val }
    setPrefs(next)
    await saveCandidatePreferences({ [field]: val })
    onNotify?.('求职画像与授权配置已实时保存', 'success')
  }

  const toggleBottomLine = async (id: string) => {
    const exists = prefs.bottomLines.includes(id)
    const nextBottomLines = exists
      ? prefs.bottomLines.filter((b) => b !== id)
      : [...prefs.bottomLines, id]
    await updateField('bottomLines', nextBottomLines)
  }

  if (loading) {
    return <Card className="p-3 text-xs text-text-muted">加载画像配置中…</Card>
  }

  const policy = prefs.authorization ?? DEFAULT_AUTHORIZATION_POLICY

  /** 每次改动都刷新确认时间，避免旧授权长期生效 */
  const updatePolicy = async (patch: Partial<AuthorizationPolicy>) => {
    const next: AuthorizationPolicy = {
      ...policy,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await updateField('authorization', next)
    resetAuthorizationCache()
  }

  const toggleTune = async (key: StrategyTuneKey) => {
    const exists = policy.strategy.mayTune.includes(key)
    const mayTune = exists
      ? policy.strategy.mayTune.filter((k) => k !== key)
      : [...policy.strategy.mayTune, key]
    await updatePolicy({ strategy: { ...policy.strategy, mayTune } })
  }

  const TUNE_LABELS: Array<{ id: StrategyTuneKey; label: string }> = [
    { id: 'keywords', label: '搜索关键词' },
    { id: 'threshold', label: '匹配门槛' },
    { id: 'platformWeights', label: '平台配比' },
    { id: 'greeting', label: '招呼语' },
  ]

  return (
    <Card className="p-3.5 space-y-3">
      {/* 标题栏 */}
      <div className="flex items-center justify-between pb-1 border-b border-black/5">
        <div className="flex items-center gap-1.5">
          <MessageSquareText className="w-4 h-4 text-primary-light" />
          <span className="text-sm font-semibold text-text-primary">
            求职画像 · 底线 · 自主授权
          </span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary-light font-medium flex items-center gap-1">
          <Sparkles className="w-2.5 h-2.5" />
          事实驱动 · 拒绝虚构
        </span>
      </div>

      <p className="text-[11px] text-text-muted leading-relaxed">
        与简历配套的基础信息：HR 追问时<strong>只引用简历真实项目</strong>做真实应答；同时也是 AIbot 自主投递的事前授权依据。所有事实由你填写，AI 只读、不可改写。
      </p>

      {/* 1. 当前求职状态 */}
      <div>
        <label className="text-[11px] text-text-muted mb-1.5 flex items-center gap-1">
          <UserCheck className="w-3 h-3 text-primary-light" />
          当前求职状态
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            { id: 'unemployed_immediate', label: '离职 · 随时到岗' },
            { id: 'unemployed_week', label: '离职 · 1周内到岗' },
            { id: 'employed_month', label: '在职 · 月内到岗' },
            { id: 'employed_exploring', label: '在职 · 考虑新机会' },
          ].map((item) => {
            const active = prefs.employmentStatus === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => updateField('employmentStatus', item.id as EmploymentStatus)}
                className={`py-1.5 px-2 text-xs rounded-lg border transition-all text-left flex items-center justify-between ${
                  active
                    ? 'border-primary bg-primary/10 text-primary-light font-medium'
                    : 'border-black/10 bg-black/[0.02] text-text-muted hover:border-black/20'
                }`}
              >
                <span>{item.label}</span>
                {active && <Check className="w-3 h-3 text-primary-light" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* 2. 到岗周期与期望薪资 */}
      <div className="grid grid-cols-2 gap-2 pt-0.5">
        <div>
          <label className="text-[11px] text-text-muted mb-1 flex items-center gap-1">
            <Clock className="w-3 h-3 text-primary-light" />
            最快到岗周期
          </label>
          <select
            value={prefs.availableDays}
            onChange={(e) =>
              updateField('availableDays', e.target.value as AvailableDaysOption)
            }
            className="input-field text-xs py-1.5 w-full bg-surface-dark"
          >
            {['随时到岗', '3天内到岗', '1周内到岗', '2周内到岗', '1个月内到岗', '待协商'].map(
              (opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ),
            )}
          </select>
        </div>

        <div>
          <label className="text-[11px] text-text-muted mb-1 flex items-center gap-1">
            <DollarSign className="w-3 h-3 text-primary-light" />
            期望月薪范围 (K)
          </label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              placeholder="最低"
              value={prefs.expectedSalaryMin ?? ''}
              onChange={(e) =>
                updateField(
                  'expectedSalaryMin',
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              className="input-field text-xs py-1 text-center w-full"
              min={1}
              max={200}
            />
            <span className="text-xs text-text-muted">-</span>
            <input
              type="number"
              placeholder="最高"
              value={prefs.expectedSalaryMax ?? ''}
              onChange={(e) =>
                updateField(
                  'expectedSalaryMax',
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              className="input-field text-xs py-1 text-center w-full"
              min={1}
              max={200}
            />
            <span className="text-[10px] text-text-muted">K</span>
          </div>
        </div>
      </div>

      {/* 3. 硬性底线标签（触发后自动生成得体婉拒话术） */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] text-text-muted flex items-center gap-1">
            <ShieldAlert className="w-3 h-3 text-danger" />
            硬性底线护栏（检测命中自动礼貌婉拒/澄清）
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_BOTTOM_LINES.map((item) => {
            const selected = prefs.bottomLines.includes(item.id)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => toggleBottomLine(item.id)}
                title={item.description}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1 ${
                  selected
                    ? 'border-danger/30 bg-danger/10 text-danger font-medium'
                    : 'border-black/10 bg-black/[0.02] text-text-muted hover:border-black/20'
                }`}
              >
                <span>{item.label}</span>
                {selected && <Check className="w-2.5 h-2.5" />}
              </button>
            )
          })}
        </div>
        <input
          type="text"
          placeholder="补充自定义底线（如：不接受常驻外地出差，空格分隔）"
          value={prefs.customBottomLines}
          onChange={(e) => updateField('customBottomLines', e.target.value)}
          className="input-field text-xs py-1.5 mt-2 w-full"
        />
      </div>

      {/* 4. 面试应约预留联系方式 */}
      <div>
        <label className="text-[11px] text-text-muted mb-1 flex items-center gap-1">
          <Phone className="w-3 h-3 text-primary-light" />
          面试应约联系方式（当 HR 发起约聊/索要联系方式时填入）
        </label>
        <input
          type="text"
          placeholder="例如：13800000000 / 微信号（留空则仅在平台内沟通）"
          value={prefs.contactInfo}
          onChange={(e) => updateField('contactInfo', e.target.value)}
          className="input-field text-xs py-1.5 w-full"
        />
      </div>

      {/* 5. 应答策略模式 */}
      <div className="pt-1 border-t border-black/5 flex items-center justify-between">
        <span className="text-[11px] text-text-muted">Copilot 应答策略</span>
        <div className="flex items-center gap-1 bg-black/5 p-0.5 rounded-lg">
          {[
            { id: 'suggest', label: '建议气泡（一键采纳）' },
            { id: 'auto_fill', label: '填入输入框待确认' },
            { id: 'safe_auto_reply', label: '白名单自动发' },
          ].map((mode) => {
            const active = prefs.copilotMode === mode.id
            return (
              <button
                key={mode.id}
                type="button"
                onClick={async () => {
                  const value = mode.id as CandidateProfilePreferences['copilotMode']
                  await updateField('copilotMode', value)
                  await updatePolicy({ reply: { ...policy.reply, mode: value } })
                }}
                className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${
                  active
                    ? 'bg-white text-primary-light shadow-sm font-medium'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* 6. 自主授权契约：用户事前编写，运行时查表判定 */}
      <div className="pt-2 border-t border-black/5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-primary-light" />
            <span className="text-[11px] font-medium text-text-primary">自主授权 · 事前写清楚</span>
          </div>
          <button
            type="button"
            onClick={() => updatePolicy({ enabled: !policy.enabled })}
            className={`px-2 py-0.5 text-[10px] rounded-md border transition-colors ${
              policy.enabled
                ? 'bg-primary/10 text-primary-light border-primary/30'
                : 'bg-black/[0.02] text-text-muted border-black/10'
            }`}
          >
            {policy.enabled ? '已启用' : '未启用'}
          </button>
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed">
          未启用时完全走原有权限三档。启用后按下方分类查表：区间内自动执行，未覆盖、超范围或超过 14 天未复核一律停下问你。
        </p>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-text-muted mb-1 block">区间内投递</label>
            <div className="flex gap-1">
              {(['auto', 'confirm'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => updatePolicy({ strategy: { ...policy.strategy, apply: opt } })}
                  className={`flex-1 py-1 text-[10px] rounded-md border ${
                    policy.strategy.apply === opt
                      ? 'bg-primary/10 text-primary-light border-primary/30'
                      : 'bg-white text-text-muted border-black/10'
                  }`}
                >
                  {opt === 'auto' ? '自动执行' : '需确认'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] text-text-muted mb-1 block">每日自动应答上限</label>
            <input
              type="number"
              min={0}
              max={100}
              value={policy.reply.maxPerDay}
              onChange={(e) => updatePolicy({
                reply: { ...policy.reply, maxPerDay: Math.max(0, Number(e.target.value) || 0) },
              })}
              className="input-field text-xs py-1 w-full"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-text-muted mb-1 block">每日配额上限</label>
            <input
              type="number"
              min={1}
              value={policy.strategy.dailyQuotaMax}
              onChange={(e) => updatePolicy({
                strategy: { ...policy.strategy, dailyQuotaMax: Math.max(1, Number(e.target.value) || 1) },
              })}
              className="input-field text-xs py-1 w-full"
            />
          </div>
          <div>
            <label className="text-[10px] text-text-muted mb-1 block">匹配门槛下限</label>
            <input
              type="number"
              min={0}
              max={100}
              value={policy.strategy.matchThresholdMin}
              onChange={(e) => updatePolicy({
                strategy: { ...policy.strategy, matchThresholdMin: Math.min(100, Math.max(0, Number(e.target.value) || 0)) },
              })}
              className="input-field text-xs py-1 w-full"
            />
          </div>
        </div>

        <div>
          <label className="text-[10px] text-text-muted mb-1 block">
            主攻方向白名单（逗号分隔，留空则换方向需确认）
          </label>
          <input
            value={policy.strategy.allowedTitles.join('，')}
            onChange={(e) => updatePolicy({
              strategy: {
                ...policy.strategy,
                allowedTitles: e.target.value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean),
              },
            })}
            placeholder="PHP后端，ERP/供应链，AI全栈"
            className="input-field text-xs py-1 w-full"
          />
        </div>

        <div>
          <label className="text-[10px] text-text-muted mb-1 block">允许自动调参</label>
          <div className="flex flex-wrap gap-1">
            {TUNE_LABELS.map((item) => {
              const active = policy.strategy.mayTune.includes(item.id)
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggleTune(item.id)}
                  className={`px-2 py-1 text-[10px] rounded-md border transition-colors ${
                    active
                      ? 'bg-primary/10 text-primary-light border-primary/30'
                      : 'bg-white text-text-muted border-black/10'
                  }`}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-text-muted mb-1 block">自动应答话题白名单</label>
            <input
              value={policy.reply.allowedTopics.join('，')}
              onChange={(e) => updatePolicy({
                reply: {
                  ...policy.reply,
                  allowedTopics: e.target.value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean),
                },
              })}
              className="input-field text-xs py-1 w-full"
            />
          </div>
          <div>
            <label className="text-[10px] text-text-muted mb-1 block">禁用话题</label>
            <input
              value={policy.reply.forbidTopics.join('，')}
              onChange={(e) => updatePolicy({
                reply: {
                  ...policy.reply,
                  forbidTopics: e.target.value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean),
                },
              })}
              className="input-field text-xs py-1 w-full"
            />
          </div>
        </div>

        <div className="rounded-lg bg-black/[0.02] border border-black/5 p-2 space-y-0.5">
          <div className="text-[10px] font-medium text-text-muted">硬锁 · 不提供自动执行选项</div>
          <div className="text-[10px] text-text-muted">改简历事实 / 突破平台风控 · 永远禁止</div>
          <div className="text-[10px] text-text-muted">代谈 offer / 薪资谈判 · 永远需你确认</div>
        </div>
        <p className="text-[10px] text-text-muted">
          {policy.updatedAt
            ? `最后确认：${new Date(policy.updatedAt).toLocaleString('zh-CN')}`
            : '尚未确认 · 启用后请定期复核'}
        </p>
      </div>
    </Card>
  )
}
