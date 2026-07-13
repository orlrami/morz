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

## Native modules

`@lydell/node-pty` and `better-sqlite3` are **prebuilt N-API** packages. They are:

- never rebuilt (`npmRebuild: false` in `electron-builder.yml`) — do not run `electron-rebuild` on them
- unpacked from the asar archive (`asarUnpack`) so their `.node` binaries load from disk

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
