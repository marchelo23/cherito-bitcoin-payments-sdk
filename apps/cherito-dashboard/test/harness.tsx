import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

export interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export const fetchCalls: FetchCall[] = []

let browser: Window | undefined

export function installDom(): void {
  browser = new Window({ url: 'http://localhost:5173/' })
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLFormElement: browser.HTMLFormElement,
    FormData: browser.FormData,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    location: browser.location,
    history: browser.history,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
}

export function resetStorage(): void {
  browser?.localStorage.clear()
  browser?.sessionStorage.clear()
  if (browser) browser.document.body.innerHTML = ''
}

export function localStorageEntries(): Array<[string, string]> {
  const store = browser!.localStorage
  const entries: Array<[string, string]> = []
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index)!
    entries.push([key, store.getItem(key)!])
  }
  return entries
}

export function mockFetch(handler: (call: FetchCall) => { status?: number; body?: unknown } | Error): void {
  fetchCalls.length = 0
  globalThis.fetch = (async (input: unknown, init: Record<string, unknown> = {}) => {
    const call: FetchCall = {
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    fetchCalls.push(call)
    const result = handler(call)
    if (result instanceof Error) throw result
    const status = result.status ?? 200
    const text = JSON.stringify(result.body ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    }
  }) as unknown as typeof globalThis.fetch
}

export interface Mounted {
  container: HTMLElement
  unmount: () => Promise<void>
  text: () => string
  find: (selector: string) => Element | null
  findAll: (selector: string) => Element[]
  findByText: (needle: string) => Element | undefined
  click: (element: Element | null) => Promise<void>
  setValue: (element: Element | null, value: string) => Promise<void>
  submit: (element: Element | null) => Promise<void>
  flush: () => Promise<void>
}

export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(node)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const flush = async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  return {
    container,
    text: () => container.textContent ?? '',
    find: (selector) => container.querySelector(selector),
    findAll: (selector) => [...container.querySelectorAll(selector)],
    findByText: (needle) =>
      [...container.querySelectorAll('*')].find((element) => element.textContent?.trim() === needle),
    click: async (element) => {
      ;(element as unknown as { click: () => void })?.click()
      await flush()
    },
    setValue: async (element, value) => {
      const input = element as unknown as HTMLInputElement
      input.value = value
      input.dispatchEvent(new browser!.Event('input', { bubbles: true }) as unknown as Event)
      await flush()
    },
    submit: async (element) => {
      element?.dispatchEvent(new browser!.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
      await flush()
    },
    flush,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}
