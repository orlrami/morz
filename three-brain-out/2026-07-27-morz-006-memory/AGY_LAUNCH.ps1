$host.UI.RawUI.WindowTitle = '3brain-AGY'

$kick = Get-Content -LiteralPath 'C:\Projects\morz\three-brain-out\2026-07-27-morz-006-memory\AGY_KICKOFF.txt' -Raw
Write-Host '[3brain] launching agy with kickoff prompt...' -ForegroundColor Cyan
if ($env:AGY_BRIDGE_MODEL) { agy --dangerously-skip-permissions --model $env:AGY_BRIDGE_MODEL -i $kick } else { agy --dangerously-skip-permissions -i $kick }
