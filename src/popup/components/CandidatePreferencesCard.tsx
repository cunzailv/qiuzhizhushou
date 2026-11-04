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
} from '../../shared/types/candidate-profile'
import {
  PRESET_BOTTOM_LINES,
  DEFAULT_CANDIDATE_PREFERENCES,
} from '../../shared/types/candidate-profile'
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
    onNotify?.('求职画像与底线已实时保存', 'success')
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

  return (
    <Card className="p-3.5 space-y-3">
      {/* 标题栏 */}
      <div className="flex items-center justify-between pb-1 border-b border-black/5">
        <div className="flex items-center gap-1.5">
          <MessageSquareText className="w-4 h-4 text-primary-light" />
          <span className="text-sm font-semibold text-text-primary">
            求职画像与底线 (HR 问答 Copilot)
          </span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary-light font-medium flex items-center gap-1">
          <Sparkles className="w-2.5 h-2.5" />
          事实驱动 · 拒绝虚构
        </span>
      </div>

      <p className="text-[11px] text-text-muted leading-relaxed">
        AIbot 在与 HR 沟通时，将严密结合您的<strong>简历真实项目</strong>与下方预设画像，高情商且真实得体地应答「在职状态、最快到岗时间、期望薪资、架构技术深挖」等经典追问。
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
          ].map((mode) => {
            const active = prefs.copilotMode === mode.id
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() =>
                  updateField(
                    'copilotMode',
                    mode.id as CandidateProfilePreferences['copilotMode'],
                  )
                }
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
    </Card>
  )
}
