/*
 * Morz IDE pane (0.0.1 Slice 3) — editable CodeMirror 6 "Beside" panel.
 *
 * Rendered by Shell.tsx as a fixed right-side overlay above the shell. It
 * stays mounted but hidden until an 'open-file' event arrives on the renderer
 * bus (terminal ctrl-click, morz:// deep link), then opens the file at
 * line:col.
 *
 * Behaviors (Backend Plan §4): dirty tracking · Ctrl+S atomic save with mtime
 * conflict banner · agent-rewrites-open-file → silent reload preserving
 * scroll+cursor when not dirty, banner when dirty · Open in VS Code / Cursor.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { springs } from '@/lib/springs'
import { EditorView } from '@codemirror/view'
import { EditorState, EditorSelection, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { appEvents } from '../lib/app-events'
import { languageCompartment, languageFor, revealPosition, slateEditorExtensions } from '../lib/codemirror-slate'
import type { FileChangedMsg, MorzApi, OpenFileEvent } from '@shared/ipc'

const morz = (): MorzApi => window.morz as unknown as MorzApi

type Banner =
  | { kind: 'save-conflict'; diskMtimeMs: number }
  | { kind: 'external-change'; diskMtimeMs: number }
  | { kind: 'deleted' }
  | { kind: 'unsaved-switch'; pending: OpenFileEvent }
  | { kind: 'close-dirty'; path: string }
  | { kind: 'load-error'; path: string }
  | null

/** Tab strip entry. Unpinned = preview (italic); editing pins it. */
interface Tab {
  path: string
  pinned: boolean
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p
}

