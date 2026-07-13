# Building & Installing Morz

## Prerequisites

- Windows 10/11 x64
- Node.js 22+ and npm
- `npm install` (native modules — `@lydell/node-pty`, `better-sqlite3` — ship prebuilt N-API binaries; no build toolchain needed)

## Dev

```bash
npm run dev        # electron-vite dev server + Electron
npm run typecheck  # tsc over main + renderer
npm run build      # compile only (out/), no installer
```

## Producing the installer

```bash
npm run build:win
```

(`npm run dist` is an alias.)

This runs `electron-vite build` then `electron-builder --win --publish never` and drops artifacts into `release/`:

- `morz-<version>-setup.exe` — NSIS **one-click, per-user** installer (no admin prompt)
- `latest.yml` + blockmap — electron-updater metadata (updates not enabled yet)

Install by running the setup exe. It installs to `%LOCALAPPDATA%\Programs\Morz` and creates Start Menu + desktop shortcuts. Uninstall via Windows Settings → Apps.

## Verifying the installed artifact

Run this check against the NSIS-installed copy, not `release/win-unpacked`:

```powershell
npm run build:win

$setup = (Resolve-Path 'release\morz-*-setup.exe').Path
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Morz'
$exe = Join-Path $installDir 'Morz.exe'

$install = Start-Process $setup -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0 -or -not (Test-Path $exe)) {
  throw "Morz installation failed with exit code $($install.ExitCode)"
}

Start-Process $exe
```

In a PowerShell terminal pane, wait for the prompt and run:

```powershell
echo hi
cmd /c exit 3
```

The installed-artifact check passes when `hi` is printed, both commands create
OSC-133 command blocks, the successful block has a green gutter, and the
exit-code 3 block has a red gutter. This exercises the packaged PTY host,
prebuilt ConPTY binary, and the shell-integration script loaded from Electron's
`resources` directory.

Morz stays resident in the tray after its window closes. Exit it from the tray
before silently uninstalling:

```powershell
$uninstaller = Join-Path $installDir 'Uninstall Morz.exe'
$uninstall = Start-Process $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) {
  throw "Morz uninstall failed with exit code $($uninstall.ExitCode)"
}
```

This flow was verified on Windows x64 for Morz 0.1.0 on 2026-07-13. The
installed app spawned PowerShell, emitted nonce-signed A/B/C/D OSC-133 marks,
rendered green (`#22C55E`) and red (`#EF4444`) gutters, and uninstalled with
exit code 0.

## Native modules

`@lydell/node-pty` and `better-sqlite3` are **prebuilt N-API** packages. They are:

- never rebuilt (`npmRebuild: false` in `electron-builder.yml`) — do not run `electron-rebuild` on them
- unpacked from the asar archive (`asarUnpack`) so their `.node` binaries load from disk

The builder file set also includes the aliased Windows ConPTY package and the
runtime-only `readdirp`, `bindings`, and `file-uri-to-path` packages explicitly.
This is required when `node_modules` is a workspace junction because
electron-builder's production-dependency walker may not follow those entries.

If terminals or the DB fail in a packaged build but work in dev, check that the unpack patterns in `electron-builder.yml` still match the module paths under `app.asar.unpacked/`.

## Data directories

| Path | Contents |
|------|----------|
| `%APPDATA%\Morz` | config, session state, SQLite DB |
| `%LOCALAPPDATA%\Morz` | caches, GPU shader cache, logs |

Uninstalling does **not** delete these (`deleteAppDataOnUninstall: false`).

## Signing & updates (not yet)

Builds are **UNSIGNED** for now — SmartScreen will warn on first run ("More info" → "Run anyway"). Plan: **Azure Trusted Signing** before wider distribution. Note the unsigned→signed switch breaks the electron-updater chain, so signing lands before auto-update is turned on.

`electron-builder.yml` already carries the electron-updater GitHub-releases feed config (`publish: github`), but every build runs with `--publish never`; releases are manual until signing is in place.

## Tests

```bash
npm run test:e2e   # Playwright (Electron) end-to-end suite
```
