import { IconGitBranch } from '@tabler/icons-react'
import { cliUsages, cliTint, cliLabel } from '@/lib/mock'
import { colors, statusColor } from '@/lib/tokens'
import { ModeDialCompact } from './ModeDialCompact'

interface StatusBarProps {
  onOpenCommit?: () => void
}

/*
 * Bottom status bar: branch, fleet counts, per-CLI rate-limit meters, control dial.
 * Usage meters show each membership's rolling-window consumption — the thing that
 * actually gates a multi-CLI fleet (token totals live in Settings instead).
 */
export function StatusBar({ onOpenCommit }: StatusBarProps): JSX.Element {
  return (
    <footer
      className="flex h-7 shrink-0 items-center gap-4 border-t px-3.5 text-[11px]"
      style={{ background: colors.panel, borderColor: 'var(--color-line)', color: colors.quartzDim }}
    >
      <button
        className="flex cursor-pointer items-center gap-1 font-mono text-[10.5px] hover:brightness-125"
        style={{ color: colors.quartzDim }}
        onClick={onOpenCommit}
        title="Open commit panel"
      >
        <IconGitBranch size={11} stroke={1.5} />
        main ↑2
      </button>
      <Count color={statusColor.working} label="2 working" />
      <Count color={statusColor.blocked} label="1 blocked" />
      <Count color={statusColor.done} label="1 done" />

      <div className="ml-auto flex items-center gap-3">
        {cliUsages.map((u) => (
          <span
            key={u.cli}
            className="flex items-center gap-1.5"
            title={`${cliLabel[u.cli]} ${u.plan} — ${u.used}% of window used · resets in ${u.resetIn}`}
          >
            <span className="text-[9.5px] font-medium" style={{ color: cliTint[u.cli] }}>
              {cliLabel[u.cli]}
            </span>
            <span
              className="h-[5px] w-9 overflow-hidden rounded-full"
              style={{ background: 'rgba(238,230,217,0.10)' }}
              role="meter"
              aria-valuenow={u.used}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${cliLabel[u.cli]} usage`}
            >
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${u.used}%`,
                  background: u.used >= 75 ? statusColor.blocked : cliTint[u.cli]
                }}
              />
            </span>
          </span>
        ))}

        <ModeDialCompact />
      </div>
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
