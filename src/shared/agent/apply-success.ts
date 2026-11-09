/**
 * 51job 投递成功页 → 平台侧确认证据。
 *
 * 现场问题：51job 点「投递」不是弹窗，而是**整页跳转**到
 *   https://jobs.51job.com/applysuccess.php?jobid=173879321
 * 页面一导航，content script 的执行上下文就被销毁了，
 * 「点击后采集确认文案 → decideApplyVerification → 回传 done」这半段根本跑不完。
 * 结果是：岗位其实投成功了，插件却既没记成功、也没记配额，
 * 后台标签还停在成功页，下一个任务又报「未找到对应岗位卡片」，
 * 连续两次就触发「清空待投缓存」自愈，队列被反复清掉（现场观察到 156 次）。
 *
 * 这个 URL 本身就是平台侧最强的确认证据，而且带 jobid 能精确关联岗位。
 * 因此在 background 侧监听 tab URL 变化来补记成功，完全不依赖 content script 生命周期。
 */

/** 51job 投递成功页 / 其它平台同类成功落地页 */
const APPLY_SUCCESS_RE = /applysuccess\.php|\/apply\/success|apply[_-]?success/i
/** 成功页 URL 上的岗位 ID；51job 用 jobid，兼容 jobId / job_id / positionId */
const JOB_ID_QUERY_RE = /[?&](?:jobid|jobId|job_id|positionId)=(\d+)/i
/** 少数站点把 ID 放在路径末尾 */
const JOB_ID_PATH_RE = /\/(\d{6,})(?:\.html?)?(?:[?#]|$)/i

export interface ApplySuccessTaskLike {
  id: string
  platform: string
  jobId: string
  jobUrl: string
  status: string
}

export function isApplySuccessUrl(url?: string | null): boolean {
  return !!url && APPLY_SUCCESS_RE.test(url)
}

/** 只从「成功页」URL 里取岗位 ID，避免任何普通页面被当成投递回执 */
export function parseApplySuccessJobId(url?: string | null): string | null {
  if (!isApplySuccessUrl(url)) return null
  const query = JOB_ID_QUERY_RE.exec(url!)
  if (query) return query[1]
  const path = JOB_ID_PATH_RE.exec(url!)
  return path ? path[1] : null
}

/**
 * 按 jobid 在队列里找本次投递对应的任务。
 * 只认 51job、只认未 done 的任务；优先当前 running（刚认领的那个），
 * 其次 failed / skipped —— content 侧因整页导航中断时，任务可能已被标成 failed。
 * 拿不到 jobid 时一律不补记，绝不把成功页含糊地算到「最近一个任务」头上。
 */
export function findApplySuccessTask<T extends ApplySuccessTaskLike>(
  tasks: readonly T[],
  url: string,
  platform = '51job',
): T | null {
  if (!isApplySuccessUrl(url)) return null
  const jobId = parseApplySuccessJobId(url)
  if (!jobId) return null
  const candidates = tasks.filter(
    (t) =>
      t.platform === platform &&
      t.status !== 'done' &&
      (t.jobId === jobId || t.jobUrl.includes(jobId) || t.id.includes(jobId)),
  )
  return candidates.find((t) => t.status === 'running') || candidates[0] || null
}
