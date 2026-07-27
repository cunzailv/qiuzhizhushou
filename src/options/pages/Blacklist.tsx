import React, { useState, useEffect, useRef } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Toast } from '../../components/ui/toast'
import { getBlacklist, addToBlacklist, removeFromBlacklist, importBlacklist } from '../../shared/db/blacklist-store'
import type { BlacklistItem } from '../../shared/db'
import {
  Ban, Plus, Trash2, Upload, Download, Search,
} from 'lucide-react'
import { exportBlacklistCSV } from '../../shared/export'

export default function Blacklist() {
  const [items, setItems] = useState<BlacklistItem[]>([])
  const [search, setSearch] = useState('')
  const [newCompany, setNewCompany] = useState('')
  const [newReason, setNewReason] = useState('')
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadItems()
  }, [])

  async function loadItems() {
    const list = await getBlacklist()
    setItems(list)
  }

  async function handleAdd() {
    if (!newCompany.trim()) return
    await addToBlacklist(newCompany.trim(), newReason.trim() || '手动添加')
    setNewCompany('')
    setNewReason('')
    await loadItems()
    showToast('已添加', 'success')
  }

  async function handleRemove(id: string) {
    await removeFromBlacklist(id)
    await loadItems()
    showToast('已移除', 'info')
  }

  async function handleExport() {
    if (items.length === 0) {
      showToast('黑名单为空', 'warning')
      return
    }
    await exportBlacklistCSV(items.map((i) => ({ companyName: i.companyName, reason: i.reason })))
    showToast('导出成功', 'success')
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const lines = text.split('\n').filter((l) => l.trim())
    // Skip header
    const data = lines.slice(1).map((line) => {
      const parts = line.split(',').map((p) => p.replace(/^"|"$/g, '').trim())
      return { companyName: parts[0], reason: parts[1] || '' }
    }).filter((d) => d.companyName)

    const count = await importBlacklist(data)
    await loadItems()
    showToast(`成功导入 ${count} 家公司`, 'success')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ visible: false, message: '', type: 'info' }), 3000)
  }

  const filtered = items.filter((item) => {
    if (!search) return true
    const q = search.toLowerCase()
    return item.companyName.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold gradient-text">公司黑名单</h1>
          <p className="text-sm text-text-muted mt-1">投递时自动跳过黑名单中的公司</p>
        </div>
      </div>

      {/* Add Form */}
      <Card className="p-5">
        <div className="flex gap-3">
          <input
            type="text"
            value={newCompany}
            onChange={(e) => setNewCompany(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="input-field flex-1"
            placeholder="输入公司名称..."
          />
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="input-field flex-1"
            placeholder="拉黑原因（可选）"
          />
          <Button onClick={handleAdd}>
            <Plus className="w-4 h-4" />
            添加
          </Button>
        </div>
      </Card>

      {/* Actions & Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field pl-9"
            placeholder="搜索黑名单..."
          />
        </div>
        <Button variant="secondary" size="sm" onClick={handleExport}>
          <Download className="w-3.5 h-3.5" />
          导出CSV
        </Button>
        <label className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl bg-surface-light text-text-secondary hover:bg-surface-medium border border-white/10 transition-all duration-200 cursor-pointer">
          <Upload className="w-3.5 h-3.5" />
          导入CSV
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            onChange={handleImport}
            className="hidden"
          />
        </label>
      </div>

      {/* List */}
      <div className="grid grid-cols-2 gap-3">
        {filtered.length === 0 ? (
          <div className="col-span-2 text-center py-12">
            <Ban className="w-12 h-12 mx-auto text-text-muted mb-3" />
            <p className="text-sm text-text-muted">黑名单为空</p>
          </div>
        ) : (
          filtered.map((item) => (
            <Card key={item.id} className="flex items-center justify-between p-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{item.companyName}</p>
                <p className="text-xs text-text-muted mt-0.5">{item.reason}</p>
              </div>
              <button
                onClick={() => handleRemove(item.id)}
                className="p-1.5 text-text-muted hover:text-danger hover:bg-danger/10 rounded-lg transition-colors ml-2"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </Card>
          ))
        )}
      </div>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
