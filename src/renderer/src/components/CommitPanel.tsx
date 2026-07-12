import { useState } from 'react'
import { motion } from 'framer-motion'
import { IconSparkles, IconGitCommit, IconPlus, IconMinus } from '@tabler/icons-react'
import { changedFiles, limiterDiff, cliTint } from '@/lib/mock'
import { colors } from '@/lib/tokens'
import { staggerContainer, staggerItem, springs } from '@/lib/springs'

const CHANGE_COLOR: Record<string, string> = {
  M: colors.warning,
  A: colors.done,
  D: colors.error
}

/*
 * LazyGit-style commit surface, desktop-native:
 * unstaged above / staged below (the whole "is this ready?" answer),
 * click-to-stage hunks in the diff, AI message on the staged diff only.
 */
export function CommitPanel(): JSX.Element {
  const [message, setMessage] = useState('')
  const unstaged = changedFiles.filter((f) => !f.staged)
  const staged = changedFiles.filter((f) => f.staged)

  return (
    <section className="flex min-w-0 flex-1" style={{ background: colors.page }} aria-label="Commit">
      {/* file lists */}
      <div className="flex w-[280px] shrink-0 flex-col border-r" style={{ borderColor: 'var(--color-line)' }}>
        <FileGroup title={`Unstaged — ${unstaged.length}`} files={unstaged} dim />
        <div className="border-t" style={{ borderColor: 'var(--color-line-strong)' }} />
        <FileGroup title={`Staged — ${staged.length} · ready to commit`} files={staged} />

        {/* message + actions */}
        <div className="mt-auto border-t p-3" style={{ borderColor: 'var(--color-line)' }}>
          <div className="relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message…"
              rows={3}
              className="w-full resize-none rounded-[10px] border bg-transparent p-2.5 pr-9 text-xs outline-none placeholder:text-[rgba(238,230,217,0.35)]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartz }}
            />
            <button
              className="absolute right-2 top-2 cursor-pointer rounded-md p-1 hover:bg-[#37332B]"
              title="Generate message from the staged diff"
              aria-label="Generate commit message"
              style={{ color: colors.bronzeHot }}
              onClick={() => setMessage('feat(api): add per-minute rate limiter with burst tests')}
            >
              <IconSparkles size={14} stroke={1.5} />
            </button>
          </div>
          <div className="mt-2 flex gap-1.5">
            <motion.button
              whileHover={{ scale: 1.02 }}
              transition={springs.snappy}
              className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs font-semibold"
              style={{
                background: `linear-gradient(180deg, ${colors.bronzeHot}, ${colors.bronze})`,
                color: '#241c0a',
                fontFamily: 'var(--font-display)'
              }}
            >
              <IconGitCommit size={13} stroke={2} />
              Commit
            </motion.button>
            <button
              className="cursor-pointer rounded-[10px] border px-2.5 py-1.5 text-[11px]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              title="Amend the previous commit"
            >
              Amend
            </button>
            <button
              className="cursor-pointer rounded-[10px] border px-2.5 py-1.5 text-[11px]"
              style={{ borderColor: 'var(--color-line-strong)', color: colors.quartzDim }}
              title="Commit without running hooks"
            >
              --no-verify
            </button>
          </div>
        </div>
      </div>

      {/* diff with hunk staging */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex items-center gap-2 border-b px-3 py-2 font-mono text-[11px]"
          style={{ borderColor: 'var(--color-line)', color: colors.quartzDim }}
        >
          src/api/limiter.ts
          <span className="rounded px-1 text-[9px] font-bold" style={{ color: CHANGE_COLOR.M }}>
            M
          </span>
          <span className="ml-auto text-[10px]">click a hunk header to stage / unstage it</span>
        </div>
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="flex-1 overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed"
        >
          {limiterDiff.map((line, i) =>
            line.kind === 'hunk' ? (
              <motion.button
                key={i}
                variants={staggerItem}
                className="mb-1 mt-2 flex w-full cursor-pointer items-center gap-2 rounded-md border px-2 py-1 text-left text-[10.5px] transition-colors hover:border-[rgba(203,162,90,0.5)]"
                style={{ borderColor: 'var(--color-line-strong)', color: colors.bronzeHot, background: colors.panel }}
              >
                <IconPlus size={11} stroke={2} />
                {line.text}
                <span className="ml-auto text-[9.5px]" style={{ color: colors.quartzDim }}>
                  stage hunk
                </span>
              </motion.button>
            ) : (
              <motion.p
                key={i}
                variants={staggerItem}
                className="whitespace-pre px-2"
                style={{
                  color:
                    line.kind === 'add' ? colors.done : line.kind === 'del' ? colors.error : colors.quartzDim,
                  background:
                    line.kind === 'add'
                      ? 'rgba(34,197,94,0.07)'
                      : line.kind === 'del'
                        ? 'rgba(239,68,68,0.07)'
                        : 'transparent'
                }}
              >
                {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                {line.text}
              </motion.p>
            )
          )}
        </motion.div>
      </div>
    </section>
  )
}

function FileGroup({
  title,
  files,
  dim
}: {
  title: string
  files: typeof changedFiles
  dim?: boolean
}): JSX.Element {
  return (
    <div className="p-2">
      <p className="px-1.5 pb-1 text-[9.5px] uppercase tracking-wider" style={{ color: colors.quartzDim }}>
        {title}
      </p>
      <ul className="space-y-px">
        {files.map((f) => (
          <li key={f.path}>
            <button
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left font-mono text-[11px] transition-colors hover:bg-[#37332B]"
              style={{ color: dim ? colors.quartzDim : colors.quartz }}
              title={`${f.staged ? 'Unstage' : 'Stage'} ${f.path} · changed by ${f.agent}`}
            >
              {f.staged ? (
                <IconMinus size={10} stroke={2} style={{ color: colors.quartzDim }} />
              ) : (
                <IconPlus size={10} stroke={2} style={{ color: colors.done }} />
              )}
              <span className="truncate">{f.path}</span>
              <span className="ml-auto flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" style={{ background: cliTint.codex }} title={f.agent} />
                <span className="font-bold" style={{ color: CHANGE_COLOR[f.change], fontSize: 9 }}>
                  {f.change}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
