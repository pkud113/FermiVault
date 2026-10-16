# Startup and idle-memory budgets for the built app (Windows). CI runs it on every push:
#   pwsh scripts/bench-startup.ps1 -Exe <fermivault.exe> -Vault <dir from bench-vault.mjs>
# Cold start = launch until the first frame with the vault open; idle RAM = private working set
# of the app and its WebView2 processes, 10 s after the last launch is ready.
param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Vault, [int]$Runs = 4)
$ErrorActionPreference = "Stop"
$StartBudgetMs = 400
$RamBudgetMB = 150

# Open the bench vault on launch, like a returning user.
$cfg = Join-Path $env:APPDATA "dev.fermivault.app"
New-Item -ItemType Directory -Force $cfg | Out-Null
@{ vault = (Resolve-Path $Vault).Path } | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $cfg "state.json")

function Tree([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = @($root); $i = 0
  while ($i -lt $ids.Count) { $ids += @($all | Where-Object ParentProcessId -eq $ids[$i] | ForEach-Object ProcessId); $i++ }
  $ids
}

$ready = Join-Path ([IO.Path]::GetTempPath()) "fermivault-ready"
$env:FERMIVAULT_BENCH_READY = $ready
$times = @(); $ramMB = 0
for ($run = 1; $run -le $Runs; $run++) {
  Remove-Item $ready -ErrorAction SilentlyContinue
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process $Exe -PassThru
  while (-not (Test-Path $ready)) {
    if ($sw.ElapsedMilliseconds -gt 60000) { throw "the app didn't open the vault within 60 s" }
    Start-Sleep -Milliseconds 5
  }
  $times += $sw.ElapsedMilliseconds
  if ($run -eq $Runs) {
    Start-Sleep -Seconds 10
    $ids = Tree $p.Id
    $bytes = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains $_.IDProcess } | Measure-Object WorkingSetPrivate -Sum).Sum
    $ramMB = [math]::Round($bytes / 1MB)
  }
  taskkill /PID $p.Id /T /F | Out-Null
  Start-Sleep -Seconds 2
}

# The first launch also creates the WebView2 profile; budgets use the later ones.
$steps = Get-Content $ready -Raw
Write-Output "Last launch, ms after the app's own start (`"rust`") or the page's (`"webview`"): $steps"
$warm = $times[1..($times.Count - 1)] | Sort-Object
$median = $warm[[math]::Floor($warm.Count / 2)]
$report = @"
| Budget | Measured | Limit |
|---|---|---|
| Cold start to vault shown (median of $($warm.Count)) | $median ms | $StartBudgetMs ms |
| First launch ever (creates WebView2 profile) | $($times[0]) ms | report only |
| Idle RAM (app + WebView2, private) | $ramMB MB | $RamBudgetMB MB |
"@
Write-Output $report
if ($env:GITHUB_STEP_SUMMARY) { "### Startup budgets`n$report`n`nLast launch: ``$steps``" | Add-Content $env:GITHUB_STEP_SUMMARY }
$fail = @()
if ($median -gt $StartBudgetMs) { $fail += "cold start $median ms > $StartBudgetMs ms" }
if ($ramMB -gt $RamBudgetMB) { $fail += "idle RAM $ramMB MB > $RamBudgetMB MB" }
if ($fail) { Write-Output "::error::Over budget: $($fail -join '; ')"; exit 1 }
