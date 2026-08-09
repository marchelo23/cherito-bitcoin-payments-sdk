export interface RateLimitPolicy {
  readonly name: string
  readonly limit: number
  readonly windowMs: number
}

export interface RateLimiter {
  consume(policy: RateLimitPolicy, identity: string): boolean
}

interface Bucket {
  count: number
  resetAt: number
}

/**
 * Deliberately small single-process implementation behind a replaceable
 * interface. Deployments with multiple gateway replicas must provide a shared
 * limiter with the same semantics.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private operations = 0

  constructor(private readonly now: () => number = Date.now) {}

  consume(policy: RateLimitPolicy, identity: string): boolean {
    const now = this.now()
    const key = `${policy.name}\0${identity}`
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + policy.windowMs })
      this.cleanup(now)
      return true
    }
    bucket.count += 1
    this.cleanup(now)
    return bucket.count <= policy.limit
  }

  private cleanup(now: number): void {
    this.operations += 1
    if (this.operations % 256 !== 0) return
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}

export class SseConnectionLimiter {
  private global = 0
  private readonly tenants = new Map<string, number>()

  constructor(
    private readonly globalLimit: number,
    private readonly tenantLimit: number,
  ) {}

  acquire(tenantId: string): (() => void) | undefined {
    const tenantCount = this.tenants.get(tenantId) ?? 0
    if (this.global >= this.globalLimit || tenantCount >= this.tenantLimit) return undefined
    this.global += 1
    this.tenants.set(tenantId, tenantCount + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.global -= 1
      const remaining = (this.tenants.get(tenantId) ?? 1) - 1
      if (remaining === 0) this.tenants.delete(tenantId)
      else this.tenants.set(tenantId, remaining)
    }
  }
}
