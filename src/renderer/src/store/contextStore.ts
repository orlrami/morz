import { create } from 'zustand'
import type {
  ContextApplyResult,
  ContextHubBridge,
  ContextMatrix,
  ContextMemoryBlockInput,
  ContextProposal,
  ContextSharedBlockInput,
  ContextSpaceInput,
  ContextStatusBlockInput,
  ContextTemplateInput
} from '@shared/context-hub'

interface ContextState {
  matrix: ContextMatrix | null
  loading: boolean
  error: string | null
  scan(spaces: ContextSpaceInput[]): Promise<ContextMatrix>
  proposeTemplate(input: ContextTemplateInput): Promise<ContextProposal>
  proposeSharedBlock(input: ContextSharedBlockInput): Promise<ContextProposal[]>
  proposeMemoryBlock(input: ContextMemoryBlockInput): Promise<ContextProposal[]>
  proposeStatusBlock(input: ContextStatusBlockInput): Promise<ContextProposal[]>
  applyOne(proposal: ContextProposal): Promise<ContextApplyResult>
}

function contextHub(): ContextHubBridge {
  const bridge = window.morz?.contextHub
  if (!bridge) throw new Error('Context Hub is unavailable')
  return bridge
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'Context Hub could not complete the request.'
}

export const useContextStore = create<ContextState>((set) => ({
  matrix: null,
  loading: false,
  error: null,

  scan: async (spaces) => {
    set({ loading: true, error: null })
    try {
      const matrix = await contextHub().scan(spaces)
      set({ matrix, loading: false })
      return matrix
    } catch (error) {
      set({ loading: false, error: detail(error) })
      throw error
    }
  },

  proposeTemplate: async (input) => {
    set({ error: null })
    try {
      return await contextHub().proposeTemplate(input)
    } catch (error) {
      set({ error: detail(error) })
      throw error
    }
  },

  proposeSharedBlock: async (input) => {
    set({ error: null })
    try {
      return await contextHub().proposeSharedBlock(input)
    } catch (error) {
      set({ error: detail(error) })
      throw error
    }
  },

  proposeMemoryBlock: async (input) => {
    set({ error: null })
    try {
      return await contextHub().proposeMemoryBlock(input)
    } catch (error) {
      set({ error: detail(error) })
      throw error
    }
  },

  proposeStatusBlock: async (input) => {
    set({ error: null })
    try {
      return await contextHub().proposeStatusBlock(input)
    } catch (error) {
      set({ error: detail(error) })
      throw error
    }
  },

  applyOne: async (proposal) => {
    set({ error: null })
    try {
      return await contextHub().applyProposal(proposal.proposalId)
    } catch (error) {
      set({ error: detail(error) })
      throw error
    }
  }
}))
