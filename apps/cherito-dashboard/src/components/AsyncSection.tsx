import type { ReactNode } from 'react'

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      {hint ? <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)' }}>{hint}</p> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty-state" role="alert">
      <p style={{ margin: 0, color: 'var(--error)', fontWeight: 600 }}>{message}</p>
      {onRetry ? (
        <button type="button" className="btn-primary" style={{ marginTop: '0.75rem' }} onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  )
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty-state" aria-busy="true">
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{label}</p>
    </div>
  )
}

interface AsyncSectionProps<T> {
  loading: boolean
  error: string | undefined
  data: T | undefined
  onRetry?: () => void
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  children: (data: T) => ReactNode
}

export function AsyncSection<T>(props: AsyncSectionProps<T>) {
  if (props.loading) return <LoadingState />
  if (props.error) return <ErrorState message={props.error} onRetry={props.onRetry} />
  if (props.data === undefined) return <EmptyState title="No data available" />
  if (props.isEmpty?.(props.data)) return <>{props.empty ?? <EmptyState title="Nothing here yet" />}</>
  return <>{props.children(props.data)}</>
}
