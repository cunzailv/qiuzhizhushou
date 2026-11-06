import React, { useState, useEffect, useRef } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Toast } from '../../components/ui/toast'
import { getSetting, setSetting, getAllSettings } from '../../shared/db/settings-store'
import { testAIConnection, BUILTIN_MODELS, getPresetById, getCustomModels, saveCustomModels, generateCustomModelId, getAiUsageToday, getAiBudgetLimit, resetAiBudget } from '../../shared/ai'
import type { ModelPreset } from '../../shared/ai'
import type { PluginSettings } from '../../shared/types/settings'
import { DEFAULT_SETTINGS } from '../../shared/types/settings'
import {
  SAFETY_PRESETS,
  SAFETY_PROFILE_LABELS,
  detectSafetyProfile,
  getSafetyPreset,
  type SafetyProfileId,
} from '../../shared/types/safety-preset'
import { getPlatformsMeta } from '../../shared/platform'
// 求职画像 · 底线 · 自主授权 已迁至「简历管理」模块（与简历绑定，此处不再重复展示）
import { NotificationSettingsCard } from '../../popup/components/NotificationSettingsCard'
import { ExternalAiCard } from '../components/ExternalAiCard'
import { Key, Zap, Shield, ChevronDown, ExternalLink, AlertTriangle, Globe, Plus, X, Bug, Trash2 } from 'lucide-react'

