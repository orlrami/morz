import Database from 'better-sqlite3'
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { spawn } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, extname, isAbsolute, join } from 'path'
import { VoiceApi, type VoiceSettingsSnapshot } from '../../shared/ipc'
import { notify } from './notify-center'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_PROCESS_OUTPUT = 1024 * 1024
const PROBE_TIMEOUT_MS = 5_000
const TRANSCRIBE_TIMEOUT_MS = 60_000

let voiceDb: Database.Database | null = null

function openDb(): Database.Database {
  if (voiceDb) return voiceDb
  const dir = join(app.getPath('appData'), 'Morz')
  mkdirSync(dir, { recursive: true })
  voiceDb = new Database(join(dir, 'morz.db'))
  voiceDb.pragma('journal_mode = WAL')
  voiceDb.exec(`
    CREATE TABLE IF NOT EXISTS voice_settings (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      engine_path TEXT,
      updated_at  INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO voice_settings (id, engine_path, updated_at)
    VALUES (1, NULL, 0);
  `)
  return voiceDb
}

function configuredEnginePath(): string | null {
  const row = openDb()
    .prepare('SELECT engine_path FROM voice_settings WHERE id = 1')
    .get() as { engine_path: string | null }
  return row.engine_path
}

function persistEnginePath(enginePath: string | null): void {
  openDb()
    .prepare('UPDATE voice_settings SET engine_path = ?, updated_at = ? WHERE id = 1')
    .run(enginePath, Date.now())
}

export function voiceSettings(): VoiceSettingsSnapshot {
  const enginePath = configuredEnginePath()
  return { configured: enginePath !== null, enginePath }
}

interface EngineCommand {
  command: string
  prefixArgs: string[]
  cwd: string
}

function engineCommand(enginePath: string): EngineCommand {
  if (typeof enginePath !== 'string' || !enginePath || !isAbsolute(enginePath)) {
    throw new Error('Choose an absolute voice engine path.')
  }
  if (!existsSync(enginePath)) throw new Error('The selected voice engine file does not exist.')
  let stats
  try {
    stats = statSync(enginePath)
  } catch {
    throw new Error('The selected voice engine cannot be read.')
  }
  if (!stats.isFile()) throw new Error('The selected voice engine is not a file.')

  if (extname(enginePath).toLowerCase() === '.js') {
    if (process.env.MORZ_E2E !== '1') {
      throw new Error('Select a native Whisper executable, not a script.')
    }
    const nodePath = process.env.MORZ_E2E_NODE
    if (!nodePath || !isAbsolute(nodePath) || !existsSync(nodePath)) {
      throw new Error('The E2E Node runner is unavailable.')
    }
    return { command: nodePath, prefixArgs: [enginePath], cwd: dirname(enginePath) }
  }

  return { command: enginePath, prefixArgs: [], cwd: dirname(enginePath) }
}

interface ProcessResult {
  stdout: string
  stderr: string
  code: number | null
}

function runEngine(
  engine: EngineCommand,
  args: string[],
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.command, [...engine.prefixArgs, ...args], {
      cwd: engine.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let settled = false

    const finish = (work: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      work()
    }
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>
    ): Buffer<ArrayBufferLike> => {
      if (current.length + chunk.length > MAX_PROCESS_OUTPUT) {
        child.kill()
        finish(() => reject(new Error('Voice engine produced too much output.')))
        return current
      }
      return Buffer.concat([current, chunk])
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', () => {
      finish(() => reject(new Error('The voice engine could not be started.')))
    })
    child.once('close', (code) => {
      finish(() =>
        resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), code })
      )
    })

    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('The voice engine timed out.')))
    }, timeoutMs)
  })
}

export async function validateVoiceEngine(enginePath: string): Promise<void> {
  const engine = engineCommand(enginePath)
  const result = await runEngine(engine, ['--help'], PROBE_TIMEOUT_MS)
  if (result.code !== 0) {
    throw new Error(`Voice engine validation failed with exit code ${result.code ?? 'unknown'}.`)
  }
}

