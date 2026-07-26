import type { JobCard } from '../shared/types/job'

interface JobMatchingTextFields {
  title: string
  companyName: string
  salary: string
  location: string
  experience: string
  education: string
  tags: string[]
  description: string
}

export function buildJobMatchingText(fields: JobMatchingTextFields): string {
  return [
    fields.title,
    fields.companyName,
    fields.salary,
    fields.location,
    fields.experience,
    fields.education,
    ...fields.tags,
    fields.description,
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ')
}

function generateJobId(url: string): string {
  // Extract job id from URL like /job_detail/xxx.html
  const match = url.match(/job_detail[/=](\w+)/)
  return match ? match[1] : Date.now().toString(36)
}

function getSearchCardElements(): Element[] {
  // BOSS currently nests elements such as `.job-card-box` inside
  // `.job-card-wrapper`. Matching every class containing "job-card" parses the
  // same vacancy more than once, so prefer the stable outer list item first.
  const outerCards = Array.from(document.querySelectorAll(
    'li.job-card-box, .job-card-wrapper, .recommend-job-card, .job-list-box > li',
  ))
  if (outerCards.length > 0) return outerCards

  return Array.from(document.querySelectorAll(
    '[class*="job-card"], [class*="jobCard"]',
  )).filter((candidate, index, candidates) => {
    return !candidates.some((parent, parentIndex) => (
      parentIndex !== index && parent.contains(candidate)
    ))
  })
}

// BOSS Zhipin encrypts numeric fields (salary, headcount, …) with a custom
// woff font: the real digits are mapped to Private-Use-Area (PUA) codepoints,
// so `textContent` yields garbage like "-K". We recover the digits by
// rendering each PUA character with the page's own font (which draws the true
// digit shape) and matching it against reference digit glyphs.
const PUA_RE = /[\uE000-\uF8FF]/
let digitRefs: Array<{ d: string; img: ImageData }> | null = null
let debugLogged = false
let debugDownloaded = false

// BOSS's anti-debug refreshes the page when DevTools is open, so we can't rely
// on the console. Instead, when the company name can't be extracted we download
// the raw card HTML to a file the user can simply send back for inspection.
function downloadCardDebug(cardHtml: string): void {
  if (debugDownloaded) return
  debugDownloaded = true
  try {
    const blob = new Blob([cardHtml], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'boss-card-debug.html'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch {
    /* ignore */
  }
}

function getDirectText(el: Element | null): string {
  if (!el) return ''
  const direct = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent || '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return direct || (el.textContent || '').replace(/\s+/g, ' ').trim()
}

// Company names often carry a keyword (公司/科技/集团…), but plenty don't
// (字节跳动 / 腾讯 / 华为). Used both to spot companies and to avoid treating
// a company as an address.
const COMPANY_KEYWORDS =
  /(?:公司|集团|科技|网络|技术|信息|实业|企业|厂|所|局|银行|医院|大学|学院|研究院|工作室|有限|电子|智能|数据|软件|互联|文化|传媒|教育|咨询|管理|生物|医疗|能源|电气|机械|建设|投资|控股|物流|食品|服饰)/

// An address on BOSS looks like "深圳·南山区·西丽" (the "·" separator) or a
// short "城市/区县" token, sometimes with road/building markers. A company
// name never uses "·" and rarely ends in 市/区/县, so this stays conservative
// to avoid misclassifying real company names (which was the earlier bug).
function looksLikeAddress(s: string): boolean {
  if (!s) return false
  if (COMPANY_KEYWORDS.test(s)) return false
  return (
    s.includes('·') ||
    /(路|街道|号|栋|室|广场|大厦|园区|镇|乡)/.test(s) ||
    /^[\u4e00-\u9fa5]{2,6}(市|区|县)$/.test(s)
  )
}

// BOSS sometimes glues the location onto the company name as
// "字节跳动深圳·南山区". Keep only the company part: cut everything from the
// first "·" (location marker), then drop a trailing bare "城市/区县" token —
// but only when doing so still leaves a meaningful (>=2 char) name.
function stripLocationSuffix(name: string): string {
  let out = name.split('·')[0].trim()
  out = out.replace(/[\u4e00-\u9fa5]{2,4}(?:市|区|县)$/, (m) =>
    out.length - m.length >= 2 ? '' : m,
  )
  return out.trim()
}

// Extract the REAL company name. On BOSS search cards the name is the text of
// the company anchor `a[href*="gongsi"]` (equivalently `.boss-info > .boss-name`),
// while the address lives in a separate `.company-location` node — so we read
// the anchor's own/direct text and never the location container. Verified
// against BOSS's own API (brandName) by open-source scrapers.
function extractCompanyName(root: Element | Document): string {
  const pickText = (el: Element): string => {
    const direct = getDirectText(el)
    const raw = direct || (el.textContent || '')
    return stripLocationSuffix(raw.replace(/\s+/g, ' ').trim())
  }

  // 1) The company page anchor is the most reliable source.
  const anchors = Array.from(root.querySelectorAll('a[href*="gongsi"]'))
  for (const a of anchors) {
    const t = pickText(a)
    if (t && !looksLikeAddress(t)) return t
  }

  // 2) Known company-name containers (BOSS uses `.boss-info > .boss-name`).
  const selectors = [
    '.boss-info .boss-name',
    '.boss-info',
    '.company-name',
    '[class*="company-name"]',
    '.company-text',
  ]
  for (const sel of selectors) {
    const el = root.querySelector(sel)
    if (!el) continue
    const t = pickText(el)
    if (t && !looksLikeAddress(t)) return t
  }

  // 3) Fallback: scan leaf text nodes for a company-like token, skipping the
  //    location container entirely so we never pick up the address.
  const leaves = Array.from(root.querySelectorAll('*')).filter(
    (n) => !n.children.length && !n.closest('.company-location, [class*="area"], [class*="location"], [class*="city"]'),
  )
  for (const n of leaves) {
    const t = (n.textContent || '').replace(/\s+/g, ' ').trim()
    if (t && COMPANY_KEYWORDS.test(t) && !looksLikeAddress(t)) return t
  }
  return ''
}

// Extract the full job description from an opened detail view. BOSS renders the
// JD in a `.job-sec` / `.job-detail-section` block further DOWN the page — NOT
// inside the apply-button's container (which is what `activateJobCard` returns).
// So we always search the whole document (the detail is open), and only narrow
// to the passed `root` as a secondary hint. We pick the section that explicitly
// carries the JD heading ("职位描述/岗位描述/岗位职责"), else the longest block.
export function extractJobDescriptionFromDetail(root: ParentNode = document): string {
  const scopes: ParentNode[] = [document]
  if (root && root !== document) scopes.unshift(root)

  const SELECTORS =
    '.job-sec, [class*="job-sec"], .job-detail-section, [class*="job-detail-section"], ' +
    '.job-describe, [class*="job-describe"], .job-desc, [class*="job-desc"], ' +
    '.job-sec-text, [class*="job-sec-text"]'

  let best = ''
  for (const scope of scopes) {
    const sections = Array.from(scope.querySelectorAll(SELECTORS))
    for (const sec of sections) {
      const text = (sec.textContent || '').replace(/\s+/g, ' ').trim()
      if (text.length < 8) continue
      const isDesc =
        text.includes('职位描述') ||
        text.includes('岗位描述') ||
        text.includes('岗位职责')
      if (isDesc) {
        if (text.length > best.length) best = text
      } else if (!best && text.length > 30) {
        best = text
      }
    }
    if (best) break
  }

  // Strip leading heading label(s).
  best = best
    .replace(/^职位描述[:：]?\s*/, '')
    .replace(/^岗位描述[:：]?\s*/, '')
    .replace(/^岗位职责[:：]?\s*/, '')
  // Cut trailing recruiter card / safety notice / action buttons.
  for (const marker of ['竞争力分析', 'BOSS安全提示', 'BOSS 安全提示', '立即沟通', '收藏', '举报']) {
    const i = best.indexOf(marker)
    if (i > 20) best = best.slice(0, i).trim()
  }
  return best.trim()
}

function fontFamilyOf(el: Element): string {
  try {
    return getComputedStyle(el as HTMLElement).fontFamily || 'sans-serif'
  } catch {
    return 'sans-serif'
  }
}

function cleanFontFamily(family: string): string {
  return family
    .split(',')[0]
    .replace(/['"]/g, '')
    .trim() || 'sans-serif'
}

function renderGlyph(ch: string, fontFamily: string, size = 32): ImageData | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.clearRect(0, 0, size, size)
    ctx.fillStyle = '#000'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.font = `bold ${size}px ${cleanFontFamily(fontFamily)}, sans-serif`
    ctx.fillText(ch, size / 2, size / 2)
    return ctx.getImageData(0, 0, size, size)
  } catch {
    return null
  }
}

function glyphSimilarity(a: ImageData, b: ImageData): number {
  const da = a.data
  const db = b.data
  let same = 0
  const total = da.length / 4
  for (let i = 0; i < da.length; i += 4) {
    const pa = da[i + 3] > 40 ? 1 : 0
    const pb = db[i + 3] > 40 ? 1 : 0
    if (pa === pb) same++
  }
  return same / total
}

function getDigitRefs(): Array<{ d: string; img: ImageData }> {
  if (digitRefs) return digitRefs
  digitRefs = []
  for (let n = 0; n <= 9; n++) {
    const img = renderGlyph(String(n), 'Arial')
    if (img) digitRefs.push({ d: String(n), img })
  }
  return digitRefs
}

export function decodeBossFontText(text: string, fontFamily = 'sans-serif'): string {
  if (!text || typeof document === 'undefined' || !PUA_RE.test(text)) return text
  const refs = getDigitRefs()
  if (refs.length === 0) return text

  let result = ''
  for (const ch of text) {
    if (!PUA_RE.test(ch)) {
      result += ch
      continue
    }
    const target = renderGlyph(ch, fontFamily)
    if (!target) {
      result += ch
      continue
    }
    let best = ch
    let bestScore = -1
    for (const ref of refs) {
      const score = glyphSimilarity(target, ref.img)
      if (score > bestScore) {
        bestScore = score
        best = ref.d
      }
    }
    // Only accept the guess when reasonably confident; otherwise keep the
    // original glyph so we never silently corrupt the data.
    result += bestScore >= 0.6 ? best : ch
  }
  return result
}

export function parseJobCardsFromSearchPage(): JobCard[] {
  const cards: JobCard[] = []
  const cardElements = getSearchCardElements()

  cardElements.forEach((el) => {
    const html = el as HTMLElement

    // --- Title: BOSS nests the job title in `.job-name` with the salary as a
    // sibling <span class="job-salary"> child. We must read the title link /
    // direct text AFTER removing that salary span, otherwise the salary leaks
    // into the title (e.g. "前后端开发工程师77-77K"). ---
    const titleEl = html.querySelector('.job-name, [class*="job-name"], [class*="job-title"], [class*="position"]')
    let title = ''
    if (titleEl) {
      const clone = titleEl.cloneNode(true) as Element
      clone
        .querySelectorAll('.job-salary, [class*="salary"], [class*="red"]')
        .forEach((s) => s.remove())
      const link = clone.querySelector('a')
      const direct = getDirectText(clone)
      title = (link?.textContent || direct || clone.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    title = decodeBossFontText(title, titleEl ? fontFamilyOf(titleEl) : 'sans-serif')

    // --- Company name: read the inner <a> text, never the container's direct
    // text (which is the address on BOSS). ---
    const companyName = extractCompanyName(html)

    // --- Salary: dedicated node, decrypt the encrypted font, and try the
    // element's title/data attribute (BOSS sometimes keeps plaintext there). ---
    const salaryEl = html.querySelector('.job-salary, .salary, [class*="salary"], [class*="red"]')
    let rawSalary = salaryEl?.textContent?.trim() || ''
    if (salaryEl) {
      const alt = salaryEl.getAttribute('title') || salaryEl.getAttribute('data-salary') || ''
      if (alt && /[\d]/.test(alt) && /[Kk元天]/.test(alt)) rawSalary = alt
    }
    const salary = decodeBossFontText(rawSalary, salaryEl ? fontFamilyOf(salaryEl) : 'sans-serif')

    // --- Location ---
    const locationEl = html.querySelector('.company-location, .job-area, [class*="job-area"], [class*="location"], [class*="area"], [class*="city"]')
    const location = (locationEl?.textContent || '').replace(/\s+/g, ' ').trim()

    // --- Experience / education / tags: read LEAF nodes only (no parent
    // containers) so each requirement stays a discrete item. ---
    const infoContainer = html.querySelector('.tag-list, .job-tags, [class*="tag-list"], [class*="job-info"], [class*="info-list"], .job-info, .info-primary')
    const infoNodes = infoContainer
      ? Array.from(infoContainer.querySelectorAll('*')).filter((n) => !n.children.length)
      : []
    const infos: string[] = []
    infoNodes.forEach((n) => {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim()
      if (t && t.length < 40 && !infos.includes(t)) infos.push(t)
    })

    const experience = infos.find((i) => /(\d+[-\s]*年)|应届|经验|不限/.test(i)) || ''
    const education = infos.find((i) => /本科|硕士|大专|博士|中专|高中|学历|不限/.test(i)) || ''
    const tags = infos.filter(
      (i) =>
        i !== experience &&
        i !== education &&
        !/(年|应届|本科|硕士|大专|博士|中专|高中|学历|融资|上市|民营|外资|国企|独资|代表处|非营利|少于|以上|规模|人|区|路|街道)/.test(i),
    )

    // Extract job URL
    const linkEl = html.querySelector('a[href*="job_detail"]')
    const url = linkEl ? (linkEl as HTMLAnchorElement).href : ''

    // Extract boss info
    const bossEl = html.querySelector('[class*="boss-name"], [class*="info-public"]')
    const bossName = bossEl?.querySelector('[class*="name"]')?.textContent?.trim() || ''
    const bossTitle = bossEl?.querySelector('[class*="title"]')?.textContent?.trim() || ''

    // Extract company logo
    const logoEl = html.querySelector('img[src*="logo"], img[class*="avatar"]')
    const companyLogo = logoEl ? (logoEl as HTMLImageElement).src : ''

    // Extract job description preview (search cards rarely show the JD; the
    // full JD is read from the detail view during apply). Avoid the broad
    // `[class*="job-detail"]` selector which matched unrelated containers.
    const descEl = html.querySelector('.job-desc, [class*="job-desc"], .info-desc, [class*="info-desc"], .job-description, .job-sec-text')
    const jobDescPreview = (descEl?.textContent || '').replace(/\s+/g, ' ').trim()

    // Extract online status
    const onlineEl = html.querySelector('[class*="online"], [class*="active-now"], .online-tag')
    const bossOnline = !!onlineEl

    // Add the card as long as we have a title. A missing company name must
    // NOT drop the whole card (otherwise scanning shows nothing). We keep
    // best-effort company name and capture the card HTML for debugging.
    if (title) {
      if (!companyName && !debugLogged) {
        debugLogged = true
        // eslint-disable-next-line no-console
        console.error(
          '[BOSS-DEBUG] companyName empty for a card. Card HTML:\n',
          html.outerHTML.slice(0, 2000),
        )
      }
      if (!companyName && !debugDownloaded) {
        downloadCardDebug(html.outerHTML)
      }
      cards.push({
        id: generateJobId(url),
        title,
        companyName,
        companyLogo,
        salary,
        location,
        experience,
        education,
        tags,
        jobDescription: jobDescPreview,
        bossName,
        bossTitle,
        bossOnline,
        publishedAt: '',
        url: url || window.location.href,
      })
    }
  })

  return cards
}

export function parseJobDetailFromPage(): JobCard | null {
  // --- Title: strip any salary span from the matched node first, so the
  // salary never gets merged into the job title. ---
  const titleEl = document.querySelector('[class*="job-name"], [class*="name"], h1')
  let rawTitle = ''
  if (titleEl) {
    const clone = titleEl.cloneNode(true) as Element
    clone
      .querySelectorAll('.job-salary, [class*="salary"], [class*="red"]')
      .forEach((s) => s.remove())
    rawTitle = (clone.querySelector('a')?.textContent || getDirectText(clone) || clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  const title = rawTitle
  const companyName = extractCompanyName(document)
  const salaryEl = document.querySelector('[class*="salary"], .salary-text, [class*="price"]')
  const salary = decodeBossFontText(salaryEl?.textContent?.trim() || '', salaryEl ? fontFamilyOf(salaryEl) : 'sans-serif')
  const location = document.querySelector('[class*="area"], [class*="location"]')?.textContent?.trim() || ''
  const desc = extractJobDescriptionFromDetail(document)

  if (!title || !companyName) return null

  return {
    id: generateJobId(window.location.href),
    title,
    companyName,
    companyLogo: '',
    salary,
    location,
    experience: '',
    education: '',
    tags: [],
    jobDescription: desc,
    bossName: '',
    bossTitle: '',
    bossOnline: false,
    publishedAt: '',
    url: window.location.href,
  }
}

// Parse the current page type
export function detectPageType(): 'search' | 'detail' | 'chat' | 'recommend' | 'other' {
  const url = window.location.href

  if (url.includes('/job_detail/')) return 'detail'
  if (url.includes('/web/geek/job') || url.includes('/web/geek/search')) return 'search'
  if (url.includes('/web/geek/job-recommend')) return 'recommend'
  if (url.includes('/web/geek/chat')) return 'chat'

  // Try DOM detection
  if (document.querySelector('[class*="job-card"], .job-list-box, [class*="recommend-job-card"]')) return 'search'
  if (document.querySelector('.job-detail-content, [class*="job-sec"]')) return 'detail'

  return 'other'
}
