import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { closeMorz, launchMorz, ROOT, type MorzApp } from './app'

function wavFixture(): Buffer {
  const samples = 1_600
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16_000, 24)
  buffer.writeUInt32LE(32_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  return buffer
}

test.describe('local voice dictation', () => {
  let morz: MorzApp
  let enginePath: string
  let audio: number[]

  test.beforeEach(async () => {
    process.env.MORZ_E2E = '1'
    process.env.MORZ_E2E_NODE = process.execPath
    const fixtureDir = join(ROOT, 'e2e', '.tmp', 'voice-fixtures')
    mkdirSync(fixtureDir, { recursive: true })
    enginePath = join(fixtureDir, 'voice-engine.js')
    writeFileSync(
      enginePath,
      "if (process.argv.includes('--help')) process.exit(0)\nprocess.stdout.write('VOICE OK\\n')\n"
    )
    audio = [...wavFixture()]
    morz = await launchMorz()
  })

  test.afterEach(async () => {
    delete process.env.MORZ_E2E
    delete process.env.MORZ_E2E_NODE
    await closeMorz(morz.app)
  })

  async function openVoiceSettings(): Promise<void> {
    await morz.page.getByRole('button', { name: 'Settings' }).click()
    await morz.page.getByRole('button', { name: 'Control' }).click()
    await expect(morz.page.getByRole('region', { name: 'Voice settings' })).toBeVisible()
  }

  async function configureEngine(): Promise<void> {
    await openVoiceSettings()
    await morz.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, enginePath)
    await morz.page.getByRole('button', { name: 'Choose Whisper engine' }).click()
    await expect(morz.page.getByText('Configured', { exact: true })).toBeVisible()
  }

  async function installStubRecorder(): Promise<void> {
    await morz.page.evaluate((wav) => {
      const bytes = new Uint8Array(wav)
      class StubMediaRecorder {
        state = 'inactive'
        mimeType = 'audio/wav'
        ondataavailable: ((event: { data: Blob }) => void) | null = null
        onstop: (() => void) | null = null
        start(): void {
          this.state = 'recording'
        }
        stop(): void {
          this.state = 'inactive'
          this.ondataavailable?.({ data: new Blob([bytes], { type: 'audio/wav' }) })
          this.onstop?.()
        }
      }
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [{ stop(): void {} }] })
        }
      })
      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: StubMediaRecorder
      })
    }, audio)
  }

  test('is invisible in the orchestrator until an engine is configured', async () => {
    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    await expect(morz.page.getByRole('button', { name: 'Hold to dictate' })).toHaveCount(0)
  })

  test('rejects an invalid engine and raises a visible notice', async () => {
    await openVoiceSettings()
    const missing = join(ROOT, 'e2e', '.tmp', 'missing-whisper.exe')
    await morz.app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, missing)

    await morz.page.getByRole('button', { name: 'Choose Whisper engine' }).click()

    await expect(
      morz.page.getByRole('region', { name: 'Voice settings' }).getByRole('alert')
    ).toContainText('engine')
    await expect
      .poll(() =>
        morz.page.evaluate(async () => {
          const notices = await window.morz.notify?.list()
          return notices?.some((notice) => notice.title === 'Voice engine is invalid') ?? false
        })
      )
      .toBe(true)
  })

  test('transcribes fixture audio through the configured engine into the goal', async () => {
    await configureEngine()
    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    await installStubRecorder()

    const mic = morz.page.getByRole('button', { name: 'Hold to dictate' })
    await expect(mic).toBeVisible()
    await morz.page.getByRole('textbox', { name: 'Goal' }).fill('Existing goal')
    await mic.dispatchEvent('pointerdown', { pointerId: 1, button: 0 })
    await expect(morz.page.getByText('Recording…')).toBeVisible()
    await mic.dispatchEvent('pointerup', { pointerId: 1, button: 0 })

    await expect(morz.page.getByRole('textbox', { name: 'Goal' })).toHaveValue(
      'Existing goal VOICE OK'
    )
  })

  test('persists the configured engine across app relaunches', async () => {
    await configureEngine()
    const appDataDir = morz.appDataDir
    await closeMorz(morz.app)
    morz = await launchMorz({ appDataDir })

    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    await expect(morz.page.getByRole('button', { name: 'Hold to dictate' })).toBeVisible()
  })

  test('cancels an active recording with Escape', async () => {
    await configureEngine()
    await morz.page.getByRole('radio', { name: 'Orchestrated' }).click()
    await installStubRecorder()

    const mic = morz.page.getByRole('button', { name: 'Hold to dictate' })
    await mic.dispatchEvent('pointerdown', { pointerId: 1, button: 0 })
    await expect(morz.page.getByText('Recording…')).toBeVisible()
    await morz.page.keyboard.press('Escape')

    await expect(morz.page.getByText('Recording…')).toHaveCount(0)
    await expect(morz.page.getByRole('textbox', { name: 'Goal' })).toHaveValue('')
  })
})
