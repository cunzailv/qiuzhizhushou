// H1 · 导出脱敏：对手机/邮箱/身份证等敏感信息做掩码

export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return email
  const [name, domain] = email.split('@')
  if (name.length <= 1) return `${name}***@${domain}`
  return `${name.slice(0, 1)}***${name.slice(-1)}@${domain}`
}

export function maskIdCard(id: string): string {
  if (!id || id.length < 8) return id
  return id.slice(0, 4) + '**********' + id.slice(-4)
}

/** 对任意字符串值做通用脱敏（正则替换手机/邮箱/身份证形态） */
export function maskSensitive(value: string): string {
  let out = value
  // 手机号：3+4+4
  out = out.replace(/(\d{3})\d{4}(\d{4})/g, '$1****$2')
  // 邮箱：保留首尾字符
  out = out.replace(/([\w.+-])[\w.+-]+([\w.+-])@([\w.-]+\.[\w.]+)/g, '$1***$2@$3')
  // 身份证：4+10+4
  out = out.replace(/(\d{4})\d{10}[\dXx](\d{4})/g, '$1**********$2')
  return out
}

/** 深度遍历对象/数组，对键名含 phone/email/id 的字符串字段脱敏 */
export function maskDeep<T>(obj: T): T {
  if (obj == null) return obj
  if (typeof obj === 'string') return maskSensitive(obj) as unknown as T
  if (Array.isArray(obj)) return obj.map(maskDeep) as unknown as T
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const sensitive = /phone|mobile|email|idcard|idCard|id_card/i.test(k)
      out[k] = sensitive && typeof v === 'string' ? maskSensitive(v) : maskDeep(v)
    }
    return out as unknown as T
  }
  return obj
}
