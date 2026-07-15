import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  detail: string | null
}

function errorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'The renderer encountered an unknown error.'
  const clean = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(["'])[^"'\r\n]*\2/gi, '$1=[redacted]')
    .replace(/\b(authorization)\s*[:=]\s*(?:Basic|Bearer|Digest|Negotiate|ApiKey)\s+[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bhttps?:\/\/[^\s]+/gi, (candidate) => {
      try {
        const url = new URL(candidate)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url]'
      }
    })
    .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, 300) || 'The renderer encountered an unknown error.'
}

/** Root render/lifecycle fallback. Async and event-handler failures remain producer-owned. */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { detail: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { detail: errorDetail(error) }
  }

  componentDidCatch(error: unknown): void {
    try {
      window.morz?.notify?.emit({
        id: 'app:renderer-error-boundary',
        level: 'error',
        source: 'app',
        title: 'Morz could not render this view',
        detail: errorDetail(error)
      })
    } catch {
      // The durable notification bridge may be part of the failed surface.
    }
  }

  render(): React.ReactNode {
    if (!this.state.detail) return this.props.children

    return (
      <main
        role="alert"
        aria-labelledby="renderer-error-title"
        className="flex min-h-screen items-center justify-center p-6"
        style={{ background: 'var(--color-page, #26241e)', color: 'var(--color-quartz, #eee6d9)' }}
      >
        <section
          className="w-full max-w-lg rounded-2xl border p-6 shadow-2xl"
          style={{ background: 'var(--color-panel, #2e2b24)', borderColor: 'var(--color-line-strong, #514b40)' }}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--color-bronze-hot, #cba25a)' }}>
            Renderer error
          </p>
          <h1 id="renderer-error-title" className="mt-2 text-lg font-bold">
            Morz could not render this view
          </h1>
          <p className="mt-3 text-sm leading-6" style={{ color: 'var(--color-quartz-dim, #aaa294)' }}>
            {this.state.detail}
          </p>
          <button
            type="button"
            className="mt-5 rounded-lg border px-3 py-2 text-xs font-semibold"
            style={{ borderColor: 'var(--color-line-strong, #514b40)', color: 'var(--color-bronze-hot, #cba25a)' }}
            onClick={() => window.location.reload()}
          >
            Reload Morz
          </button>
        </section>
      </main>
    )
  }
}
