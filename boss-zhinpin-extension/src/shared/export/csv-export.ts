import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import type { Application } from '../types/application'
import { APPLICATION_STATUS_LABELS } from '../types/application'
import { formatDate } from '../utils'

export interface ExportOptions {
  applications: Application[]
  format: 'csv' | 'xlsx'
  fileName?: string
}

export function exportApplications({ applications, format, fileName }: ExportOptions): void {
  const headers = [
    '投递时间', '岗位名称', '公司名称', '薪资', '工作地点',
    '经验要求', '学历要求', '标签', '职位描述', '状态', '匹配分数',
    '匹配理由', 'HR姓名', 'HR职位', '备注',
  ]

  const rows = applications.map((app) => [
    formatDate(app.appliedAt),
    app.jobTitle,
    app.companyName,
    app.salary,
    app.location,
    app.experience,
    app.education,
    (app.tags || []).join('、'),
    app.jobDescription || '',
    APPLICATION_STATUS_LABELS[app.status],
    app.matchScore === null ? '未评分' : `${app.matchScore}分`,
    app.matchReason || '',
    app.bossName || '',
    app.bossTitle || '',
    app.notes || '',
  ])

  const data = [headers, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(data)

  // Set column widths
  ws['!cols'] = headers.map(() => ({ wch: 18 }))

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '投递记录')

  const exportFileName = `${fileName || `投递记录_${new Date().toISOString().slice(0, 10)}`}.${format === 'csv' ? 'csv' : 'xlsx'}`

  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(ws)
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    saveAs(blob, exportFileName)
  } else {
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    saveAs(blob, exportFileName)
  }
}

export async function exportBlacklistCSV(
  items: Array<{ companyName: string; reason: string }>
): Promise<void> {
  const headers = ['公司名称', '拉黑原因']
  const rows = items.map((item) => [item.companyName, item.reason])
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])

  // Fix: use csv format instead
  const csv = XLSX.utils.sheet_to_csv(ws)
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  saveAs(blob, `黑名单_${new Date().toISOString().slice(0, 10)}.csv`)
}