export default function Settings() {
  const [settings, setLocalSettings] = useState<PluginSettings>(DEFAULT_SETTINGS)
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })
  const [testing, setTesting] = useState(false)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [platformOverride, setPlatformOverride] = useState('auto')
  const [customModels, setCustomModels] = useState<ModelPreset[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [newModel, setNewModel] = useState({ name: '', provider: '', baseUrl: '', modelName: '' })
  const [permissionApply, setPermissionApply] = useState<'auto' | 'confirm' | 'denied'>('confirm')
  const [permissionSend, setPermissionSend] = useState<'auto' | 'confirm' | 'denied'>('confirm')
  const [aiUsage, setAiUsage] = useState<{ used: number; limit: number } | null>(null)

  const allModels = [...BUILTIN_MODELS, ...customModels]
  const selectedPreset = allModels.find(m => m.id === settings.modelPreset)
  const isCustom = settings.modelPreset === 'custom'

  useEffect(() => {
    loadSettings()
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function loadSettings() {
    const all = await getAllSettings()
    setLocalSettings({ ...DEFAULT_SETTINGS, ...all } as PluginSettings)
    const override = await getSetting<string>('platformOverride', 'auto')
    setPlatformOverride(override)
    const pa = await getSetting<'auto' | 'confirm' | 'denied'>('permission_apply', 'confirm')
    setPermissionApply(pa)
    const ps = await getSetting<'auto' | 'confirm' | 'denied'>('permission_send', 'confirm')
    setPermissionSend(ps)
    const cm = await getCustomModels()
    setCustomModels(cm)
    refreshAiUsage()
  }

  async function refreshAiUsage() {
    const [used, limit] = await Promise.all([getAiUsageToday(), getAiBudgetLimit()])
    setAiUsage({ used, limit })
  }

  async function handleResetAiBudget() {
    await resetAiBudget()
    await refreshAiUsage()
    showToast('今日 AI 调用计数已重置', 'success')
  }

  async function setPermissionLevel(key: 'permission_apply' | 'permission_send', level: 'auto' | 'confirm' | 'denied') {
    if (key === 'permission_apply') setPermissionApply(level)
    else setPermissionSend(level)
    await setSetting(key, level)
    showToast(`AI 动作权限已更新：${level === 'auto' ? '自动执行' : level === 'confirm' ? '需确认' : '禁止'}`, 'success')
  }

  async function handlePlatformOverrideChange(value: string) {
    setPlatformOverride(value)
    await setSetting('platformOverride', value)
    showToast('平台识别策略已更新', 'success')
  }

  async function handleSave(updates: Partial<PluginSettings>) {
    const newSettings = { ...settings, ...updates }
    setLocalSettings(newSettings)
    for (const [key, value] of Object.entries(updates)) {
      await setSetting(key, value)
    }
  }

  // 手动改任一项节奏参数 → 自动标记为「自定义」档
  function rhythmPatch(patch: Partial<PluginSettings>): Partial<PluginSettings> {
    return { ...patch, safetyProfile: detectSafetyProfile({ ...settings, ...patch }) }
  }

  async function handleApplySafetyPreset(id: Exclude<SafetyProfileId, 'custom'>) {
    const preset = SAFETY_PRESETS[id]
    await handleSave({ ...preset.values, safetyProfile: preset.id })
    showToast(
      preset.id === 'aggressive'
        ? '已切换为「激进」档，注意封号风险'
        : `已切换为「${preset.label}」档`,
      preset.id === 'aggressive' ? 'warning' : 'success',
    )
  }

  async function handleSelectPreset(presetId: string, preset?: ModelPreset) {
    setShowModelDropdown(false)
    const p = preset || getPresetById(presetId) || customModels.find(m => m.id === presetId)
    if (!p) return

    const updates: Partial<PluginSettings> = {
      modelPreset: presetId,
      apiBaseUrl: p.baseUrl,
      modelName: p.modelName,
    }
    await handleSave(updates)
  }

  async function handleAddCustomModel() {
    const { name, provider, baseUrl, modelName } = newModel
    if (!name.trim() || !baseUrl.trim() || !modelName.trim()) {
      showToast('请填写模型名称、API 地址和模型名', 'warning')
      return
    }
    const newPreset: ModelPreset = {
      id: generateCustomModelId(),
      name: name.trim(),
      provider: provider.trim() || '自定义',
      baseUrl: baseUrl.trim(),
      modelName: modelName.trim(),
      description: `${provider || '自定义'} - ${modelName}`,
      free: false,
      docsUrl: '',
      isCustom: true,
    }
    const updated = [...customModels, newPreset]
    await saveCustomModels(updated)
    setCustomModels(updated)
    setNewModel({ name: '', provider: '', baseUrl: '', modelName: '' })
    setShowAddForm(false)
    await handleSelectPreset(newPreset.id, newPreset)
    showToast('自定义模型已添加', 'success')
  }

  async function handleDeleteCustomModel(id: string) {
    const updated = customModels.filter(m => m.id !== id)
    await saveCustomModels(updated)
    setCustomModels(updated)
    if (settings.modelPreset === id) {
      const defaultPreset = BUILTIN_MODELS[0]
      await handleSelectPreset(defaultPreset.id, defaultPreset)
    }
    showToast('已删除', 'info')
  }

  async function handleTestAPI() {
    setTesting(true)
    const result = await testAIConnection()
    showToast(result.message, result.success ? 'success' : 'error')
    setTesting(false)
    refreshAiUsage()
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-medium text-text-primary">扩展设置</h2>
        <p className="text-sm text-text-muted mt-1">配置 AI 模型、沟通策略和通知偏好</p>
      </div>

      {/* Platform */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-primary-light" />
          <span className="font-medium text-text-primary">平台识别</span>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">当前平台策略</label>
          <select
            value={platformOverride}
            onChange={(e) => handlePlatformOverrideChange(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl bg-surface-darkest border border-surface-hairline text-sm text-text-primary focus:border-primary-light focus:outline-none"
          >
            <option value="auto">自动识别（按网址）</option>
            {getPlatformsMeta().map((p) => (
              <option key={p.id} value={p.id}>{p.icon} {p.name}（手动）</option>
            ))}
          </select>
          <p className="text-xs text-text-muted mt-1.5">默认按当前网址自动识别招聘平台；如自动识别失败，可手动指定。</p>
        </div>
      </Card>

      {/* AI Model */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Key className="w-5 h-5 text-primary-light" />
          <span className="font-medium text-text-primary">AI 模型配置</span>
        </div>

        <div className="space-y-4">
          {/* Model Selector */}
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">选择模型</label>
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="w-full px-3 py-2.5 rounded-xl bg-surface-darkest border border-surface-hairline text-left flex items-center justify-between hover:border-surface-hairline transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{selectedPreset?.name || '选择模型'}</span>
                  <span className="text-xs text-text-muted">{selectedPreset?.provider}</span>
                </div>
                <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showModelDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 p-2 rounded-xl bg-surface-dark border border-surface-hairline shadow-2xl z-50 max-h-[320px] overflow-y-auto">
                  {allModels.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => handleSelectPreset(model.id, model)}
                      className={`w-full px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-surface-dark ${
                        settings.modelPreset === model.id ? 'bg-surface-dark ring-1 ring-accent/20' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-sm font-medium text-text-primary">{model.name}</span>
                        <div className="flex items-center gap-2">
                        {settings.modelPreset === model.id && (
                            <div className="w-2 h-2 rounded-full bg-primary-light" />
                          )}
                          {model.isCustom && (
                            <span
                              onClick={(e) => { e.stopPropagation(); handleDeleteCustomModel(model.id) }}
                              className="p-0.5 rounded hover:bg-danger/20 text-text-muted hover:text-red-400 cursor-pointer"
                              title="删除此模型"
                            >
                              <X className="w-3.5 h-3.5" />
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-text-muted">
                        {model.provider} · {model.description}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Add custom model */}
            {!showAddForm ? (
              <button
                onClick={() => setShowAddForm(true)}
                className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-primary-light transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                添加自定义模型
              </button>
            ) : (
              <div className="p-3 rounded-xl bg-surface-dark border border-surface-hairline space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-text-muted mb-1 block">显示名称</label>
                    <input
                      type="text"
                      value={newModel.name}
                      onChange={(e) => setNewModel({ ...newModel, name: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                      placeholder="如 GPT-4o"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted mb-1 block">厂商</label>
                    <input
                      type="text"
                      value={newModel.provider}
                      onChange={(e) => setNewModel({ ...newModel, provider: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                      placeholder="如 OpenAI"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted mb-1 block">API 地址</label>
                    <input
                      type="text"
                      value={newModel.baseUrl}
                      onChange={(e) => setNewModel({ ...newModel, baseUrl: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-text-muted mb-1 block">模型名</label>
                    <input
                      type="text"
                      value={newModel.modelName}
                      onChange={(e) => setNewModel({ ...newModel, modelName: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                      placeholder="gpt-4o"
                    />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setShowAddForm(false); setNewModel({ name: '', provider: '', baseUrl: '', modelName: '' }) }}
                    className="px-3 py-1.5 rounded-lg bg-surface-darkest text-text-muted text-sm hover:text-text-secondary transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleAddCustomModel}
                    className="px-3 py-1.5 rounded-lg bg-surface-dark text-primary-light text-sm hover:bg-surface-dark transition-colors"
                  >
                    保存
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* API Key */}
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">API Key</label>
            <div className="flex gap-3">
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => handleSave({ apiKey: e.target.value })}
                className="flex-1 px-3 py-2.5 rounded-xl bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                placeholder={selectedPreset ? `输入 ${selectedPreset.provider} 的 API Key` : '输入 API Key'}
              />
              <Button onClick={handleTestAPI} loading={testing} variant="secondary">
                <Zap className="w-4 h-4" />
                测试连接
              </Button>
            </div>
            {selectedPreset?.docsUrl && (
              <a
                href={selectedPreset.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-1.5 text-xs text-primary-light hover:underline"
              >
                前往 {selectedPreset.provider} 获取 API Key
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <div className="flex items-center justify-between mt-1.5">
              <span className={`text-xs ${aiUsage && aiUsage.used >= aiUsage.limit ? 'text-error font-medium' : 'text-text-muted'}`}>
                今日 AI 已用: {aiUsage ? `${aiUsage.used} / ${aiUsage.limit} 次` : '加载中…'}
                {aiUsage && aiUsage.used >= aiUsage.limit && '（已超限，AI 已暂停）'}
              </span>
              <button
                onClick={handleResetAiBudget}
                className="text-xs text-primary-light hover:underline"
                type="button"
              >
                重置今日计数
              </button>
            </div>
          </div>

          {/* Custom model fields */}
          {isCustom && (
            <div className="grid grid-cols-2 gap-4 p-3 rounded-xl bg-surface-dark border border-surface-hairline">
              <div>
                <label className="text-xs text-text-muted mb-1.5 block">API Base URL</label>
                <input
                  type="text"
                  value={settings.apiBaseUrl}
                  onChange={(e) => handleSave({ apiBaseUrl: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1.5 block">模型名称</label>
                <input
                  type="text"
                  value={settings.modelName}
                  onChange={(e) => handleSave({ modelName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-surface-hairline text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                  placeholder="gpt-4o-mini"
                />
              </div>
            </div>
          )}

          {/* Toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.aiEnabled}
              onChange={(e) => handleSave({ aiEnabled: e.target.checked })}
              className="w-4 h-4 rounded accent-primary"
            />
            <span className="text-sm text-text-secondary">
              启用 AI 分析（匹配评分、简历优化建议）
            </span>
          </label>
        </div>
      </Card>

      {/* 求职画像与底线已迁至「简历管理」模块 */}
      <div className="rounded-xl border border-surface-hairline bg-black/[0.02] p-3">
        <p className="text-xs font-medium text-text-primary">求职画像 · 底线 · 自主授权</p>
        <p className="text-xs text-text-muted mt-1 leading-relaxed">
          这些配置与简历绑定，已统一放到「简历管理」页下方管理，此处不再重复展示。
        </p>
      </div>

      {/* 跨端实时通知推送 (Webhook: 飞书/钉钉/企微/Server酱/Bark) */}
      <NotificationSettingsCard onNotify={showToast} />

      {/* Anti-bot */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-5 h-5 text-success" />
          <span className="font-medium text-text-primary">防封策略</span>
          <span className="ml-auto text-xs px-2 py-0.5 rounded-md bg-success/10 text-success font-medium">
            当前：{SAFETY_PROFILE_LABELS[(settings.safetyProfile ?? 'conservative') as SafetyProfileId]}
          </span>
        </div>
        <p className="text-xs text-text-muted mb-4">
          首次使用默认「保守」档：每天 30 次以内、间隔 5-15 秒、单次只扫描 20 个岗位。稳定跑一周没有验证码或「操作频繁」提示，再逐级上调。
        </p>

        {/* 安全阀档位（Safety Preset） */}
        <div className="grid grid-cols-3 gap-2 mb-2">
          {Object.values(SAFETY_PRESETS).map((preset) => {
            const active = settings.safetyProfile === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleApplySafetyPreset(preset.id)}
                className={`text-left px-3 py-2.5 rounded-xl border transition-colors ${
                  active
                    ? 'border-surface-hairline bg-surface-dark ring-1 ring-accent/20'
                    : 'border-surface-hairline bg-black/[0.02] hover:bg-surface-dark'
                }`}
              >
                <span className={`block text-sm font-medium ${active ? 'text-primary-light' : 'text-text-primary'}`}>
                  {preset.label}
                </span>
                <span className="block text-xs text-text-muted mt-0.5 leading-tight">{preset.tagline}</span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-text-muted mb-4 leading-relaxed">
          {(() => {
            const preset = getSafetyPreset(settings.safetyProfile)
            if (preset) return preset.description
            return '当前为「自定义」：你手动调过下面的参数。想回到推荐节奏，点上面的档位即可。'
          })()}
        </p>
        {getSafetyPreset(settings.safetyProfile)?.warning && (
          <p className="text-xs text-error bg-error/10 border border-error/20 rounded-lg px-2.5 py-1.5 mb-4">
            {getSafetyPreset(settings.safetyProfile)!.warning}
          </p>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-text-muted mb-1.5 block">
                每日上限 <span className="text-primary-light">{settings.dailyLimit} 次</span>
              </label>
              <input
                type="range"
                min={10} max={10000} step={10}
                value={settings.dailyLimit}
                onChange={(e) => handleSave(rhythmPatch({ dailyLimit: parseInt(e.target.value) }))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-text-muted mt-0.5">
                <span>10</span><span>10000</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1.5 block">最小延迟</label>
              <select
                value={settings.minDelay}
                onChange={(e) => handleSave(rhythmPatch({ minDelay: parseInt(e.target.value) }))}
                className="w-full px-3 py-2 rounded-xl bg-surface-darkest border border-surface-hairline text-sm"
              >
                {[1000,2000,3000,5000].map(v => (
                  <option key={v} value={v}>{v/1000} 秒</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1.5 block">最大延迟</label>
              <select
                value={settings.maxDelay}
                onChange={(e) => handleSave(rhythmPatch({ maxDelay: parseInt(e.target.value) }))}
                className="w-full px-3 py-2 rounded-xl bg-surface-darkest border border-surface-hairline text-sm"
              >
                {[3000,5000,8000,10000,15000].map(v => (
                  <option key={v} value={v}>{v/1000} 秒</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted mb-1.5 block">
              单次扫描数量{' '}
              <span className="text-primary-light">
                {settings.maxScanCount > 0 ? `${settings.maxScanCount} 个` : '不限制'}
              </span>
            </label>
            <select
              value={settings.maxScanCount}
              onChange={(e) => handleSave(rhythmPatch({ maxScanCount: parseInt(e.target.value) }))}
              className="w-full px-3 py-2 rounded-xl bg-surface-darkest border border-surface-hairline text-sm"
            >
              {[10, 20, 30, 50, 80, 100, 150, 200].map((v) => (
                <option key={v} value={v}>{v} 个</option>
              ))}
              <option value={0}>不限制（扫描到无更多为止）</option>
            </select>
            <p className="text-xs text-text-muted mt-1.5">每次点击「开始沟通」时，扫描/采集的最大岗位数量。数值越大耗时越长。</p>
          </div>

          <div>
            <label className="text-xs text-text-muted mb-1.5 block">沟通模式</label>
            <div className="flex gap-2">
              <button
                onClick={() => handleSave(rhythmPatch({ applyMode: 'batch' }))}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  settings.applyMode === 'batch'
                    ? 'bg-surface-dark text-primary-light ring-1 ring-accent/20'
                    : 'bg-surface-darkest text-text-muted'
                }`}
              >
                一键批量沟通
              </button>
              <button
                onClick={() => handleSave(rhythmPatch({ applyMode: 'recommend' }))}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  settings.applyMode === 'recommend'
                    ? 'bg-surface-dark text-primary-light ring-1 ring-accent/20'
                    : 'bg-surface-darkest text-text-muted'
                }`}
              >
                AI 推荐确认
              </button>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.enableAiMatch}
              onChange={(e) => handleSave({ enableAiMatch: e.target.checked })}
              className="w-4 h-4 rounded accent-primary"
            />
            <span className="text-sm text-text-secondary">
              启用 AI 评分筛选（关闭后「一键沟通」不评分、直接沟通）
            </span>
          </label>
        </div>
      </Card>

      {/* AI 动作权限（E3：权限三档） */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-5 h-5 text-primary" />
          <span className="font-medium text-text-primary">AI 动作权限</span>
        </div>
        <p className="text-xs text-text-muted mb-4">Harness 权限三档：自动执行 / 需确认 / 禁止。投递与发送类动作默认需确认。</p>
        <p className="text-xs text-warning bg-surface-dark border border-surface-hairline rounded-lg px-2.5 py-1.5 mb-4">
          若在「简历管理」模块中启用了「自主授权」，此处三档将被授权契约覆盖：以简历页的画像配置为准，区间内自动执行、越界停下询问。
        </p>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-text-muted mb-2 block">投递 / 申请动作</label>
            <div className="flex gap-2">
              {(['auto', 'confirm', 'denied'] as const).map((level) => (
                <button
                  key={level}
                  onClick={() => { setPermissionLevel('permission_apply', level) }}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    permissionApply === level
                      ? 'bg-surface-dark text-primary-light ring-1 ring-accent/20'
                      : 'bg-surface-darkest text-text-muted'
                  }`}
                >
                  {level === 'auto' ? '自动执行' : level === 'confirm' ? '需确认' : '禁止'}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-1.5">设为「自动执行」后，AI 发起的投递/申请将不再弹确认卡片。</p>
          </div>

          <div>
            <label className="text-xs text-text-muted mb-2 block">发送消息动作</label>
            <div className="flex gap-2">
              {(['auto', 'confirm', 'denied'] as const).map((level) => (
                <button
                  key={level}
                  onClick={() => { setPermissionLevel('permission_send', level) }}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    permissionSend === level
                      ? 'bg-surface-dark text-primary-light ring-1 ring-accent/20'
                      : 'bg-surface-darkest text-text-muted'
                  }`}
                >
                  {level === 'auto' ? '自动执行' : level === 'confirm' ? '需确认' : '禁止'}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-1.5">发送打招呼/消息时的确认策略。</p>
          </div>
        </div>
      </Card>

      {/* 外部 AI 接入（Claude Code / Codex / OpenClaw 小龙虾 / MCP） */}
      <ExternalAiCard onNotify={showToast} />

      {/* Warning */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-warning/10 border border-warning/20">
        <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-text-secondary font-medium">安全提示</p>
          <p className="text-xs text-text-muted mt-0.5">
            建议每天不超过 {settings.dailyLimit} 次沟通。所有数据存储在浏览器本地，不会上传到任何服务器。
            你的 API Key 也仅保存在浏览器中，用于直接调用所选的大模型 API。
          </p>
        </div>
      </div>

      {/* H5：错误日志 */}
      <ErrorLogCard />

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}

/** H5 · 本地错误日志查看（全局捕获 + AI 失败点） */
function ErrorLogCard() {
  const [errors, setErrors] = useState<Array<{ id: string; createdAt: string; source: string; message: string; stack?: string }>>([])
  const [expanded, setExpanded] = useState(false)

  async function load() {
    try {
      const { listErrors } = await import('../../shared/db/error-store')
      setErrors(await listErrors(30))
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleClear() {
    if (!confirm('确认清空全部错误日志？')) return
    try {
      const { clearErrors } = await import('../../shared/db/error-store')
      await clearErrors()
      await load()
    } catch {
      // ignore
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bug className="w-5 h-5 text-primary-light" />
          <span className="font-medium text-text-primary">错误日志（{errors.length}）</span>
          <span className="text-xs text-text-muted">全局捕获 + AI 失败点自动记录</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setExpanded(!expanded)} className="px-2.5 py-1 rounded-lg bg-surface-dark text-text-muted text-xs hover:text-text-primary transition-colors">
            {expanded ? '收起' : '展开'}
          </button>
          <button onClick={handleClear} className="px-2.5 py-1 rounded-lg bg-surface-dark text-text-muted text-xs hover:text-red-400 transition-colors">
            <Trash2 className="w-3 h-3 inline mr-1" />
            清空
          </button>
        </div>
      </div>
      {errors.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-6">暂无错误记录</p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {errors.map((e) => (
            <div key={e.id} className="rounded-xl border border-surface-hairline bg-surface-darkest p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-primary">{e.source}</span>
                <span className="text-xs text-text-muted shrink-0">{e.createdAt}</span>
              </div>
              <p className="text-xs text-text-secondary mt-1 break-all">{e.message}</p>
              {expanded && e.stack && <pre className="text-xs text-text-muted mt-1 whitespace-pre-wrap break-all">{e.stack}</pre>}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
