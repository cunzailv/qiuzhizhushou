import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Toast } from '../../components/ui/toast'
import { getAllApplications } from '../../shared/db/application-store'
import { exportApplications, downloadAndMergeJobs } from '../../shared/export'
import type { Application } from '../../shared/types/application'
import { APPLICATION_STATUS_LABELS } from '../../shared/types/application'
import { formatDateShort } from '../../shared/utils/date'
import { Download, FileSpreadsheet, FileText, Filter, Users } from 'lucide-react'

export default function Export() {
  const [applications, setApplications] = useState<Application[]>([])
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx')
  const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' | 'warning' | 'info' }>({ visible: false, message: '', type: 'info' })

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const apps = await getAllApplications()
    setApplications(apps)
  }

  const filtered = filterStatus === 'all'
    ? applications
    : applications.filter((a) => a.status === filterStatus)

  async function handleExportApps() {
    if (filtered.length === 0) {
      showToast('没有符合条件的记录', 'warning')
      return
    }
    exportApplications({ applications: filtered, format })
    showToast(`已导出 ${filtered.length} 条记录`, 'success')
  }

  async function handleExportJobCards() {
    if (applications.length === 0) {
      showToast('没有沟通记录', 'warning')
      return
    }
    const jobs = applications.map((app) => ({
      id: app.jobId,
      title: app.jobTitle,
      companyName: app.companyName,
      companyLogo: app.companyLogo || '',
      salary: app.salary,
      location: app.location,
      experience: app.experience,
      education: app.education,
      tags: app.tags || [],
      jobDescription: app.jobDescription || '',
      bossName: app.bossName,
      bossTitle: app.bossTitle,
      bossOnline: false,
      publishedAt: app.appliedAt,
      url: `https://www.zhipin.com/job_detail/${app.jobId}.html`,
    }))
    await downloadAndMergeJobs(jobs, `岗位信息汇总_${new Date().toISOString().slice(0, 10)}`)
    showToast('岗位信息导出成功', 'success')
  }

  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    setToast({ visible: true, message, type })
    setTimeout(() => setToast({ visible: false, message: '', type: 'info' }), 3000)
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold gradient-text">数据导出中心</h1>
        <p className="text-sm text-text-muted mt-1">导出沟通记录和岗位信息</p>
      </div>

      {/* Export Options */}
      <div className="grid grid-cols-2 gap-4">
        {/* Export Applications */}
        <Card className="p-6">
          <FileSpreadsheet className="w-10 h-10 text-primary-light mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">导出沟通记录</h3>
          <p className="text-sm text-text-secondary mb-4">
            导出包含状态、匹配分、公司等信息
          </p>

          {/* Filter */}
          <div className="space-y-3 mb-4">
            <label className="text-xs text-text-muted flex items-center gap-1">
              <Filter className="w-3 h-3" /> 按状态筛选
            </label>
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setFilterStatus('all')}
                className={`px-2 py-1 text-[11px] rounded-lg transition-colors ${
                  filterStatus === 'all' ? 'bg-primary/20 text-primary-light' : 'bg-white/5 text-text-muted'
                }`}
              >
                全部 ({applications.length})
              </button>
              {(Object.entries(APPLICATION_STATUS_LABELS) as [Application['status'], string][]).map(([status, label]) => (
                <button
                  key={status}
                  onClick={() => setFilterStatus(status)}
                  className={`px-2 py-1 text-[11px] rounded-lg transition-colors ${
                    filterStatus === status ? 'bg-primary/20 text-primary-light' : 'bg-white/5 text-text-muted'
                  }`}
                >
                  {label} ({applications.filter((a) => a.status === status).length})
                </button>
              ))}
            </div>
          </div>

          {/* Format */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setFormat('xlsx')}
              className={`flex-1 px-3 py-2 text-xs rounded-lg ${
                format === 'xlsx' ? 'bg-primary/20 text-primary-light' : 'bg-surface-darkest text-text-muted'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5 inline mr-1" />
              Excel (.xlsx)
            </button>
            <button
              onClick={() => setFormat('csv')}
              className={`flex-1 px-3 py-2 text-xs rounded-lg ${
                format === 'csv' ? 'bg-primary/20 text-primary-light' : 'bg-surface-darkest text-text-muted'
              }`}
            >
              <FileText className="w-3.5 h-3.5 inline mr-1" />
              CSV
            </button>
          </div>

          <div className="text-xs text-text-muted mb-4">
            共 {filtered.length} 条记录
          </div>

          <Button className="w-full" onClick={handleExportApps}>
            <Download className="w-4 h-4" />
            导出沟通记录
          </Button>
        </Card>

        {/* Export Job Cards */}
        <Card className="p-6">
          <Users className="w-10 h-10 text-success mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">批量下载岗位信息</h3>
          <p className="text-sm text-text-secondary mb-4">
            合并所有沟通过的公司岗位信息到一个Excel文件
          </p>

          <div className="space-y-2 text-xs text-text-muted mb-4">
            <div className="flex justify-between">
              <span>包含公司</span>
              <span>{new Set(applications.map((a) => a.companyName)).size} 家</span>
            </div>
            <div className="flex justify-between">
              <span>包含岗位</span>
              <span>{applications.length} 个</span>
            </div>
            <div className="flex justify-between">
              <span>最近投递</span>
              <span>{formatDateShort(applications[0]?.appliedAt || '-')}</span>
            </div>
          </div>

          <Button className="w-full" variant="secondary" onClick={handleExportJobCards}>
            <Download className="w-4 h-4" />
            批量下载岗位信息
          </Button>
        </Card>
      </div>

      {/* Preview Table */}
      {filtered.length > 0 && (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            预览 ({filtered.length} 条)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted border-b border-white/5">
                  <th className="text-left py-2 pr-4">岗位</th>
                  <th className="text-left py-2 pr-4">公司</th>
                  <th className="text-left py-2 pr-4">职位描述</th>
                  <th className="text-left py-2 pr-4">薪资</th>
                  <th className="text-left py-2 pr-4">状态</th>
                  <th className="text-left py-2 pr-4">匹配分</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 20).map((app) => (
                  <tr key={app.id} className="border-b border-white/5">
                    <td className="py-2 pr-4 text-text-primary">{app.jobTitle}</td>
                    <td className="py-2 pr-4 text-text-secondary">{app.companyName}</td>
                    <td className="py-2 pr-4 text-text-secondary max-w-[220px] truncate" title={app.jobDescription || ''}>
                      {app.jobDescription
                        ? app.jobDescription.length > 40
                          ? `${app.jobDescription.slice(0, 40)}…`
                          : app.jobDescription
                        : '—'}
                    </td>
                    <td className="py-2 pr-4 text-text-secondary">{app.salary}</td>
                    <td className="py-2 pr-4">
                      <Badge>{APPLICATION_STATUS_LABELS[app.status]}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-text-secondary">
                      {app.matchScore === null ? '未评分' : `${app.matchScore}分`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Toast {...toast} onClose={() => setToast({ ...toast, visible: false })} />
    </div>
  )
}
