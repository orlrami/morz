import type { ReviewAuthor } from '../../shared/ipc'

const FINDING_SHAPE =
  '[{"severity":"critical|high|medium|low|info","file":"repo/relative/path","line":1,"title":"short title","evidence":"specific evidence from the diff","suggestedFix":"optional concrete fix"}]'

export function reviewPrompt(input: {
  diff: string
  author: ReviewAuthor
  reviewer: ReviewAuthor
}): string {
  return `You are the non-author quality gate for a ${input.author}-authored git diff. Refute the change before accepting it.

Review only the supplied diff. Do not use tools, inspect the repository, or comment on style. Find concrete correctness, security, data-loss, concurrency, compatibility, or regression bugs introduced by the change. A finding must cite changed code and explain a reproducible failure. If there are no real bugs, return [].

Return ONLY a strict JSON array matching this shape:
${FINDING_SHAPE}

Rules:
- file must be a repository-relative path present in the diff.
- line must be a positive line number on the new side of the diff.
- evidence must identify the failing condition and impact.
- omit suggestedFix when no precise fix is justified.
- no markdown fences, prose, or extra object keys.

Author model: ${input.author}
Reviewer model: ${input.reviewer}

<diff>
${input.diff}
</diff>`
}

export function repairPrompt(malformed: string): string {
  return `Your previous review response was malformed. Convert it to ONLY a strict JSON array with this exact finding shape, preserving only evidence-backed findings:
${FINDING_SHAPE}

No markdown fences, prose, or extra object keys. Return [] if the content contains no valid finding.

<malformed-response>
${malformed}
</malformed-response>`
}
