/*
 * OSC-133 command blocks (0.0.1 Slice 1) — marker-anchored decorations over
 * ONE continuous buffer. Never splits output into multiple terminals.
 *
 * The PTY-host injects a consent-gated prompt hook that emits FinalTerm-style
 * marks, each carrying the per-session anti-spoof nonce Morz passes at spawn
 * via env MORZ_BLOCK_NONCE:
 *   OSC 133 ; A ; nonce=<n> ST        prompt start
 *   OSC 133 ; B ; nonce=<n> ST        command input start
 *   OSC 133 ; C ; nonce=<n> ST        command executed (output starts)
 *   OSC 133 ; D ; <exit> ; nonce=<n>  command finished
 * Marks with a missing/wrong nonce are ignored — an agent echoing OSC 133
 * cannot forge block boundaries.
 */
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm'
import { colors } from './tokens'

export interface CommandBlock {
  /** Row of the prompt (block visually starts here). */
  promptMarker: IMarker
  /** Row where output started (C mark), if the command ran. */
  outputMarker?: IMarker
  exitCode?: number
  done: boolean
}

interface Live {
  block: CommandBlock
  decorations: IDecoration[]
  rowHighlight?: HTMLElement
  hovered: boolean
}

export function attachCommandBlocks(
  term: Terminal,
  nonce: string,
  onBlockDone?: (b: CommandBlock) => void
): IDisposable {
  const live: Live[] = []
  let current: Live | null = null

  const nonceOk = (parts: string[]): boolean => parts.includes(`nonce=${nonce}`)

  const decorate = (l: Live): void => {
    const { block } = l
    if (block.promptMarker.isDisposed) return
    const failed = block.exitCode !== undefined && block.exitCode !== 0
    const accent = failed ? colors.error : colors.done

    // One bottom-layer decoration spans the completed block. The gutter owns
    // hover input, so terminal selection and links remain unobstructed.
    const active = term.buffer.active
    const currentLine = active.baseY + active.cursorY
    const height = Math.max(1, currentLine - block.promptMarker.line + 1)
    const rows = term.registerDecoration({
      marker: block.promptMarker,
      x: 0,
      width: term.cols,
      height,
      layer: 'bottom'
    })
    if (rows) {
      rows.onRender((el) => {
        l.rowHighlight = el
        el.dataset.morzBlockRows = 'true'
        el.style.background = l.hovered ? `${colors.quartz}09` : 'transparent'
        el.style.pointerEvents = 'none'
      })
      l.decorations.push(rows)
    }

    // Left accent strip on the prompt row — the block's visual anchor.
    const strip = term.registerDecoration({
      marker: block.promptMarker,
      x: 0,
      width: 1
    })
    if (strip) {
      strip.onRender((el) => {
        el.dataset.morzBlockGutter = 'true'
        el.dataset.morzBlockState = failed ? 'error' : 'done'
        if (block.exitCode !== undefined) el.dataset.morzExitCode = String(block.exitCode)
        el.style.background = 'transparent'
        el.style.borderLeft = `2px solid ${accent}`
        el.style.marginLeft = '-6px'
        el.style.borderRadius = '2px'
        el.style.pointerEvents = 'auto'
        el.style.cursor = 'default'
        if (!el.dataset.morzHoverBound) {
          el.dataset.morzHoverBound = 'true'
          el.addEventListener('mouseenter', () => {
            l.hovered = true
            if (l.rowHighlight) l.rowHighlight.style.background = `${colors.quartz}09`
          })
          el.addEventListener('mouseleave', () => {
            l.hovered = false
            if (l.rowHighlight) l.rowHighlight.style.background = 'transparent'
          })
        }
      })
      l.decorations.push(strip)
    }

    // Exit badge, right-aligned on the prompt row, only for failures.
    if (failed) {
      const badge = term.registerDecoration({
        marker: block.promptMarker,
        anchor: 'right',
        x: 0,
        width: 6
      })
      if (badge) {
        badge.onRender((el) => {
          el.textContent = `✗ ${block.exitCode}`
          el.style.color = colors.error
          el.style.background = `${colors.error}1F`
          el.style.borderRadius = '6px'
          el.style.fontSize = '9px'
          el.style.lineHeight = 'inherit'
          el.style.textAlign = 'center'
          el.style.pointerEvents = 'none'
        })
        l.decorations.push(badge)
      }
    }

    // OSC marks can arrive inside one batched write. Guarantee a viewport pass
    // after registration so xterm materializes decoration DOM without waiting
    // for unrelated output or a resize.
    term.refresh(0, term.rows - 1)
  }

  const closeCurrent = (exitCode?: number): void => {
    if (!current) return
    current.block.exitCode = exitCode
    current.block.done = true
    decorate(current)
    onBlockDone?.(current.block)
    current = null
  }

  const oscDisposable = term.parser.registerOscHandler(133, (data): boolean => {
    const parts = data.split(';')
    const kind = parts[0]
    if (!nonceOk(parts)) return true // consume, but never trust unsigned marks

    switch (kind) {
      case 'A': {
        // New prompt. An unfinished block (e.g. Ctrl-C'd command) closes here.
        closeCurrent(undefined)
        const promptMarker = term.registerMarker(0)
        if (promptMarker) {
          current = { block: { promptMarker, done: false }, decorations: [], hovered: false }
          live.push(current)
        }
        break
      }
      case 'B':
        break // command input start — row already anchored by A
      case 'C': {
        if (current) current.block.outputMarker = term.registerMarker(0) ?? undefined
        break
      }
      case 'D': {
        // negative codes happen on Windows (NTSTATUS crashes, e.g. -1073741510)
        const exit = parts[1] !== undefined && /^-?\d+$/.test(parts[1]) ? Number(parts[1]) : undefined
        closeCurrent(exit)
        break
      }
    }
    return true
  })

  return {
    dispose(): void {
      oscDisposable.dispose()
      for (const l of live) {
        for (const d of l.decorations) d.dispose()
        l.block.promptMarker.dispose()
        l.block.outputMarker?.dispose()
      }
      live.length = 0
      current = null
    }
  }
}
