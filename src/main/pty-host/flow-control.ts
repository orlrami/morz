/*
 * Two-layer flow control (0.0.1 Slice 1), VS Code's watermarks.
 * Layer 1: node-pty `handleFlowControl:true` — writing XOFF/XON to the pty
 *          pauses/resumes ConPTY reads (never reaches the shell).
 * Layer 2: renderer ack/watermark — the host counts bytes sent to the renderer;
 *          the renderer acks as xterm consumes them. Too many unacked bytes
 *          (slow renderer, flood like `type big.log`) → pause the PTY.
 */

export const FLOW = {
  HIGH_WATERMARK: 100_000, // unacked chars → pause
  LOW_WATERMARK: 5_000, // unacked chars → resume
  ACK_EVERY: 5_000 // renderer acks in chunks of this many chars
} as const

const XOFF = '\x13'
const XON = '\x11'

interface FlowTarget {
  /** raw write into the pty (intercepted by handleFlowControl, not sent to the shell) */
  write(data: string): void
}

export class FlowController {
  private unacked = 0
  private paused = false

  constructor(private readonly pty: FlowTarget) {}

  /** Call with every chunk length sent renderer-ward. */
  sent(chars: number): void {
    this.unacked += chars
    if (!this.paused && this.unacked > FLOW.HIGH_WATERMARK) {
      this.paused = true
      this.pty.write(XOFF)
    }
  }

  /** Renderer consumed `chars`. */
  ack(chars: number): void {
    this.unacked = Math.max(0, this.unacked - chars)
    if (this.paused && this.unacked < FLOW.LOW_WATERMARK) {
      this.paused = false
      this.pty.write(XON)
    }
  }

  /** Renderer went away (window closed). Drop the ledger so a reattach doesn't start paused. */
  reset(): void {
    this.unacked = 0
    if (this.paused) {
      this.paused = false
      this.pty.write(XON)
    }
  }
}