export function IdePane(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [binary, setBinary] = useState(false)
  const [banner, setBanner] = useState<Banner>(null)
  const [editors, setEditors] = useState<('vscode' | 'cursor')[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])

  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const pathRef = useRef<string | null>(null)
  const mtimeRef = useRef(0)
  const dirtyRef = useRef(false)
  const saveRef = useRef<() => void>(() => {})
  const loadSeqRef = useRef(0) // guards racing loadFile calls (fast successive ctrl-clicks)

  const markDirty = (d: boolean): void => {
    dirtyRef.current = d
    setDirty(d)
  }

  /** First edit pins the active preview tab. */
  const pinActiveTab = (): void => {
    const p = pathRef.current
    if (!p) return
    setTabs((ts) => ts.map((t) => (t.path === p && !t.pinned ? { ...t, pinned: true } : t)))
  }

  /** Register `path` in the strip: reuse existing tab, else replace the preview tab, else append. */
  const upsertTab = (path: string): void => {
    setTabs((ts) => {
      if (ts.some((t) => t.path === path)) return ts
      const preview = ts.findIndex((t) => !t.pinned)
      if (preview >= 0) {
        const next = ts.slice()
        next[preview] = { path, pinned: false }
        return next
      }
      return [...ts, { path, pinned: false }]
    })
  }

  const destroyView = (): void => {
    viewRef.current?.destroy()
    viewRef.current = null
  }

  /** Build (or rebuild) the editor with fresh content. */
  const mountDoc = useCallback((content: string) => {
    destroyView()
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: content,
      extensions: [
        ...slateEditorExtensions(),
        Prec.high(
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                saveRef.current()
                return true
              }
            }
          ])
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !dirtyRef.current) {
            markDirty(true)
            pinActiveTab()
          }
        })
      ]
    })
    viewRef.current = new EditorView({ state, parent: hostRef.current })
  }, [])

  const loadFile = useCallback(
    async (ev: OpenFileEvent) => {
      const seq = ++loadSeqRef.current
      const prev = pathRef.current
      try {
        const res = await morz().file.read(ev.path)
        if (seq !== loadSeqRef.current) return // superseded by a newer open
        if (prev && prev !== ev.path) morz().file.unwatch(prev)
        pathRef.current = ev.path
        mtimeRef.current = res.mtimeMs
        setFilePath(ev.path)
        setBanner(null)
        markDirty(false)
        setOpen(true)
        setBinary(res.binary)
        upsertTab(ev.path)
        if (res.binary) {
          destroyView()
          return
        }
        mountDoc(res.content)
        morz().file.watch(ev.path)
        if (viewRef.current) revealPosition(viewRef.current, ev.line, ev.col)
        void languageFor(ev.path).then((lang) => {
          if (pathRef.current !== ev.path) return // doc switched while the language chunk loaded
          viewRef.current?.dispatch({ effects: languageCompartment.reconfigure(lang) })
        })
      } catch (err) {
        console.error('[morz-ide] read failed', ev.path, err)
        if (seq !== loadSeqRef.current) return
        setBanner({ kind: 'load-error', path: ev.path })
        setOpen(true)
      }
    },
    [mountDoc]
  )

  /** Shared open entry: terminal ctrl-click, deep links, tab clicks. */
  const requestOpen = useCallback(
    (ev: OpenFileEvent): void => {
      if (pathRef.current === ev.path && viewRef.current) {
        setOpen(true)
        if (ev.line !== undefined) revealPosition(viewRef.current, ev.line, ev.col)
        return
      }
      if (dirtyRef.current) {
        setBanner({ kind: 'unsaved-switch', pending: ev })
        setOpen(true)
        return
      }
      void loadFile(ev)
    },
    [loadFile]
  )

  /* open-file events from the terminal link pipeline / deep links */
  useEffect(() => {
    const onOpen = (ev: OpenFileEvent): void => requestOpen(ev)
    appEvents.on('open-file', onOpen)
    return () => appEvents.off('open-file', onOpen)
  }, [requestOpen])

  /* file:changed push — silent reload when clean, banner when dirty */
  useEffect(() => {
    morz().file.onChanged((msg: FileChangedMsg) => {
      if (msg.path !== pathRef.current) return
      if (msg.kind === 'deleted') {
        setBanner({ kind: 'deleted' })
        return
      }
      if (dirtyRef.current) {
        setBanner({ kind: 'external-change', diskMtimeMs: msg.mtimeMs })
        return
      }
      void silentReload()
    })
    morz()
      .editor.detect()
      .then(setEditors)
      .catch(() => setEditors([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const silentReload = async (): Promise<void> => {
    const path = pathRef.current
    const view = viewRef.current
    if (!path || !view) return
    const res = await morz().file.read(path)
    if (pathRef.current !== path || viewRef.current !== view) return // doc switched mid-read
    if (res.binary) return
    const scrollTop = view.scrollDOM.scrollTop
    const head = view.state.selection.main.head
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: res.content },
      selection: EditorSelection.cursor(Math.min(head, res.content.length))
    })
    view.scrollDOM.scrollTop = scrollTop
    mtimeRef.current = res.mtimeMs
    markDirty(false)
    setBanner(null)
  }

  const save = useCallback(async (expectedMtimeMs?: number) => {
    const path = pathRef.current
    const view = viewRef.current
    if (!path || !view) return
    const res = await morz().file.save(path, view.state.doc.toString(), expectedMtimeMs ?? mtimeRef.current)
    if (res.ok) {
      mtimeRef.current = res.mtimeMs
      markDirty(false)
      setBanner(null)
    } else {
      setBanner({ kind: 'save-conflict', diskMtimeMs: res.mtimeMs })
    }
  }, [])
  saveRef.current = () => void save()

  const close = (): void => {
    if (pathRef.current) morz().file.unwatch(pathRef.current)
    destroyView()
    pathRef.current = null
    setFilePath(null)
    setBanner(null)
    setTabs([])
    markDirty(false)
    setOpen(false)
  }

  /** Remove a tab; guard the active-dirty case behind a banner. */
  const closeTab = (path: string): void => {
    if (path === pathRef.current && dirtyRef.current) {
      setBanner({ kind: 'close-dirty', path })
      return
    }
    reallyCloseTab(path)
  }

  const reallyCloseTab = (path: string): void => {
    const idx = tabs.findIndex((t) => t.path === path)
    const rest = tabs.filter((t) => t.path !== path)
    setTabs(rest)
    if (path !== pathRef.current) return
    if (rest.length === 0) {
      close()
      return
    }
    markDirty(false) // edits discarded with the tab
    setBanner(null)
    const next = rest[Math.min(Math.max(idx - 1, 0), rest.length - 1)]
    void loadFile({ path: next.path })
  }

  const openExternal = (editor: 'vscode' | 'cursor'): void => {
    const path = pathRef.current
    if (!path) return
    const view = viewRef.current
    let line: number | undefined
    let col: number | undefined
    if (view) {
      const head = view.state.selection.main.head
      const ln = view.state.doc.lineAt(head)
      line = ln.number
      col = head - ln.from + 1
    }
    morz().editor.openExternal(editor, path, line, col)
  }

  /*
   * The pane stays MOUNTED always (never AnimatePresence-unmounted): the
   * editor host div must exist BEFORE loadFile's mountDoc runs (setOpen(true)
   * has not committed yet on the first open — a conditional render would leave
   * hostRef null and silently drop the editor). Hidden = slid off-screen right
   * with the same spring the file explorer uses.
   */
  const btn =
    'px-2 py-1 rounded-[var(--radius-data)] border border-line-strong text-[11px] font-body transition-colors'
  const btnLive = `${btn} text-quartz hover:bg-hover cursor-pointer`
  const btnDead = `${btn} text-quartz-faint cursor-not-allowed`

  return (
    <motion.div
      className="fixed right-0 flex flex-col bg-panel border-l border-line-strong shadow-2xl"
      initial={false}
      animate={
        open
          ? { x: 0, opacity: 1, transition: springs.panel }
          : { x: '105%', opacity: 0, transition: { duration: 0.16 } }
      }
      style={{
        top: 38,
        bottom: 0,
        width: 'min(48vw, 760px)',
        minWidth: 420,
        zIndex: 60,
        pointerEvents: open ? 'auto' : 'none'
      }}
    >
      {/* header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0">
        <span className="font-mono text-[12px] text-quartz truncate" title={filePath ?? ''}>
          {filePath ? baseName(filePath) : ''}
        </span>
        {dirty && <span className="w-1.5 h-1.5 rounded-full bg-bronze shrink-0" title="Unsaved changes" />}
        <div className="flex-1" />
        <button
          className={editors.includes('vscode') ? btnLive : btnDead}
          disabled={!editors.includes('vscode')}
          onClick={() => openExternal('vscode')}
          title={editors.includes('vscode') ? 'Open in VS Code at cursor' : 'VS Code not detected'}
        >
          VS Code
        </button>
        <button
          className={editors.includes('cursor') ? btnLive : btnDead}
          disabled={!editors.includes('cursor')}
          onClick={() => openExternal('cursor')}
          title={editors.includes('cursor') ? 'Open in Cursor at cursor' : 'Cursor not detected'}
        >
          Cursor
        </button>
        <button className={`${btnLive} ml-1`} onClick={close} title="Close editor">
          ✕
        </button>
      </div>

      {/* tab strip */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-0.5 px-1.5 h-7 border-b border-line overflow-x-auto shrink-0">
          {tabs.map((t) => {
            const active = t.path === filePath
            return (
              <div
                key={t.path}
                className={`group flex items-center gap-1 px-2 h-[22px] rounded-[var(--radius-data)] font-mono text-[11px] cursor-pointer shrink-0 ${
                  active ? 'bg-card text-quartz' : 'text-quartz-dim hover:bg-hover'
                }`}
                title={t.path}
                onClick={() => requestOpen({ path: t.path })}
              >
                <span className={t.pinned ? '' : 'italic'}>{baseName(t.path)}</span>
                {active && dirty && <span className="w-1.5 h-1.5 rounded-full bg-bronze shrink-0" />}
                <button
                  className="text-quartz-faint hover:text-quartz leading-none px-0.5"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.path)
                  }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* banners */}
      {banner && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] font-body bg-card border-b border-line-strong text-quartz shrink-0">
          {banner.kind === 'save-conflict' && (
            <>
              <span className="text-blocked">File changed on disk since you opened it.</span>
              <div className="flex-1" />
              <button className={btnLive} onClick={() => void save(banner.diskMtimeMs)}>
                Overwrite
              </button>
              <button className={btnLive} onClick={() => void silentReload()}>
                Reload (discard mine)
              </button>
            </>
          )}
          {banner.kind === 'external-change' && (
            <>
              <span className="text-blocked">File changed on disk — you have unsaved edits.</span>
              <div className="flex-1" />
              <button className={btnLive} onClick={() => void silentReload()}>
                Reload (discard mine)
              </button>
              <button className={btnLive} onClick={() => setBanner(null)}>
                Keep mine
              </button>
            </>
          )}
          {banner.kind === 'deleted' && (
            <>
              <span className="text-error">File was deleted on disk.</span>
              <div className="flex-1" />
              <button className={btnLive} onClick={() => setBanner(null)}>
                Dismiss
              </button>
            </>
          )}
          {banner.kind === 'close-dirty' && (
            <>
              <span className="text-blocked">Unsaved changes in {baseName(banner.path)}.</span>
              <div className="flex-1" />
              <button className={btnLive} onClick={() => reallyCloseTab(banner.path)}>
                Discard &amp; close
              </button>
              <button className={btnLive} onClick={() => setBanner(null)}>
                Keep
              </button>
            </>
          )}
          {banner.kind === 'load-error' && (
            <>
              <span className="text-error">Could not read {baseName(banner.path)}.</span>
              <div className="flex-1" />
              <button className={btnLive} onClick={() => setBanner(null)}>
                Dismiss
              </button>
            </>
          )}
          {banner.kind === 'unsaved-switch' && (
            <>
              <span className="text-blocked">Unsaved changes in {filePath ? baseName(filePath) : 'file'}.</span>
              <div className="flex-1" />
              <button className={btnLive} onClick={() => void loadFile(banner.pending)}>
                Discard &amp; open {baseName(banner.pending.path)}
              </button>
              <button className={btnLive} onClick={() => setBanner(null)}>
                Stay
              </button>
            </>
          )}
        </div>
      )}

      {/* editor host / binary notice */}
      {binary ? (
        <div className="flex-1 flex items-center justify-center text-quartz-dim text-[12px] font-body">
          Binary file — not editable here.
        </div>
      ) : (
        <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" />
      )}
    </motion.div>
  )
}

/*
 * No self-mount side effect: Shell.tsx renders <IdePane /> directly. The old
 * import-side-effect mount plus Shell's render produced TWO live panes (both
 * subscribed to 'open-file', stacked overlays, duplicate DOM for tests).
 */
