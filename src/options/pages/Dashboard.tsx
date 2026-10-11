import React, { useState, useEffect } from 'react'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { getStats, getAllApplications } from '../../shared/db/application-store'
import { getAllResumes } from '../../shared/db/resume-store'
import { getBlacklist } from '../../shared/db/blacklist-store'
import { getCareerProfile, type CareerProfile, type CareerStatus } from '../../shared/db/career-store'
import type { Application } from '../../shared/types/application'
import { APPLICATION_STATUS_LABELS } from '../../shared/types/application'
import { formatRelativeTime } from '../../shared/utils/date'
import {
  TrendingUp, Send, Eye, CalendarCheck, Target, FileText, Ban, Compass, Sparkles, ArrowUpRight,
} from 'lucide-react'

const STATUS_LABELS: Record<CareerStatus, { label: string; color: string; bg: string }> = {
  seeking: { label: '求职中', color: '#F97316', bg: 'rgba(249,115,22,0.12)' },
  working: { label: '在职', color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
  interviewing: { label: '面试中', color: '#8B5CF6', bg: 'rgba(139,92,246,0.12)' },
  onboarded: { label: '已入职', color: '#10B981', bg: 'rgba(16,185,129,0.12)' },
}

const SKILL_LEVEL_COLOR: Record<string, string> = { 精通: '#F97316', 熟练: '#10B981', 了解: '#9CA3AF' }

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, today: 0, interview: 0, read: 0, passRate: 0 })
  const [resumeCount, setResumeCount] = useState(0)
  const [blacklistCount, setBlacklistCount] = useState(0)
  const [recentApps, setRecentApps] = useState<Application[]>([])
  const [career, setCareer] = useState<CareerProfile | null>(null)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    const s = await getStats()
    setStats(s)
    const apps = await getAllApplications()
    setRecentApps(apps.slice(0, 10))
    const resumes = await getAllResumes()
    setResumeCount(resumes.length)
    const bl = await getBlacklist()
    setBlacklistCount(bl.length)
    const cp = await getCareerProfile()
    setCareer(cp)
  }

  const statCards = [
    { label: '今日投递', value: stats.today, icon: Send, color: '#F97316' },
    { label: '总投递数', value: stats.total, icon: TrendingUp, color: '#FB923C' },
    { label: 'HR已读', value: stats.read, icon: Eye, color: '#3B82F6' },
    { label: '面试邀约', value: stats.interview, icon: CalendarCheck, color: '#10B981' },
    { label: '转化率', value: `${stats.passRate}%`, icon: Target, color: '#F59E0B' },
    { label: '简历数', value: resumeCount, icon: FileText, color: '#EC4899' },
    { label: '黑名单', value: blacklistCount, icon: Ban, color: '#EF4444' },
  ]

  function getStatusVariant(status: Application['status']): 'default' | 'success' | 'danger' | 'warning' | 'info' {
    const map: Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info'> = {
      applied: 'default', read: 'info', communicating: 'warning',
      interview: 'success', rejected: 'danger', hired: 'success',
    }
    return map[status]
  }

  // Status distribution
  const statusDist: Record<string, number> = {}
  const all = recentApps.length > 0 ? recentApps : []
  for (const app of all) {
    statusDist[app.status] = (statusDist[app.status] || 0) + 1
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold gradient-text">求职数据看板</h1>
        <p className="text-sm text-text-muted mt-1">全面了解你的求职进度</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.label} className="flex items-center gap-4 p-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: `${stat.color}15` }}>
              <stat.icon className="w-6 h-6" style={{ color: stat.color }} />
            </div>
            <div>
              <p className="text-2xl font-bold text-text-primary">{stat.value}</p>
              <p className="text-xs text-text-muted">{stat.label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* 职业状态看板（E4 职业镜子） */}
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Compass className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-text-primary">职业状态</h3>
          <span className="text-xs text-text-muted">AI 长期记忆 · 自动沉淀于每次匹配与投递</span>
          <div className="flex-1" />
          {career && (
            <span className="px-2.5 py-1 rounded-lg text-xs font-semibold"
              style={{ color: STATUS_LABELS[career.status].color, background: STATUS_LABELS[career.status].bg }}>
              {STATUS_LABELS[career.status].label}
            </span>
          )}
        </div>

        {!career || (career.skills.length === 0 && career.improvementDirections.length === 0 && !career.lastMatch) ? (
          <p className="text-xs text-text-muted py-2">暂无职业状态数据。启用 AI 匹配并完成首次投递后，这里会自动生成画像、技能与提升方向。</p>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 画像 */}
            <div>
              <p className="text-xs text-text-muted mb-2">画像快照</p>
              {career?.currentRole && <p className="text-sm font-semibold text-text-primary">{career.currentRole}</p>}
              <p className="text-xs text-text-muted mt-0.5">
                {[career?.yearsOfExperience ? `${career.yearsOfExperience} 年经验` : '', career?.education || '', career?.targetDirection || ''].filter(Boolean).join(' · ') || '待完善'}
              </p>
              {career && career.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {career.skills.slice(0, 8).map((s) => (
                    <span key={s.name} className="px-2 py-0.5 rounded-md text-xs font-medium bg-surface-darkest"
                      style={{ color: SKILL_LEVEL_COLOR[s.level] || '#4B5563' }}>
                      {s.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 长期目标 */}
            <div>
              <p className="text-xs text-text-muted mb-2">长期目标</p>
              {career && career.longTermGoals.length > 0 ? (
                <ul className="space-y-1.5">
                  {career.longTermGoals.map((g, i) => (
                    <li key={i} className="text-xs text-text-secondary flex gap-1.5">
                      <Target className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />{g}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-text-muted">暂无设定</p>}
            </div>

            {/* 提升方向 */}
            <div>
              <p className="text-xs text-text-muted mb-2">提升方向</p>
              {career && career.improvementDirections.length > 0 ? (
                <ul className="space-y-1.5">
                  {career.improvementDirections.slice(0, 5).map((d, i) => (
                    <li key={i} className="text-xs text-text-secondary flex gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />{d.skill}
                      <span className="text-text-muted">· {d.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-text-muted">暂无，完成匹配评估后自动沉淀差距</p>}
            </div>

            {/* 最近匹配 */}
            <div>
              <p className="text-xs text-text-muted mb-2">最近匹配</p>
              {career?.lastMatch ? (
                <div className="rounded-xl bg-surface-darkest p-3 border border-black/5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-text-primary truncate">{career.lastMatch.jobTitle}</span>
                    <span className="text-sm font-bold" style={{ color: career.lastMatch.overallScore >= 70 ? '#10B981' : career.lastMatch.overallScore >= 50 ? '#F59E0B' : '#EF4444' }}>
                      {Math.round(career.lastMatch.overallScore)}分
                    </span>
                  </div>
                  <p className="text-xs text-text-muted truncate mt-0.5">{career.lastMatch.jobCompany}</p>
                  <p className="text-xs text-text-secondary mt-1.5 leading-relaxed">{career.lastMatch.recommendation}</p>
                  <p className="text-[10px] text-text-muted mt-1.5">{formatRelativeTime(career.lastMatch.matchedAt)}</p>
                </div>
              ) : <p className="text-xs text-text-muted">暂无匹配记录</p>}
            </div>
          </div>
        )}
        {career && career.improvementDirections.length > 0 && (
          <p className="text-xs text-text-muted mt-3 flex items-center gap-1">
            <ArrowUpRight className="w-3.5 h-3.5" />
            提示：按提升方向补充简历项目与面试素材，可提高下一轮匹配得分。
          </p>
        )}
      </Card>

      {/* Status Distribution & Recent */}
      <div className="grid grid-cols-2 gap-4">
        {/* Status Distribution */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">状态分布</h3>
          <div className="space-y-3">
            {(Object.entries(APPLICATION_STATUS_LABELS) as [Application['status'], string][]).map(([status, label]) => (
              <div key={status} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant={getStatusVariant(status)}>{label}</Badge>
                </div>
                <span className="text-sm font-semibold text-text-primary">{statusDist[status] || 0}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Recent Activity */}
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">最近动态</h3>
          <div className="space-y-3">
            {recentApps.slice(0, 8).map((app) => (
              <div key={app.id} className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">{app.jobTitle}</p>
                  <p className="text-xs text-text-muted">{app.companyName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-muted">{formatRelativeTime(app.appliedAt)}</span>
                  <Badge variant={getStatusVariant(app.status)}>
                    {APPLICATION_STATUS_LABELS[app.status]}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
