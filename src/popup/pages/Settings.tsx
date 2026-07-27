import React, { useState, useEffect, useRef } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Toast } from '../../components/ui/toast'
import { setSetting, getAllSettings } from '../../shared/db/settings-store'
import { testAIConnection, BUILTIN_MODELS, getPresetById } from '../../shared/ai'
import { getBlacklist } from '../../shared/db/blacklist-store'
import { exportApplications } from '../../shared/export'
import { getAllApplications } from '../../shared/db/application-store'
import type { PluginSettings } from '../../shared/types/settings'
import { DEFAULT_SETTINGS } from '../../shared/types/settings'
import {
  Key, Zap, Shield, Download, AlertTriangle,
  ChevronDown, ExternalLink,
} from 'lucide-react'

export default function Settings() {
  const [settings, setLocalSettings] = useState<PluginSettings>(DEFAULT_SETTINGS)
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })
  const [testing, setTesting] = useState(false)
  const [blacklistCount, setBlacklistCount] = useState(0)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

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
    const merged = { ...DEFAULT_SETTINGS, ...all } as PluginSettings
    setLocalSettings(merged)

    const bl = await getBlacklist()
    setBlacklistCount(bl.length)
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

    const updates: Partial<PluginSettings> = { modelPreset: presetId }

    if (presetId !== 'custom') {
      // 内置模型：自动填入预设的 Base URL 和模型名
      updates.apiBaseUrl = preset.baseUrl
      updates.modelName = preset.modelName
    }
    // 自定义模式：清空让用户自己填
    if (presetId === 'custom') {
      updates.apiBaseUrl = 'https://api.openai.com/v1'
      updates.modelName = 'gpt-4o-mini'
    }

    await handleSave(updates)
  }

  async function handleTestAPI() {
    setTesting(true)
    const result = await testAIConnection()
    showToast(result.message, result.success ? 'success' : 'error')
    setTesting(false)
  }

  async function handleExport() {
    const apps = await getAllApplications()
    if (apps.length === 0) {
      showToast('暂无投递记录可导出', 'warning')
      return
    }
    exportApplications({ applications: apps, format: 'xlsx' })
    showToast('导出成功', 'success')
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-bold gradient-text">设置</h2>

      {/* AI Model Selection */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Key className="w-4 h-4 text-primary-light" />
          <span className="text-sm font-semibold text-text-primary">AI 模型配置</span>
        </div>
        <div className="space-y-2">
          {/* Model Preset Dropdown */}
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">选择模型</label>
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="w-full input-field flex items-center justify-between text-left pr-8"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium truncate">
                    {selectedPreset ? `${selectedPreset.name}` : '选择模型'}
                  </span>
                  <span className="text-[10px] text-text-muted truncate">
                    {selectedPreset?.provider}
                  </span>
                  {selectedPreset?.free && (
                    <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-success/10 text-success">免费</span>
                  )}
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-text-muted shrink-0 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showModelDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 p-1 rounded-xl bg-surface-dark border border-white/10 shadow-xl z-50 max-h-[260px] overflow-y-auto">
                  {BUILTIN_MODELS.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => handleSelectPreset(model.id)}
                      className={`w-full px-3 py-2 rounded-lg text-left transition-colors hover:bg-white/5 ${
                        settings.modelPreset === model.id ? 'bg-primary/10' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-text-primary truncate">{model.name}</div>
                          <div className="text-[10px] text-text-muted">{model.provider} · {model.description.substring(0, 20)}</div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {model.free && <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success">免费</span>}
                          {settings.modelPreset === model.id && (
                            <div className="w-2 h-2 rounded-full bg-primary-light" />
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* API Key Input */}
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">API Key</label>
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => handleSave({ apiKey: e.target.value })}
              className="input-field"
              placeholder={
                selectedPreset
                  ? `输入 ${selectedPreset.provider} 的 API Key`
                  : '输入 API Key'
              }
            />
            {selectedPreset && selectedPreset.docsUrl && (
              <a
                href={selectedPreset.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-1 text-[10px] text-primary-light hover:underline"
              >
                获取 {selectedPreset.provider} API Key
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </div>

          {/* Custom model: show manual fields */}
          {isCustom && (
            <>
              <div>
                <label className="text-[11px] text-text-muted mb-1 block">API Base URL</label>
                <input
                  type="text"
                  value={settings.apiBaseUrl}
                  onChange={(e) => handleSave({ apiBaseUrl: e.target.value })}
                  className="input-field"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="text-[11px] text-text-muted mb-1 block">模型名称</label>
                <input
                  type="text"
                  value={settings.modelName}
                  onChange={(e) => handleSave({ modelName: e.target.value })}
                  className="input-field"
                  placeholder="gpt-4o-mini"
                />
              </div>
            </>
          )}

          {/* Toggle + Test */}
          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.aiEnabled}
                onChange={(e) => handleSave({ aiEnabled: e.target.checked })}
                className="w-4 h-4 rounded accent-primary"
              />
              <span className="text-xs text-text-secondary">启用 AI 分析</span>
            </label>
            <Button size="sm" variant="secondary" onClick={handleTestAPI} loading={testing}>
              <Zap className="w-3 h-3" />
              测试连接
            </Button>
          </div>
        </div>
      </Card>

      {/* Anti-bot Settings */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-success" />
          <span className="text-sm font-semibold text-text-primary">防封策略</span>
        </div>
        <div className="space-y-2">
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">
              每日投递上限: {settings.dailyLimit} 次
            </label>
            <input
              type="range"
              min={10}
              max={10000}
              step={10}
              value={settings.dailyLimit}
              onChange={(e) => handleSave({ dailyLimit: parseInt(e.target.value) })}
              className="w-full accent-primary"
            />
          </div>
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">
              操作延迟范围: {settings.minDelay / 1000}s - {settings.maxDelay / 1000}s
            </label>
            <div className="flex gap-2">
              <select
                value={settings.minDelay}
                onChange={(e) => handleSave({ minDelay: parseInt(e.target.value) })}
                className="input-field flex-1 text-xs"
              >
                {[1000, 2000, 3000, 5000].map((v) => (
                  <option key={v} value={v}>{v / 1000}秒</option>
                ))}
              </select>
              <span className="text-text-muted self-center">-</span>
              <select
                value={settings.maxDelay}
                onChange={(e) => handleSave({ maxDelay: parseInt(e.target.value) })}
                className="input-field flex-1 text-xs"
              >
                {[3000, 5000, 8000, 10000, 15000].map((v) => (
                  <option key={v} value={v}>{v / 1000}秒</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">
              单次扫描数量: {settings.maxScanCount > 0 ? `${settings.maxScanCount} 个` : '不限制'}
            </label>
            <select
              value={settings.maxScanCount}
              onChange={(e) => handleSave({ maxScanCount: parseInt(e.target.value) })}
              className="input-field w-full text-xs"
            >
              {[10, 20, 30, 50, 80, 100, 150, 200].map((v) => (
                <option key={v} value={v}>{v} 个</option>
              ))}
              <option value={0}>不限制</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-text-muted mb-1 block">投递模式</label>
            <div className="flex gap-2">
              <button
                onClick={() => handleSave({ applyMode: 'batch' })}
                className={`flex-1 px-3 py-2 text-xs rounded-lg transition-colors ${
                  settings.applyMode === 'batch'
                    ? 'bg-primary/20 text-primary-light'
                    : 'bg-surface-darkest text-text-muted'
                }`}
              >
                一键批量投递
              </button>
              <button
                onClick={() => handleSave({ applyMode: 'recommend' })}
                className={`flex-1 px-3 py-2 text-xs rounded-lg transition-colors ${
                  settings.applyMode === 'recommend'
                    ? 'bg-primary/20 text-primary-light'
                    : 'bg-surface-darkest text-text-muted'
                }`}
              >
                AI推荐确认
              </button>
            </div>
          </div>
        </div>
      </Card>

      {/* Data Management */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Download className="w-4 h-4 text-info" />
          <span className="text-sm font-semibold text-text-primary">数据管理</span>
        </div>
        <div className="space-y-2">
          <Button variant="secondary" size="sm" className="w-full" onClick={handleExport}>
            <Download className="w-3.5 h-3.5" />
            导出投递记录 (Excel)
          </Button>
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span>黑名单公司</span>
            <span>{blacklistCount} 家</span>
          </div>
        </div>
      </Card>

      {/* Safety Warning */}
      <div className="flex items-start gap-2 p-3 rounded-xl bg-warning/10 border border-warning/20">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary">
          自动化投递功能仅用于提高效率，请合理使用。建议保持每天50次以内的投递量，避免账号被限制。
        </p>
      </div>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
