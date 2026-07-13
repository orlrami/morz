# morz-integration.ps1 — Morz shell integration (OSC 133 command blocks).
# Dot-sourced at spawn via `pwsh -NoExit -Command . <path>` AFTER the user's
# profile has run — nothing here touches the profile. Works on Windows
# PowerShell 5.1 and pwsh 7 (no `` `e `` escapes, no ?: operator).
#
# Emits FinalTerm-style marks, each signed with the per-session nonce Morz
# passes via env MORZ_BLOCK_NONCE (captured then unset so child processes —
# and any agent running inside them — can never forge marks):
#   OSC 133 ; A ; nonce=<n> BEL      prompt start
#   OSC 133 ; B ; nonce=<n> BEL      command input start (end of prompt)
#   OSC 133 ; C ; nonce=<n> BEL      command executed (output starts)
#   OSC 133 ; D ; <exit> ; nonce=<n> BEL  command finished

if ($Global:__MorzNonce) { return } # already hooked (re-sourced)
if ([string]::IsNullOrEmpty($env:MORZ_BLOCK_NONCE)) { return }

$Global:__MorzNonce = $env:MORZ_BLOCK_NONCE
Remove-Item Env:MORZ_BLOCK_NONCE -ErrorAction SilentlyContinue

$Global:__MorzCommandRan = $false
$Global:__MorzReadLineHooked = $false
$Global:__MorzOriginalPrompt = $function:Prompt

function Global:Prompt {
    # Capture the last command's outcome FIRST — anything we run below clobbers it.
    $lastOk = $global:?
    $lastNative = $global:LASTEXITCODE

    # PSReadLine loads after -Command scripts run; hook its readline lazily so
    # the C mark (output start) fires when the user submits a line.
    if (-not $Global:__MorzReadLineHooked -and (Get-Module -Name PSReadLine)) {
        $Global:__MorzReadLineHooked = $true
        $Global:__MorzOriginalReadLine = $function:PSConsoleHostReadLine
        function Global:PSConsoleHostReadLine {
            $line = & $Global:__MorzOriginalReadLine
            [Console]::Write("$([char]27)]133;C;nonce=$Global:__MorzNonce$([char]7)")
            $line
        }
    }

    $p = if ($Global:__MorzOriginalPrompt) {
        & $Global:__MorzOriginalPrompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)> "
    }

    $esc = [char]27
    $bel = [char]7
    $n = $Global:__MorzNonce
    $d = ''
    if ($Global:__MorzCommandRan) {
        $code = if ($lastOk) { 0 }
        elseif ($lastNative -is [int] -and $lastNative -ne 0) { $lastNative }
        else { 1 }
        $d = "$esc]133;D;$code;nonce=$n$bel"
    }
    $Global:__MorzCommandRan = $true
    # D (prev command done) → A (prompt start) → user prompt → B (input start)
    return "$d$esc]133;A;nonce=$n$bel$p$esc]133;B;nonce=$n$bel"
}
