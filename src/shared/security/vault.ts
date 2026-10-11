// H1 · 敏感数据加密（WebCrypto AES-GCM）
// 密钥首次生成后存 chrome.storage.local（扩展域私有），格式：enc:v1:<iv>:<cipher>（base64）。
// 旧数据无 enc:v1: 前缀时透传（平滑迁移）；单测可用 setVaultKeyStore 注入内存存储。

const KEY_STORAGE = 'vault_key_v1'
const memoryFallback = new Map<string, string>()

export interface KeyStore {
  get(): Promise<string | undefined>
  set(value: string): Promise<void>
}

const chromeKeyStore: KeyStore = {
  async get() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const r = await chrome.storage.local.get(KEY_STORAGE)
        return r[KEY_STORAGE] as string | undefined
      }
    } catch {
      /* 降级到内存 */
    }
    return memoryFallback.get(KEY_STORAGE)
  },
  async set(value) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ [KEY_STORAGE]: value })
        return
      }
    } catch {
      /* 降级到内存 */
    }
    memoryFallback.set(KEY_STORAGE, value)
  },
}

let keyStore: KeyStore = chromeKeyStore
let cachedKey: CryptoKey | undefined

export function setVaultKeyStore(store: KeyStore): void {
  keyStore = store
  cachedKey = undefined
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  const stored = await keyStore.get()
  if (stored) {
    cachedKey = await crypto.subtle.importKey(
      'raw', base64ToBytes(stored), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    )
    return cachedKey
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  await keyStore.set(bytesToBase64(raw))
  cachedKey = key
  return key
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith('enc:v1:')
}

/** 加密明文；WebCrypto 不可用（极旧环境）时原样返回 */
export async function encryptText(plain: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return plain
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
  return `enc:v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipher))}`
}

/** 解密；旧数据透传，密钥/格式异常时原样返回（不中断链路） */
export async function decryptText(payload: string): Promise<string> {
  if (!isEncrypted(payload)) return payload
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return payload
    const [prefix, , ivB64, cipherB64] = payload.split(':')
    if (prefix !== 'enc' || !ivB64 || !cipherB64) return payload
    const key = await getKey()
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(ivB64) }, key, base64ToBytes(cipherB64))
    return new TextDecoder().decode(plain)
  } catch {
    return payload
  }
}
