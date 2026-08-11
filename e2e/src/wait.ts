export interface WaitOptions {
  description: string | (() => string)
  timeoutMs?: number
  intervalMs?: number
}

export function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  options: WaitOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 500
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let lastFailure = ''

  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined && value !== false) return value as T
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }

    if (Date.now() >= deadline) {
      const elapsed = Date.now() - startedAt
      const detail = lastFailure ? ` last failure: ${lastFailure}` : ''
      const label = typeof options.description === 'function'
        ? options.description()
        : options.description
      throw new Error(`Timed out waiting for ${label} after ${elapsed}ms.${detail}`)
    }

    await delay(intervalMs)
  }
}

export async function expectStaysFalse(
  probe: () => Promise<boolean> | boolean,
  options: { description: string; durationMs: number; intervalMs?: number },
): Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000
  const deadline = Date.now() + options.durationMs
  while (Date.now() < deadline) {
    if (await probe()) {
      throw new Error(`Expected ${options.description} to stay false, but it became true`)
    }
    await delay(intervalMs)
  }
}
