import { db } from './index'

export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  const result = await db.settings.get(key)
  if (result) return result.value as T
  return defaultValue
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value })
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const all = await db.settings.toArray()
  const result: Record<string, unknown> = {}
  for (const item of all) {
    result[item.key] = item.value
  }
  return result
}
