import type { CSSProperties, HTMLAttributes, SVGProps } from 'react'

interface MorzSignalProps extends SVGProps<SVGSVGElement> {
  goldPoint?: boolean
}

/** Canonical Morz Signal geometry, kept inline so it follows the surrounding text color. */
export function MorzSignal({ goldPoint = true, ...props }: MorzSignalProps): JSX.Element {
  return (
    <svg
      data-testid="morz-signal"
      viewBox="0 0 104 76"
      fill="none"
      aria-hidden={props['aria-label'] || props['aria-labelledby'] ? undefined : true}
      focusable="false"
      {...props}
    >
      <path
        d="M15 37 C31 37 30 57 47 57 C64 57 66 33 90 30"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
      />
      <circle
        cx="52"
        cy="13"
        r="7.5"
        fill={goldPoint ? 'var(--morz-gold, var(--color-bronze-hot))' : 'currentColor'}
      />
    </svg>
  )
}

type MorzWordmarkProps = HTMLAttributes<HTMLSpanElement>

/** Live-text wordmark: Quicksand 600 matches the outlined distribution lockup. */
export function MorzWordmark({ style, ...props }: MorzWordmarkProps): JSX.Element {
  const wordmarkStyle: CSSProperties = {
    fontFamily: 'var(--font-wordmark)',
    fontWeight: 600,
    letterSpacing: '-0.02em',
    ...style
  }

  return (
    <span data-testid="morz-wordmark" style={wordmarkStyle} {...props}>
      Morz
    </span>
  )
}
