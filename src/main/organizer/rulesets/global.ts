import type { RuleDefinition } from '../rules'

export const globalRules: RuleDefinition[] = [
  {
    id: 'required-file/readme',
    source: 'global',
    cite: 'https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes',
    explanation: 'A repository README gives contributors a stable entry point for purpose, setup, usage, and support information. Keeping README.md at the repository root makes that context discoverable in common Git hosting tools and prevents project knowledge from being trapped in chat history.'
  },
  {
    id: 'required-file/license',
    source: 'global',
    cite: 'https://choosealicense.com/',
    explanation: 'A root license file states the terms under which other people may use, modify, and redistribute the project. Without an explicit license, the default copyright position is restrictive, so Organizer calls out the missing decision instead of guessing which license the project owner wants.'
  },
  {
    id: 'required-file/gitignore',
    source: 'global',
    cite: 'https://git-scm.com/docs/gitignore',
    explanation: 'A root .gitignore records intentionally untracked generated files and local state. Keeping these patterns versioned reduces accidental commits of build output, dependency folders, editor state, and secrets while preserving explicit exceptions when a generated-looking file belongs in source control.'
  },
  {
    id: 'naming/kebab-case',
    source: 'global',
    cite: 'https://google.github.io/styleguide/tsguide.html#file-name',
    explanation: 'TypeScript source filenames should use a single predictable lowercase convention so imports remain portable across case-sensitive and case-insensitive filesystems. This ruleset uses descriptive kebab-case names while preserving conventional suffixes such as .test.ts, .spec.ts, and .d.ts.'
  },
  {
    id: 'docs/diataxis',
    source: 'global',
    cite: 'https://diataxis.fr/',
    explanation: 'Diátaxis separates documentation by reader intent into tutorials, how-to guides, reference, and explanation. Maintaining those buckets prevents a generic docs folder from becoming an undifferentiated dump and makes both people and retrieval tools more likely to find the right kind of answer.'
  },
  {
    id: 'adr/madr-log',
    source: 'global',
    cite: 'https://adr.github.io/madr/',
    explanation: 'MADR records architectural decisions with their context, considered options, and consequences in lightweight Markdown. A visible docs/decisions log preserves why the code took its current shape, lets future contributors challenge assumptions with evidence, and keeps decisions reviewable in Git.'
  },
  {
    id: 'dependencies/no-cycles',
    source: 'global',
    cite: 'https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md',
    explanation: 'Circular module dependencies make initialization order and ownership harder to reason about. Organizer delegates graph construction and cycle detection to dependency-cruiser, then reports the concrete dependency path so the project can introduce a stable shared boundary instead of applying a blind file move.'
  },
  {
    id: 'dependencies/version-drift',
    source: 'global',
    cite: 'https://syncpack.dev/',
    explanation: 'Workspace packages should express a consistent version policy for the same external dependency. Organizer delegates package discovery and expected-range calculation to syncpack and reports mismatches without rewriting manifests, because dependency upgrades require an explicit compatibility decision.'
  }
]
