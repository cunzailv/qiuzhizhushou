// 基于页面 DOM 的登录态判定（cookie 名变动时的兜底）
//
// 背景：auth-checker 依赖固定 cookie 名判断登录，平台一旦改名或换成 httpOnly 的新机制，
// 就会把「已登录」误判成「未登录」，导致整个平台被跳过、用户还以为账号掉了。
// 这里从页面实际渲染结果读状态：有头像/用户区 = 已登录，只有登录入口 = 未登录。

export type PageLoginState = 'logged-in' | 'logged-out' | 'unknown'

/** 头像 / 用户信息区域（各平台通用特征） */
const AVATAR_SELECTORS = [
  'img[class*="avatar"]',
  '[class*="avatar"]',
  '[class*="user-info"]',
  '[class*="userInfo"]',
  '[class*="user-name"]',
  '[class*="userName"]',
  '[class*="header-user"]',
  '[class*="personal-center"]',
  'img[alt*="头像"]',
]

/** 登录入口特征 */
const LOGIN_ENTRY_SELECTORS = [
  'a[href*="login"]',
  'a[href*="passport"]',
  '[class*="login-btn"]',
  '[class*="loginBtn"]',
]

/** 完全等于这些文案的可点击元素视为「登录入口」 */
const LOGIN_TEXT_RE = /^(登录|立即登录|登录\/注册|登录或注册|去登录|Sign in|Log in)$/i

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el as HTMLElement)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

/** 从当前页面 DOM 推断登录态；无法判断时返回 unknown，调用方应保留原有判定 */
export function detectLoginStateFromDom(): PageLoginState {
  if (typeof document === 'undefined' || !document.body) return 'unknown'

  // 1. 已登录强信号：头像 / 用户信息区
  for (const sel of AVATAR_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(sel))
    if (nodes.some((n) => isVisible(n))) return 'logged-in'
  }

  // 2. 未登录信号：存在登录入口，且页面上没有头像
  for (const sel of LOGIN_ENTRY_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll(sel))
    if (nodes.some((n) => isVisible(n))) return 'logged-out'
  }

  const clickable = Array.from(document.querySelectorAll('a, button'))
  if (clickable.some((el) => LOGIN_TEXT_RE.test((el.textContent || '').trim()) && isVisible(el))) {
    return 'logged-out'
  }

  // 3. 无法判断：交由 cookie 判定结果决定
  return 'unknown'
}
