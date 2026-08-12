export type ApiErrorKind =
  | 'network'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'invalid_request'
  | 'provider_unavailable'
  | 'server_error'
  | 'unknown'

const MESSAGES: Record<ApiErrorKind, string> = {
  network: 'Could not reach the gateway. Check the URL and that the gateway is running.',
  unauthorized: 'The merchant API key was rejected.',
  forbidden: 'This merchant key is not allowed to perform that action.',
  not_found: 'That resource does not exist.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  invalid_request: 'The gateway rejected the request as invalid.',
  provider_unavailable: 'The Lightning provider is unavailable.',
  server_error: 'The gateway reported an internal error.',
  unknown: 'Something went wrong talking to the gateway.',
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number

  constructor(kind: ApiErrorKind, status?: number) {
    super(MESSAGES[kind])
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

export function kindForStatus(status: number, code?: string): ApiErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 409 || status === 410 || status === 422) return 'invalid_request'
  if (code === 'PROVIDER_UNAVAILABLE' || status === 502 || status === 503) return 'provider_unavailable'
  if (status >= 500) return 'server_error'
  return 'unknown'
}

export function describeError(error: unknown): string {
  return error instanceof ApiError ? error.message : MESSAGES.unknown
}
