// H1 · 数据加密与脱敏
import { describe, expect, it, beforeEach } from 'vitest'
import { encryptText, decryptText, isEncrypted, setVaultKeyStore } from '../src/shared/security/vault'
import { maskPhone, maskEmail, maskIdCard, maskDeep } from '../src/shared/security/mask'

/** 内存密钥存储（测试注入） */
function memKeyStore() {
  let value: string | undefined
  return {
    get: async () => value,
    set: async (v: string) => { value = v },
  }
}

describe('vault 加密', () => {
  beforeEach(() => {
    setVaultKeyStore(memKeyStore())
  })

  it('加密后可解密还原', async () => {
    const plain = '我是简历全文：张三，13800138000，前端工程师'
    const enc = await encryptText(plain)
    expect(isEncrypted(enc)).toBe(true)
    expect(enc).not.toContain('张三')
    expect(await decryptText(enc)).toBe(plain)
  })

  it('同一密钥可跨调用解密（密钥持久化在 store）', async () => {
    const store = memKeyStore()
    setVaultKeyStore(store)
    const enc = await encryptText('跨调用测试')
    // 模拟重启：重置缓存后仍可解密
    setVaultKeyStore(store)
    expect(await decryptText(enc)).toBe('跨调用测试')
  })

  it('每次加密 IV 随机，同明文产生不同密文', async () => {
    const a = await encryptText('相同明文')
    const b = await encryptText('相同明文')
    expect(a).not.toBe(b)
  })

  it('旧数据（无 enc:v1: 前缀）透传不报错', async () => {
    expect(await decryptText('纯文本旧数据')).toBe('纯文本旧数据')
    expect(isEncrypted('纯文本')).toBe(false)
  })
})

describe('导出脱敏', () => {
  it('手机号掩码', () => {
    expect(maskPhone('13800138000')).toBe('138****8000')
  })

  it('邮箱掩码', () => {
    expect(maskEmail('zhangsan@example.com')).toBe('z***n@example.com')
  })

  it('身份证掩码', () => {
    expect(maskIdCard('110101199001011234')).toBe('1101**********1234')
  })

  it('深度脱敏嵌套对象', () => {
    const data = {
      applicant: { name: '张三', phone: '13800138000', email: 'zhangsan@example.com' },
      notes: '沟通顺利，电话 13900139000',
      score: 85,
      tags: ['前端', '13911112222'],
    }
    const masked = maskDeep(data)
    expect(masked.applicant.phone).toBe('138****8000')
    expect(masked.applicant.email).toBe('z***n@example.com')
    expect(masked.notes).toContain('139****9000')
    expect(masked.tags[1]).toBe('139****2222')
    expect(masked.score).toBe(85)
  })
})
