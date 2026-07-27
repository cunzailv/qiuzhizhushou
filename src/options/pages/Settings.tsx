import React, { useState, useEffect, useRef } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Toast } from '../../components/ui/toast'
import { getSetting, setSetting, getAllSettings } from '../../shared/db/settings-store'
import { testAIConnection, BUILTIN_MODELS, getPresetById } from '../../shared/ai'
import type { PluginSettings } from '../../shared/types/settings'
import { DEFAULT_SETTINGS } from '../../shared/types/settings'
import { getPlatformsMeta } from '../../shared/platform'
import { Key, Zap, Shield, ChevronDown, ExternalLink, AlertTriangle, Globe } from 'lucide-react'

export default function Settings() {
  const [settings, setLocalSettings] = useState<PluginSettings>(DEFAULT_SETTINGS)
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })
  const [testing, setTesting] = useState(false)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [platformOverride, setPlatformOverride] = useState('auto')

  const selectedPreset = getPresetById(settings.modelPreset)
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

  async function handleSelectPreset(presetId: string) {
    setShowModelDropdown(false)
    const preset = getPresetById(presetId)
    if (!preset) return

    const updates: Partial<PluginSettings> = {
      modelPreset: presetId,
      apiBaseUrl: preset.baseUrl,
      modelName: preset.modelName,
    }
    await handleSave(updates)
  }

  async function handleTestAPI() {
    setTesting(true)
    const result = await testAIConnection()
    showToast(result.message, result.success ? 'success' : 'error')
    setTesting(false)
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">扩展设置</h2>
        <p className="text-sm text-text-muted mt-1">配置 AI 模型、投递策略和通知偏好</p>
      </div>

      {/* Platform */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-primary-light" />
          <span className="font-semibold text-text-primary">平台识别</span>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-1.5 block">当前平台策略</label>
          <select
            value={platformOverride}
            onChange={(e) => handlePlatformOverrideChange(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl bg-surface-darkest border border-white/10 text-sm text-text-primary focus:border-primary-light focus:outline-none"
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
          <span className="font-semibold text-text-primary">AI 模型配置</span>
        </div>

        <div className="space-y-4">
          {/* Model Selector */}
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">选择模型</label>
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="w-full px-3 py-2.5 rounded-xl bg-surface-darkest border border-white/10 text-left flex items-center justify-between hover:border-white/20 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{selectedPreset?.name || '选择模型'}</span>
                  <span className="text-xs text-text-muted">{selectedPreset?.provider}</span>
                  {selectedPreset?.free && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-success/10 text-success">免费额度</span>
                  )}
                </div>
                <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showModelDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 p-2 rounded-xl bg-surface-dark border border-white/10 shadow-2xl z-50 max-h-[320px] overflow-y-auto">
                  {BUILTIN_MODELS.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => handleSelectPreset(model.id)}
                      className={`w-full px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-white/5 ${
                        settings.modelPreset === model.id ? 'bg-primary/10 ring-1 ring-primary/30' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-sm font-medium text-text-primary">{model.name}</span>
                        <div className="flex items-center gap-2">
                          {model.free && <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success">免费</span>}
                          {settings.modelPreset === model.id && (
                            <div className="w-2 h-2 rounded-full bg-primary-light" />
                          )}
                        </div>
                      </div>
                      <div className="text-[11px] text-text-muted">
                        {model.provider} · {model.description}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="text-xs text-text-muted mb-1.5 block">API Key</label>
            <div className="flex gap-3">
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => handleSave({ apiKey: e.target.value })}
                className="flex-1 px-3 py-2.5 rounded-xl bg-surface-darkest border border-white/10 text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
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
          </div>

          {/* Custom model fields */}
          {isCustom && (
            <div className="grid grid-cols-2 gap-4 p-3 rounded-xl bg-surface-darkest/50 border border-white/5">
              <div>
                <label className="text-xs text-text-muted mb-1.5 block">API Base URL</label>
                <input
                  type="text"
                  value={settings.apiBaseUrl}
                  onChange={(e) => handleSave({ apiBaseUrl: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-white/10 text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1.5 block">模型名称</label>
                <input
                  type="text"
                  value={settings.modelName}
                  onChange={(e) => handleSave({ modelName: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-surface-darkest border border-white/10 text-sm text-text-primary placeholder-text-muted focus:border-primary-light focus:outline-none"
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

      {/* Anti-bot */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-5 h-5 text-success" />
          <span className="font-semibold text-text-primary">防封策略</span>
        </div>
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
                onChange={(e) => handleSave({ dailyLimit: parseInt(e.target.value) })}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
                <span>10</span><span>10000</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-text-muted mb-1.5 block">最小延迟</label>
              <select
                value={settings.minDelay}
                onChange={(e) => handleSave({ minDelay: parseInt(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl bg-surface-darkest border border-white/10 text-sm"
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
                onChange={(e) => handleSave({ maxDelay: parseInt(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl bg-surface-darkest border border-white/10 text-sm"
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
              onChange={(e) => handleSave({ maxScanCount: parseInt(e.target.value) })}
              className="w-full px-3 py-2 rounded-xl bg-surface-darkest border border-white/10 text-sm"
            >
              {[10, 20, 30, 50, 80, 100, 150, 200].map((v) => (
                <option key={v} value={v}>{v} 个</option>
              ))}
              <option value={0}>不限制（扫描到无更多为止）</option>
            </select>
            <p className="text-xs text-text-muted mt-1.5">每次点击「开始投递」时，扫描/采集的最大岗位数量。数值越大耗时越长。</p>
          </div>

          <div>
            <label className="text-xs text-text-muted mb-1.5 block">投递模式</label>
            <div className="flex gap-2">
              <button
                onClick={() => handleSave({ applyMode: 'batch' })}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  settings.applyMode === 'batch'
                    ? 'bg-primary/20 text-primary-light ring-1 ring-primary/30'
                    : 'bg-surface-darkest text-text-muted'
                }`}
              >
                一键批量投递
              </button>
              <button
                onClick={() => handleSave({ applyMode: 'recommend' })}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  settings.applyMode === 'recommend'
                    ? 'bg-primary/20 text-primary-light ring-1 ring-primary/30'
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
              启用 AI 评分筛选（关闭后「一键投递」不评分、直接投递）
            </span>
          </label>
        </div>
      </Card>

      {/* Warning */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-warning/10 border border-warning/20">
        <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-text-secondary font-medium">安全提示</p>
          <p className="text-xs text-text-muted mt-0.5">
            建议每天不超过 {settings.dailyLimit} 次投递。所有数据存储在浏览器本地，不会上传到任何服务器。
            你的 API Key 也仅保存在浏览器中，用于直接调用所选的大模型 API。
          </p>
        </div>
      </div>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
