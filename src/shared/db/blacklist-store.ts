import { db, type BlacklistItem } from './index'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

export async function getBlacklist(): Promise<BlacklistItem[]> {
  return db.blacklist.orderBy('addedAt').reverse().toArray()
}

export async function addToBlacklist(companyName: string, reason: string): Promise<BlacklistItem> {
  // Check if already exists
  const existing = await db.blacklist.where('companyName').equals(companyName).first()
  if (existing) return existing

  const item: BlacklistItem = {
    id: generateId(),
    companyName,
    reason,
    addedAt: new Date().toISOString(),
  }
  await db.blacklist.add(item)
  return item
}

export async function removeFromBlacklist(id: string): Promise<void> {
  await db.blacklist.delete(id)
}

export async function isBlacklisted(companyName: string): Promise<boolean> {
  const count = await db.blacklist.where('companyName').equals(companyName).count()
  return count > 0
}

export async function importBlacklist(items: Array<{ companyName: string; reason: string }>): Promise<number> {
  let count = 0
  for (const item of items) {
    const existing = await db.blacklist.where('companyName').equals(item.companyName).first()
    if (!existing) {
      const newItem: BlacklistItem = {
        id: generateId(),
        companyName: item.companyName,
        reason: item.reason,
        addedAt: new Date().toISOString(),
      }
      await db.blacklist.add(newItem)
      count++
    }
  }
  return count
}
