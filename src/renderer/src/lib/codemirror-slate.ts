/*
 * CodeMirror 6 ⇄ Morz Slate bridge.
 * Theme + syntax highlighting driven from the live tokens.css variables
 * (var(--color-*) resolves in the DOM, so theme switches restyle the editor
 * with zero re-render). Plus: lazy language loading, find/replace, and the
 * shared revealPosition(line, col) helper with a transient line highlight.
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, EditorSelection, StateEffect, StateField, Compartment, type Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, indentUnit } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

/* ── Slate theme (all values ride tokens.css vars) ───────────── */

export const slateTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--color-panel)',
      color: 'var(--color-quartz)',
      fontSize: '13px',
      height: '100%'
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      caretColor: 'var(--color-bronze-hot)',
      padding: '8px 0'
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-bronze-hot)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--color-bronze) 24%, transparent)'
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-quartz) 4%, transparent)' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-panel)',
      color: 'var(--color-quartz-faint)',
      borderRight: '1px solid var(--color-line)',
      fontFamily: 'var(--font-mono)'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--color-quartz-dim)'
    },
    '.cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--color-bronze) 18%, transparent)',
      outline: '1px solid var(--color-bronze)'
    },
    '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-quartz) 8%, transparent)' },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--color-blocked) 25%, transparent)',
      outline: '1px solid color-mix(in srgb, var(--color-blocked) 50%, transparent)'
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in srgb, var(--color-bronze) 40%, transparent)'
    },
    '.cm-panels': {
      backgroundColor: 'var(--color-card)',
      color: 'var(--color-quartz)',
      borderBottom: '1px solid var(--color-line-strong)',
      fontFamily: 'var(--font-body)',
      fontSize: '12px'
    },
    '.cm-panels input, .cm-panels button, .cm-panels label': { fontFamily: 'var(--font-body)' },
    '.cm-textfield': {
      backgroundColor: 'var(--color-page)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: 'var(--radius-data)',
      color: 'var(--color-quartz)'
    },
    '.cm-button': {
      background: 'var(--color-card)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: 'var(--radius-data)',
      color: 'var(--color-quartz)',
      backgroundImage: 'none'
    },
    '.cm-button:active': { background: 'var(--color-hover)', backgroundImage: 'none' },
    '.cm-tooltip': {
      backgroundColor: 'var(--color-card)',
      border: '1px solid var(--color-line-strong)',
      borderRadius: 'var(--radius-data)',
      color: 'var(--color-quartz)'
    },
    /* transient jump-target highlight (revealPosition) */
    '.cm-morz-reveal': {
      backgroundColor: 'color-mix(in srgb, var(--color-bronze) 22%, transparent)',
      transition: 'background-color 600ms ease'
    }
  },
  { dark: true }
)

/* Syntax tints ride the same palette: bronze = keywords/brand, status +
 * agent-identity hues cover the rest so every theme recolors the code too. */
export const slateHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--color-bronze)' },
  { tag: [t.controlKeyword, t.definitionKeyword], color: 'var(--color-bronze)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string), t.docString, t.character], color: 'var(--color-done)' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], color: 'var(--color-agent-opencode)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--color-quartz-faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--color-bronze-hot)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--color-agent-gemini)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--color-agent-codex)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--color-quartz)' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName), t.self], color: 'var(--color-agent-claude)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--color-quartz-dim)' },
  { tag: [t.tagName], color: 'var(--color-bronze)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--color-quartz-dim)' },
  { tag: t.invalid, color: 'var(--color-error)' },
  { tag: t.link, color: 'var(--color-bronze-hot)', textDecoration: 'underline' },
  { tag: t.heading, color: 'var(--color-quartz)', fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: [t.inserted], color: 'var(--color-done)' },
  { tag: [t.deleted], color: 'var(--color-error)' },
  { tag: [t.changed], color: 'var(--color-blocked)' }
])

/* ── transient reveal highlight ──────────────────────────────── */

const setReveal = StateEffect.define<{ from: number; to: number } | null>()
const revealMark = Decoration.line({ class: 'cm-morz-reveal' })

const revealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setReveal)) {
        deco = e.value ? Decoration.set([revealMark.range(e.value.from)]) : Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

let revealTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Shared by the terminal ctrl-click pipeline and morz:// deep links:
 * put the cursor at 1-based line/col, scroll it to center, flash the line.
 */
export function revealPosition(view: EditorView, line?: number, col?: number): void {
  const doc = view.state.doc
  const ln = Math.min(Math.max(line ?? 1, 1), doc.lines)
  const info = doc.line(ln)
  const pos = Math.min(info.from + Math.max((col ?? 1) - 1, 0), info.to)

  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: [
      EditorView.scrollIntoView(pos, { y: 'center' }),
      setReveal.of({ from: info.from, to: info.to })
    ]
  })
  view.focus()

  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    if (!view.dom.isConnected) return
    view.dispatch({ effects: setReveal.of(null) })
  }, 1400)
}

/* ── lazy language loading ───────────────────────────────────── */

export const languageCompartment = new Compartment()

/** Resolve + load the language for a filename via @codemirror/language-data (lazy chunks). */
export async function languageFor(path: string): Promise<Extension> {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  const desc =
    languages.find((l) => l.filename?.test(name)) ??
    languages.find((l) => l.extensions.some((ext) => name.toLowerCase().endsWith(`.${ext}`)))
  if (!desc) return []
  const support = await desc.load()
  return support
}

/* ── the full extension set for a Morz editor ────────────────── */

export function slateEditorExtensions(): Extension[] {
  return [
    lineNumbers(),
    foldGutter(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    search({ top: true }),
    slateTheme,
    syntaxHighlighting(slateHighlight, { fallback: true }),
    revealField,
    languageCompartment.of([]),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab])
  ]
}
