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
- `morz-<version>-setup.exe.blockmap` — differential-update map
- `latest.yml` — electron-updater metadata

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

This flow was re-verified against the **branded NSIS-installed artifact** on
Windows x64 for Morz 0.0.4 on 2026-07-15:

- `npm run build:win` exited 0 and produced the 102,164,377-byte installer,
  `latest.yml`, and a 106,842-byte blockmap without rebuilding native modules.
- Silent install (`/S`) exited 0 and installed
  `%LOCALAPPDATA%\Programs\Morz\Morz.exe` with product version `0.0.4.0`.
- The installed app opened a visible `Morz` window, rendered the Morz Signal
  and Quicksand wordmark, mounted xterm, and spawned a real PowerShell prompt.
- `echo hi` and `cmd /c exit 3` emitted nonce-signed OSC-133 completion marks;
  the installed UI rendered success `rgb(127, 183, 126)` and failure
  `rgb(217, 124, 106)` gutters.
- Windows extracted the same Morz Signal icon from both the installer and
  installed executable (PNG SHA-256
  `F004A7C27641EFBE155F8F6223206CC53C5FFFF32B8D2DC1F19198D11CBA11F7`),
  covering installer and taskbar icon branding.
- The installed Settings panel showed `Version 0.0.4 · Stable channel` and the
  private/no-token updater state remained silent-off.
- Silent uninstall (`/S`) exited 0 and removed the install directory.

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

## Signing and automatic updates

Builds are currently **UNSIGNED**. Windows SmartScreen is therefore expected to
warn on first install/run (choose "More info" then "Run anyway" only when the
installer came from the trusted Morz release). Signing must be established
before wider distribution; changing from unsigned to signed installers can
break an existing updater trust chain and must be release-tested explicitly.

The updater waits 30 seconds after boot, then checks the fixed
`orlrami/morz` GitHub repository visibility. If the repository is public, the
normal anonymous GitHub release feed is enabled. While it is private, the
updater is enabled only when `MORZ_UPDATE_TOKEN` is present in the Morz process
environment. The token is captured by Main and removed from `process.env`
before PTY/utility children start, so terminal sessions do not inherit it.
Never put this token in source, `electron-builder.yml`, logs, or release assets.

If the repository is private and no token is present, both the boot checker and
manual IPC check stay silent-off: no authenticated updater request, no error
notice, and no crash. Offline visibility/feed failures also fail closed; once
updates are enabled, feed errors surface as an in-app warning.

Available updates download in the background using the NSIS blockmap. The
Notification Center records available, downloading, and ready states. The
trusted **Restart to update** action calls `autoUpdater.quitAndInstall()`; Morz's
existing `before-quit` handler still shuts down the tray-resident PTY host before
the process exits.

### Creating a release

Set `package.json` to the release version first, then build and upload the
installer, differential blockmap, and channel metadata together:

```powershell
npm run build:win
gh release create vX.Y.Z release/*.exe release/*.exe.blockmap release/latest.yml
```

The tag must match the package version (`v0.0.4` for version `0.0.4`), and the
release must be published rather than left as a draft. Installed clients on the
stable channel then discover `latest.yml`, download the installer (differentially
when possible), and surface the restart action through the Notification Center.
Builds always use `--publish never`; `gh release create` is the intentional
publication boundary.

## Tests

```bash
npm run test:e2e   # Playwright (Electron) end-to-end suite
```
