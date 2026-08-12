import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/errors'

export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: string | undefined
  reload: () => void
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    loader()
      .then((value) => {
        if (!active) return
        setData(value)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (!active) return
        setError(describeError(cause))
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [...deps, nonce])

  return { data, loading, error, reload }
}
