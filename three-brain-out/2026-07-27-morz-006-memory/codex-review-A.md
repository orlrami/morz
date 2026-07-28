Verdict: FINDINGS

1. MEDIUM — inactive duplicates can suppress live facts  
   Location: [render.ts:63](/C:/Projects/morz-render/src/main/memory/render.ts:63)

   Deduplication happens before enabled/expired/superseded filtering. A disabled, expired, or superseded `dup` followed by a live `dup` produces no output:

   ```text
   disabled first   → selected []
   expired first    → selected []
   superseded first → selected []
   ```

   Duplicate IDs are possible in manually edited scope files because the loader does not reject them. This also introduces an undeclared context-block behavior: the old block renderer showed duplicates; the new one silently collapses them.

   Fix: filter renderable entries before deduplication, then add regressions for inactive-first/live-second duplicates.

2. MEDIUM — budget fallback first materializes the unbounded block  
   Location: [render.ts:123](/C:/Projects/morz-render/src/main/memory/render.ts:123)

   The renderer escapes and joins every full body before checking the line budget. With 500 permitted 50,000-character bodies, the repro allocated approximately 24.9 MB to produce a 31.9 KB summary:

   ```text
   inputChars: 25,000,000
   outputChars: 31,932
   heapDeltaMB: 24.9
   ```

   There is no fact-count cap, so this scales toward main-process memory exhaustion.

   Fix: count/accumulate lines incrementally and enter summary mode immediately once the budget is exceeded. Do not construct the discarded full string.

3. LOW — configured budgets are not hard limits  
   Locations: [render.ts:85](/C:/Projects/morz-render/src/main/memory/render.ts:85), [render.ts:140](/C:/Projects/morz-render/src/main/memory/render.ts:140), [context-hub.ts:315](/C:/Projects/morz-render/src/main/services/context-hub.ts:315)

   Proven boundary failures:

   - `budget: 0` returns the 21-character preamble heading.
   - `lineBudget: 0–5` returns a six-line block.
   - At 194+ facts, `renderMemoryBlock` returns 200 lines, then `replaceManagedBlock` adds two marker lines, producing a 202-line managed block.

   Fix: define the budget as the complete managed block, reserve the two marker lines inside the renderer, and reject or explicitly handle budgets smaller than the mandatory header/truncation output.

Marker escaping survived hostile paired, unpaired, nested, and case-insensitive Morz markers. Call-site rewiring is complete; no old renderer references remain outside comments. The preamble now also escapes marker-like titles—an undeclared but beneficial behavior change. `expiredAt === undefined` also differs from the previous nullish/falsy interpretation, although current storage normalization prevents that difference in normal files.

Verification completed:

- Typecheck: passed
- Production build: passed
- Focused unit tests: 37 passed, 1 platform skip
- Required e2e files: 10/10 passed
- `git diff --check`: clean