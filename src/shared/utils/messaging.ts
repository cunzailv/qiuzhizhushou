import type { ChromeMessage } from '../types/message'

export async function sendMessage<T = unknown>(
  type: ChromeMessage['type'],
  payload?: unknown
): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload }) as Promise<T>
}

export function addMessageListener(
  handler: (message: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => void
): () => void {
  chrome.runtime.onMessage.addListener(handler)
  return () => {
    chrome.runtime.onMessage.removeListener(handler)
  }
}

export function sendToTab<T = unknown>(tabId: number, type: ChromeMessage['type'], payload?: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, { type, payload }) as Promise<T>
}
