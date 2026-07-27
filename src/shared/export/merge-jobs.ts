import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import type { JobCard } from '../types/job'

export async function downloadAndMergeJobs(
  jobs: JobCard[],
  fileName?: string
): Promise<void> {
  const headers = [
    '公司名称', '岗位名称', '薪资', '工作地点', '经验要求',
    '学历要求', '标签', '岗位描述', 'HR姓名', 'HR职位', '投递链接',
  ]

  const rows = jobs.map((job) => [
    job.companyName,
    job.title,
    job.salary,
    job.location,
    job.experience,
    job.education,
    (job.tags || []).join('、'),
    job.jobDescription || '',
    job.bossName || '',
    job.bossTitle || '',
    job.url || '',
  ])

  const data = [headers, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(data)
  ws['!cols'] = [
    { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 50 },
    { wch: 12 }, { wch: 12 }, { wch: 40 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '岗位信息')

  const exportFileName = `${fileName || `岗位信息汇总_${new Date().toISOString().slice(0, 10)}`}.xlsx`
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  saveAs(blob, exportFileName)
}

export function mergeJobs(jobsArrays: JobCard[][]): JobCard[] {
  const seen = new Set<string>()
  const result: JobCard[] = []

  for (const jobs of jobsArrays) {
    for (const job of jobs) {
      if (!seen.has(job.id)) {
        seen.add(job.id)
        result.push(job)
      }
    }
  }

  return result
}
