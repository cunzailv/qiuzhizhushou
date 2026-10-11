import React, { useEffect, useState } from 'react'
import { Card } from '../../components/ui/card'
import { Toast } from '../../components/ui/toast'
import { getAllResumes, deleteResume, setDefaultResume } from '../../shared/db/resume-store'
import { FileText, Star, Trash2 } from 'lucide-react'

function formatTime(t: string): string {
  if (!t) return '-'
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function Resumes() {
  const [rows, setRows] = useState<any[]>([])
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setRows(await getAllResumes())
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ ...toast, visible: false }), 3000)
  }

  async function handleSetDefault(r: any) {
    await setDefaultResume(r.id)
    await loadAll()
    showToast(`已设为默认简历：${r.name}`)
  }

  async function handleDelete(r: any) {
    if (!confirm(`确认删除简历「${r.name}」？此操作不可恢复。`)) return
    await deleteResume(r.id)
    await loadAll()
    showToast('简历已删除', 'info')
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">简历管理</h2>
        <p className="text-sm text-text-muted mt-1">管理投递使用的简历：默认简历用于匹配与投递</p>
      </div>

      <Card>
        {rows.length === 0 ? (
          <div className="p-10 text-center">
            <FileText className="w-8 h-8 mx-auto mb-2 text-text-muted/50" />
            <p className="text-sm text-text-muted">暂无简历</p>
            <p className="text-xs text-text-muted/60 mt-1">在扩展弹窗的「简历」页上传 PDF/DOCX 后，会出现在这里</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const isDefault = r.isDefault
              const skills = r.structuredData?.skills?.slice(0, 6) || []
              const years = r.profile?.yearsOfExperience ?? r.structuredData?.yearsOfExperience
              return (
                <div key={r.id} className={`rounded-2xl border p-4 ${isDefault ? 'border-primary/40 bg-primary/5' : 'border-black/10 bg-surface-darkest'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isDefault ? 'bg-primary/20 text-primary-light' : 'bg-black/5 text-text-muted'}`}>
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-text-primary truncate">{r.name}</span>
                          {isDefault && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-primary/15 text-primary-light text-[10px] font-medium">
                              <Star className="w-2.5 h-2.5" />
                              默认
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-text-muted truncate">
                          {r.structuredData?.name || '未命名'} · {years != null ? `${years} 年经验` : '经验未知'}
                          {skills.length > 0 ? ` · ${skills.join('、')}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-text-muted">更新于 {formatTime(r.updatedAt)}</span>
                      {!isDefault && (
                        <button
                          onClick={() => handleSetDefault(r)}
                          className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-orange-400 to-orange-500 text-white text-xs font-medium hover:opacity-90 transition-opacity"
                        >
                          设为默认
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(r)}
                        className="p-2 rounded-lg bg-black/5 text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="删除简历"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
