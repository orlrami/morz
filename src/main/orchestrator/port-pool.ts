/*
 * $PORT pool for dispatched agents (w5/dispatch). Each agent pane gets one
 * port from a fixed range via env so parallel dev servers never collide.
 * Lowest-free allocation: released ports are reused first, which also gives
 * the e2e suite a cheap "ports released" probe.
 */

export const PORT_POOL_FIRST = 43600
export const PORT_POOL_SIZE = 200

export class PortPool {
  private readonly used = new Set<number>()

  constructor(
    private readonly first = PORT_POOL_FIRST,
    private readonly size = PORT_POOL_SIZE
  ) {}

  alloc(): number {
    for (let port = this.first; port < this.first + this.size; port++) {
      if (!this.used.has(port)) {
        this.used.add(port)
        return port
      }
    }
    throw new Error(`[dispatch] port pool exhausted (${this.size} ports from ${this.first})`)
  }

  release(port: number): void {
    this.used.delete(port)
  }

  inUse(): number[] {
    return [...this.used].sort((a, b) => a - b)
  }
}
