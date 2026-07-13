import type {
  ConfigWriterApiShape,
  ConfigWriterApplyResult,
  ConfigWriterInstallSpec,
  ConfigWriterProposal,
  ConfigWriterTarget
} from '@shared/ipc'

function api(): ConfigWriterApiShape {
  const configWriter = window.morz?.configWriter
  if (!configWriter) throw new Error('Config writer is unavailable')
  return configWriter
}

export function proposeConfigInstall(
  spec: ConfigWriterInstallSpec,
  targets: ConfigWriterTarget[]
): Promise<ConfigWriterProposal[]> {
  return api().propose(spec, targets)
}

export async function applyConfigProposals(
  proposals: ConfigWriterProposal[]
): Promise<ConfigWriterApplyResult[]> {
  const configWriter = api()
  const results: ConfigWriterApplyResult[] = []
  // Keep application ordered so a partial failure has an exact, reportable boundary.
  for (const proposal of proposals) results.push(await configWriter.apply(proposal.proposalId))
  return results
}
