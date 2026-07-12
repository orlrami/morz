import { IconGitBranch, IconCoins } from '@tabler/icons-react'
import { colors, statusColor } from '@/lib/tokens'

/* Bottom status bar: branch, fleet counts, CLIs online, spend. Dense, quiet. */
export function StatusBar(): JSX.Element {
  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-4 border-t px-3.5 text-[11px]"
      style={{ background: colors.panel, borderColor: 'var(--color-line)', color: colors.quartzDim }}
    >
      <span className="flex items-center gap-1 font-mono text-[10.5px]">
        <IconGitBranch size={11} stroke={1.5} />
        main ↑2
      </span>
      <Count color={statusColor.working} label="2 working" />
      <Count color={statusColor.blocked} label="1 blocked" />
      <Count color={statusColor.done} label="1 done" />
      <span className="ml-auto">Claude · Codex · agy</span>
      <span className="flex items-center gap-1" style={{ color: colors.bronzeHot }}>
        <IconCoins size={11} stroke={1.5} />
        148k tok · $2.14
      </span>
    </footer>
  )
}

function Count({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
