import type { Credentials } from './api/cherito-client'

const STORAGE_KEY = 'cherito.dashboard.session'

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

export function loadSession(): Credentials | undefined {
  const store = storage()
  if (!store) return undefined
  const raw = store.getItem(STORAGE_KEY)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>
    if (typeof parsed.gatewayUrl === 'string' && typeof parsed.apiKey === 'string') {
      return { gatewayUrl: parsed.gatewayUrl, apiKey: parsed.apiKey }
    }
  } catch {
    store.removeItem(STORAGE_KEY)
  }
  return undefined
}

export function saveSession(credentials: Credentials): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(credentials))
}

export function clearSession(): void {
  storage()?.removeItem(STORAGE_KEY)
}