function assertWhisperWav(audio: Buffer): void {
  if (audio.length < 44 || audio.length > MAX_AUDIO_BYTES) {
    throw new Error('Voice audio must be a WAV file smaller than 25 MB.')
  }
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Voice audio must be a WAV file.')
  }
  if (
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt16LE(22) !== 1 ||
    audio.readUInt32LE(24) !== 16_000 ||
    audio.readUInt16LE(34) !== 16
  ) {
    throw new Error('Voice audio must be 16 kHz mono 16-bit PCM WAV.')
  }
}

function transcriptionArgs(enginePath: string, audioPath: string): string[] {
  const name = basename(enginePath).toLowerCase()
  return name.includes('whisper') || name === 'main.exe' || name === 'main'
    ? ['-f', audioPath, '-nt']
    : [audioPath]
}

export async function transcribe(tempAudioPath: string): Promise<string> {
  const enginePath = configuredEnginePath()
  if (!enginePath) throw new Error('Configure a local Whisper engine in Settings first.')
  const audio = readFileSync(tempAudioPath)
  assertWhisperWav(audio)
  const result = await runEngine(
    engineCommand(enginePath),
    transcriptionArgs(enginePath, tempAudioPath),
    TRANSCRIBE_TIMEOUT_MS
  )
  if (result.code !== 0) {
    throw new Error(`Voice transcription failed with exit code ${result.code ?? 'unknown'}.`)
  }
  const transcript = result.stdout
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  if (!transcript) throw new Error('The voice engine returned no transcription.')
  return transcript.slice(0, 4_000)
}

async function transcribeBytes(value: unknown): Promise<string> {
  if (!ArrayBuffer.isView(value)) throw new Error('Voice audio payload is invalid.')
  const audio = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  assertWhisperWav(audio)
  const tempDir = mkdtempSync(join(app.getPath('temp'), 'morz-voice-'))
  const tempAudioPath = join(tempDir, 'recording.wav')
  try {
    writeFileSync(tempAudioPath, audio, { flag: 'wx' })
    return await transcribe(tempAudioPath)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function voiceFailureDetail(error: unknown): string {
  return (error instanceof Error ? error.message : 'Voice request failed.')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[path]')
    .replace(/\\\\[^\r\n]*/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || 'Voice request failed.'
}

function reportVoiceFailure(id: string, title: string, error: unknown): void {
  const detail = voiceFailureDetail(error)
  notify({
    id,
    level: 'error',
    source: 'app',
    title,
    detail
  })
}

export function registerVoiceIpc(): void {
  ipcMain.handle(VoiceApi.settings, () => voiceSettings())
  ipcMain.handle(VoiceApi.chooseEngine, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: OpenDialogOptions = {
      title: 'Choose local Whisper engine',
      properties: ['openFile'],
      filters: [
        { name: 'Executables', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
        ...(process.env.MORZ_E2E === '1' ? [{ name: 'E2E engine', extensions: ['js'] }] : [])
      ]
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return voiceSettings()
    try {
      await validateVoiceEngine(result.filePaths[0])
      persistEnginePath(result.filePaths[0])
      return voiceSettings()
    } catch (error) {
      reportVoiceFailure('voice:voice-engine-is-invalid', 'Voice engine is invalid', error)
      throw new Error(voiceFailureDetail(error))
    }
  })
  ipcMain.handle(VoiceApi.clearEngine, () => {
    persistEnginePath(null)
    return voiceSettings()
  })
  ipcMain.handle(VoiceApi.testTranscription, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: OpenDialogOptions = {
      title: 'Choose a 16 kHz mono PCM WAV file',
      properties: ['openFile'],
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    try {
      return await transcribe(result.filePaths[0])
    } catch (error) {
      reportVoiceFailure('voice:test-transcription-failed', 'Test transcription failed', error)
      throw new Error(voiceFailureDetail(error))
    }
  })
  ipcMain.handle(VoiceApi.transcribe, async (_event, audio: unknown) => {
    try {
      return await transcribeBytes(audio)
    } catch (error) {
      reportVoiceFailure('voice:voice-transcription-failed', 'Voice transcription failed', error)
      throw new Error(voiceFailureDetail(error))
    }
  })
}
