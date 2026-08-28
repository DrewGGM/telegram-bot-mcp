/**
 * Sliding-window rate limiter (§4.1.7). Caps how many updates the daemon
 * processes per minute — a cheap guard against a runaway loop or an update
 * flood. Single-user, so one shared window is enough.
 */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
  ) {}

  /** Record an attempt; return true if it is within the limit. */
  allow(now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}
