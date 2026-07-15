import type { LocalModelProvider, LocalModelStatus } from '../../shared/ipc'

const DEFAULT_TIMEOUT_MS = 1_500
const DEFAULT_ENDPOINTS: Record<LocalModelProvider, string> = {
  ollama: 'http://127.0.0.1:11434',
  'lm-studio': 'http://127.0.0.1:1234'
}

export const LOCAL_CLAUDE_LIMITATION =
  'Local routing requires a Claude-Code-compatible Anthropic /v1/messages endpoint.'

export interface LocalModelDetectorOptions {
  endpoints?: Partial<Record<LocalModelProvider, string>>
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:') return null
    if (url.username || url.password || url.search || url.hash) return null
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') return null
    return url
  } catch {
    return null
  }
}

function endpointFromEnvironment(provider: LocalModelProvider): string | undefined {
  if (process.env.MORZ_E2E !== '1') return undefined
  const candidate = provider === 'ollama' ? process.env.MORZ_OLLAMA_URL : process.env.MORZ_LM_STUDIO_URL
  if (!candidate || !loopbackUrl(candidate)) return undefined
  return candidate
}

function cleanModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value.slice(0, 200)) {
    if (typeof item !== 'string') continue
    const model = item.trim().slice(0, 200)
    if (model && !result.includes(model)) result.push(model)
  }
  return result
}

function modelNames(provider: LocalModelProvider, body: unknown): string[] {
  if (!body || typeof body !== 'object') return []
  const record = body as Record<string, unknown>
  if (provider === 'ollama') {
    const models = Array.isArray(record.models) ? record.models : []
    return cleanModels(models.map((model) =>
      model && typeof model === 'object' ? (model as Record<string, unknown>).name : undefined
    ))
  }
  const data = Array.isArray(record.data) ? record.data : []
  return cleanModels(data.map((model) =>
    model && typeof model === 'object' ? (model as Record<string, unknown>).id : undefined
  ))
}

function probePath(provider: LocalModelProvider): string {
  return provider === 'ollama' ? '/api/tags' : '/v1/models'
}

export class LocalModelDetector {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly endpoints: Record<LocalModelProvider, string>
  private statuses: LocalModelStatus[]

  constructor(options: LocalModelDetectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.endpoints = {
      ollama: options.endpoints?.ollama ?? endpointFromEnvironment('ollama') ?? DEFAULT_ENDPOINTS.ollama,
      'lm-studio': options.endpoints?.['lm-studio']
        ?? endpointFromEnvironment('lm-studio')
        ?? DEFAULT_ENDPOINTS['lm-studio']
    }
    this.statuses = (Object.keys(this.endpoints) as LocalModelProvider[]).map((provider) => ({
      provider,
      baseUrl: this.endpoints[provider],
      healthy: false,
      models: [],
      checkedAt: 0,
      detail: 'Not checked yet'
    }))
  }

  snapshot(): LocalModelStatus[] {
    return this.statuses.map((status) => ({ ...status, models: [...status.models] }))
  }

  async refresh(): Promise<LocalModelStatus[]> {
    this.statuses = await Promise.all(
      (Object.keys(this.endpoints) as LocalModelProvider[]).map((provider) => this.probe(provider))
    )
    return this.snapshot()
  }

  private async probe(provider: LocalModelProvider): Promise<LocalModelStatus> {
    const baseUrl = this.endpoints[provider]
    const parsed = loopbackUrl(baseUrl)
    const checkedAt = this.now()
    if (!parsed) {
      return { provider, baseUrl, healthy: false, models: [], checkedAt, detail: 'Endpoint must be loopback HTTP' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const url = new URL(probePath(provider), parsed)
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (!response.ok) {
        return { provider, baseUrl, healthy: false, models: [], checkedAt, detail: `Probe returned HTTP ${response.status}` }
      }
      const models = modelNames(provider, await response.json() as unknown)
      return {
        provider,
        baseUrl,
        healthy: true,
        models,
        checkedAt,
        detail: models.length ? undefined : 'Server is healthy but reports no models'
      }
    } catch {
      return { provider, baseUrl, healthy: false, models: [], checkedAt, detail: 'Not reachable' }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function firstAvailableLocalModel(statuses: readonly LocalModelStatus[]): LocalModelStatus | null {
  const status = statuses.find((candidate) => candidate.healthy && candidate.models.length > 0)
  return status ? { ...status, models: [...status.models] } : null
}

export function claudeLocalEnv(
  status: LocalModelStatus
): Record<'ANTHROPIC_BASE_URL' | 'ANTHROPIC_MODEL', string> {
  const model = status.models[0]
  if (!status.healthy || !model || !loopbackUrl(status.baseUrl)) {
    throw new Error('A healthy loopback model is required for local Claude routing')
  }
  return {
    ANTHROPIC_BASE_URL: status.baseUrl.replace(/\/$/, ''),
    ANTHROPIC_MODEL: model
  }
}
