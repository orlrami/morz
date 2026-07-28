Verdict: FINDINGS

The three round-1 root fixes hold against their original repros, but three new boundary defects remain.

1. MEDIUM — Summary truncation corrupts Unicode and marker escaping  
   Location: [render.ts:120](C:/Projects/morz-render/src/main/memory/render.ts:120)

   `slice()` operates on UTF-16 code units. A boundary emoji produced a dangling high surrogate before `…`, which becomes `�` when encoded. Truncating before escaping also turned valid repeated Morz markers into a 167-character “140-character” summary ending in raw `<!--…`, creating an unterminated HTML comment.

   Fix: normalize and escape the bounded input before applying the final cap, then truncate the final output by Unicode code point or grapheme. Assert no unpaired surrogates, raw partial comment openers, or output over 140 characters.

2. MEDIUM — Exact-fitting budgets are treated as over-budget  
   Locations: [render.ts:104](C:/Projects/morz-render/src/main/memory/render.ts:104), [render.ts:167](C:/Projects/morz-render/src/main/memory/render.ts:167)

   Budget accounting includes a terminal newline/blank subsequently removed by `trimEnd()` or `trim()`:

   - A preamble whose returned length is exactly 43 renders `''` with `budget: 43`.
   - A full block requiring 9 body lines—exactly 11 with markers—falls back to summary mode with `lineBudget: 11`, incorrectly reporting truncation.

   Fix: construct output without terminal whitespace before accounting, or subtract the single trimmed terminal line/code unit. Add exact-equality tests asserting full content and no truncation notice.

3. LOW — Empty output becomes three marker lines, not the reserved two  
   Location: [context-hub.ts:315](C:/Projects/morz-render/src/main/services/context-hub.ts:315)

   `renderMemoryBlock(..., {lineBudget: 2})` returns `''`, but the caller creates:

   ```text
   <!-- morz:memory -->

   <!-- /morz:memory -->
   ```

   That is three lines, violating the claimed two-line empty-pair behavior.

   Fix: conditionally render an empty body as `${openMarker}\n${closeMarker}`. Explicitly reject or document budgets below two because a marker pair cannot satisfy them.

Verified:

- Disabled, expired, and superseded duplicates no longer shadow the live row.
- Falsy `expiredAt` semantics are restored.
- The 500 × 50KB repro stayed below the 8 MiB heap threshold.
- Default managed blocks measured exactly 200 lines including markers.
- Unit tests: 41 passed, 1 Windows symlink skip.
- Typecheck passed.
- Required memory E2E suites: 10 passed.