import type { MemoryEntry, MemoryInjection, MemoryProposal } from '../../shared/memory'

export interface MemoryPort extends MemoryInjection {
  propose(proposal: MemoryProposal): Promise<MemoryProposal>
}

export interface InMemoryMemoryPort extends MemoryPort {
  readonly renderCalls: Array<Parameters<MemoryInjection['render']>[0]>
  listProposals(): MemoryProposal[]
  resolveProposal(id: string, approved: boolean): Promise<MemoryProposal>
}

function cloneProposal(proposal: MemoryProposal): MemoryProposal {
  return {
    ...proposal,
    entry: { ...proposal.entry },
    evidence: [...proposal.evidence]
  }
}

function inScope(entry: MemoryEntry, opts: Parameters<MemoryInjection['render']>[0]): boolean {
  switch (entry.scope) {
    case 'global':
      return true
    case 'project':
      return entry.scopeRef === opts.projectRoot
    case 'space':
      return entry.scopeRef === opts.spaceId
    case 'agent':
      return entry.scopeRef === opts.agentId
  }
}

export function createInMemoryMemoryPort(): InMemoryMemoryPort {
  const proposals = new Map<string, MemoryProposal>()
  const entries = new Map<string, MemoryEntry>()
  const renderCalls: Array<Parameters<MemoryInjection['render']>[0]> = []

  return {
    renderCalls,
    async propose(proposal) {
      const stored = cloneProposal(proposal)
      proposals.set(stored.id, stored)
      return cloneProposal(stored)
    },
    render(opts) {
      renderCalls.push({ ...opts })
      // E2E-only seam: fixed content prevents environment-controlled prompt injection.
      if (process.env.MORZ_MEMORY_STUB === '1') {
        return '## How the user works\n\n- **Use pnpm instead of npm**'
      }
      const enabled = [...entries.values()].filter((entry) => entry.enabled && inScope(entry, opts))
      if (enabled.length === 0) return ''
      const rules = enabled.map((entry) => {
        const body = entry.body.replace(/\s+/g, ' ').trim()
        return `- **${entry.title}**${body ? ` — ${body}` : ''}`
      })
      return [
        '## How the user works',
        '',
        'These are user-approved durable instructions. Apply them to this work:',
        ...rules
      ].join('\n')
    },
    listProposals() {
      return [...proposals.values()].map(cloneProposal)
    },
    async resolveProposal(id, approved) {
      const current = proposals.get(id)
      if (!current) throw new Error(`Unknown memory proposal: ${id}`)
      const resolved: MemoryProposal = {
        ...cloneProposal(current),
        state: approved ? 'approved' : 'rejected'
      }
      proposals.set(id, resolved)
      if (approved) {
        const timestamp = new Date().toISOString()
        entries.set(resolved.entry.id, {
          ...resolved.entry,
          createdAt: timestamp,
          updatedAt: timestamp
        })
      }
      return cloneProposal(resolved)
    }
  }
}

/*
 * INTEGRATED (wave-8 merge): the live port is backed by the REAL store
 * (w8/memory-core) — markdown files + FTS index + approval-gated proposals.
 * The in-memory port above remains for tests. MORZ_MEMORY_STUB=1 keeps the
 * fixed e2e render (prevents environment-controlled prompt injection).
 */
import {
  listMemoryProposals,
  proposeMemoryReconciled,
  resolveMemoryProposal as storeResolveProposal
} from './index'
import { MemoryInjection as storeInjection } from './store'

export const memoryPort: MemoryPort = {
  async propose(proposal) {
    // w15/memory-opset — candidate writes reconcile against same-scope facts
    // (ADD/UPDATE/DELETE/NOOP). NOOP comes back state 'rejected' with no card.
    return proposeMemoryReconciled(proposal)
  },
  render(opts) {
    if (process.env.MORZ_MEMORY_STUB === '1') {
      return '## How the user works\n\n- **Use pnpm instead of npm**'
    }
    return storeInjection.render(opts)
  }
}

/** Resolve against the real store (approve materializes the entry on disk). */
export function resolveMemoryProposal(id: string, approved: boolean): Promise<MemoryProposal> {
  return Promise.resolve(storeResolveProposal(id, approved))
}

export { listMemoryProposals }

function joinPreamble(preamble: string, prompt: string): string {
  const block = preamble.trim()
  return block ? `${block}\n\n${prompt}` : prompt
}

/**
 * Join an ALREADY rendered preamble onto a prompt. The dispatcher renders the
 * whole team's memory up front — one instant of the store for every agent — so
 * it needs the join without a second render (see renderTeamMemory).
 */
export function joinRenderedMemory(preamble: string, prompt: string): string {
  return joinPreamble(preamble, prompt)
}

/** Render at lane start and consume the result on the first prompt only. */
export function createMemorySessionPreamble(
  port: MemoryPort,
  opts: Parameters<MemoryInjection['render']>[0],
  alreadyInitialized = false
): (prompt: string) => string {
  if (alreadyInitialized) return (prompt) => prompt
  const preamble = port.render(opts)
  let pending = true
  return (prompt) => {
    if (!pending) return prompt
    pending = false
    return joinPreamble(preamble, prompt)
  }
}

/** Render once for a newly dispatched agent's prompt seed. */
export function prependRenderedMemory(
  port: MemoryPort,
  opts: Parameters<MemoryInjection['render']>[0],
  prompt: string
): string {
  return joinPreamble(port.render(opts), prompt)
}
