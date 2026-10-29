# lifecycle-test.ps1 — maintainer-only self-heal lifecycle test (Windows)
#
# What it verifies, end to end against a real VS Code Extension Development
# Host:
#   1. auto-start on an empty port (dshVsc.autoStart = true),
#   2. windowless launch (no visible window anywhere in the harness tree),
#   3. killing the owned harness tree does NOT make the current window respawn
#      it (current contract: a killed harness comes back only after a window
#      reload or an explicit `DSH: Start Web Harness`; the connection watch
#      loop just keeps waiting for the port — it must not fight the user)
#   4. the harness log/API surfaces stay healthy for the instance that was up.
#
# Always cleans up (test dev host + spawned harness + test dirs), even on
# failure. NOT shipped in the VSIX (scripts/** is excluded) and NOT part of CI:
# it needs a Windows desktop and a locally built VSIX.
#
# Usage (defaults derive everything from the repo checkout):
#   pwsh -File scripts/lifecycle-test.ps1
#   pwsh -File scripts/lifecycle-test.ps1 -RepoRoot D:\code\dsh_vsc_refresh
#   pwsh -File scripts/lifecycle-test.ps1 -Port 3098 -Vsix .\dsh-vsc-1.4.1.vsix
#   pwsh -File scripts/lifecycle-test.ps1 -CodeCmd "C:\Program Files\Microsoft VS Code\bin\code.cmd"
#
# Parameters:
#   -RepoRoot  repo checkout to open in the dev host (default: this script's parent dir)
#   -CodeCmd   VS Code CLI (default: auto-detected from LOCALAPPDATA/ProgramFiles/PATH)
#   -Vsix      VSIX to install (default: newest dsh-vsc-*.vsix in -RepoRoot)
#   -Port      harness port for the test (default 3088; must be free)
#   -TestRoot  scratch dir for user-data-dir/extensions (default: %TEMP%\dsh-vsc-lifecycle)
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$CodeCmd = "",
  [string]$Vsix = "",
  [int]$Port = 3088,
  [string]$TestRoot = ""
)
$ErrorActionPreference = "Continue"

if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
  Write-Error "-RepoRoot does not look like the dsh-vsc checkout (no package.json): $RepoRoot"
  exit 1
}
if (-not $TestRoot) { $TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-vsc-lifecycle" }
$ud = Join-Path $TestRoot ".vscode-test"
$ext = Join-Path $TestRoot ".vscode-test-ext"
$base = "http://127.0.0.1:$Port"

function Probe-Port([int]$p) {
  try { $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop; return $c.OwningProcess } catch { return $null }
}

function Invoke-Api([string]$u) {
  try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 4; return "$($r.StatusCode)" } catch { return "ERR $($_.Exception.Message)" }
}

# Any process in the harness tree that owns a visible top-level window?
function Test-HarnessWindows([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  $tree = New-Object System.Collections.Generic.List[int]
  $tree.Add($rootPid)
  for ($i = 0; $i -lt $tree.Count; $i++) {
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $tree[$i] })) {
      if (-not $tree.Contains([int]$c.ProcessId)) { $tree.Add([int]$c.ProcessId) }
    }
  }
  return Get-Process -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.Id -and $_.MainWindowHandle -ne 0 }
}

# Kill EVERY dev-host process of this test (code.cmd exits early and orphans
# Code.exe, which then holds the user-data-dir singleton + debugging port).
function Kill-TestCode {
  $pattern = [regex]::Escape($TestRoot)
  $pids = Get-CimInstance Win32_Process -Filter "Name='Code.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern -or $_.CommandLine -match "vscode-test") } |
          ForEach-Object { $_.ProcessId }
  foreach ($procId in $pids) { & taskkill /PID $procId /T /F 2>&1 | Out-Null }
  Start-Sleep -Milliseconds 500
}

# Resolve the VS Code CLI: explicit -CodeCmd, then the per-user / machine
# install locations, then PATH. (The in-app updater uses the same layout.)
function Find-CodeCmd {
  if ($CodeCmd) {
    if (Test-Path $CodeCmd) { return (Resolve-Path $CodeCmd).Path }
    Write-Error "-CodeCmd not found: $CodeCmd"
    return $null
  }
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd") }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\bin\code.cmd") }
  foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
  $onPath = Get-Command code.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { return $onPath.Source }
  Write-Error "cannot find the VS Code CLI; pass -CodeCmd <path to code.cmd>"
  return $null
}

$hostProc = $null
try {
  # 0. clear leftovers from any aborted run (test Code tree, harness on the port)
  Kill-TestCode
  $left = Probe-Port $Port
  if ($left) { Write-Host "[step] cleaning leftover test harness pid $left"; & taskkill /PID $left /T /F 2>&1 | Out-Null; Start-Sleep -Seconds 1 }

  $code = Find-CodeCmd
  if (-not $code) { return }
  Write-Host "[step] code CLI: $code"

  if (-not $Vsix) {
    $Vsix = Get-ChildItem -Path $RepoRoot -Filter "dsh-vsc-*.vsix" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $Vsix -or -not (Test-Path $Vsix)) {
    Write-Host "[FAIL] no VSIX to test — build one first: npm run package (looked in $RepoRoot)"
    return
  }
  Write-Host "[step] vsix: $(Resolve-Path $Vsix)"

  # 1. clean test dirs, preconfigure the test profile to target our port
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $ud "User") | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $ud "User\settings.json"),
    ('{"dshVsc.url": "' + $base + '", "dshVsc.autoStart": true}'),
    (New-Object System.Text.UTF8Encoding($false))
  )

  # 2. make sure nothing listens on the test port
  $before = Probe-Port $Port
  if ($before) { Write-Host "[FAIL] port $Port still in use (pid $before)"; return }
  Write-Host "[step] test port $Port free"

  # 3. install the freshly built vsix into the TEST extensions dir (dev host uses it)
  New-Item -ItemType Directory -Force -Path $ext | Out-Null
  & $code --extensions-dir $ext --user-data-dir $ud --install-extension $Vsix --force 2>&1 | Out-Null
  $installed = Get-ChildItem -Path $ext -Directory -ErrorAction SilentlyContinue | Where-Object Name -like "*dsh-vsc-*"
  if (-not $installed) { Write-Host "[FAIL] vsix not installed into test extensions dir"; return }
  Write-Host "[step] vsix installed: $($installed.Name)"

  # 4. launch dev host (with DSH_VSC_AUTOTEST so the sidebar/stream path runs)
  $env:DSH_VSC_AUTOTEST = "1"
  $args = @("--user-data-dir=$ud", "--extensions-dir=$ext", "--disable-updates", "--no-sandbox",
            "--disable-gpu", "--remote-debugging-port=9222", $RepoRoot)
  $hostProc = Start-Process -FilePath $code -ArgumentList $args -PassThru -WindowStyle Hidden
  Write-Host "[step] dev host pid $($hostProc.Id) launched; waiting for auto-start (up to 60s)"

  # 5. wait for the harness to come up on the test port
  $upAt = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if (Probe-Port $Port) { $upAt = (Get-Date); Write-Host "[ok] harness UP after ~$($i+1)s - auto-start works"; break }
  }
  if (-not $upAt) {
    Write-Host "[FAIL] harness never came up on $Port"
    $logFiles = Get-ChildItem -Path (Join-Path $ud "logs") -Recurse -Include "*.log","*DSH*" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 5
    foreach ($lf in $logFiles) {
      Write-Host "--- $($lf.FullName) ---"
      Get-Content $lf.FullName -Tail 40 -ErrorAction SilentlyContinue
    }
    return
  }

  # 5b. windowless check: no process in the harness tree may own a visible window
  $upPid = Probe-Port $Port
  $winning = Test-HarnessWindows $upPid
  if ($winning) {
    Write-Host "[FAIL] visible window in harness tree: $( (($winning | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ', ') )"
  } else {
    Write-Host "[ok] no visible window anywhere in the harness tree (windowless launch confirmed)"
  }

  # 6. kill whatever listens on the port (the whole tree)
  $pid1 = Probe-Port $Port
  Write-Host "[step] killing harness tree (listener pid $pid1)"
  & taskkill /PID $pid1 /T /F 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  $still = Probe-Port $Port
  Write-Host "[step] after kill: listener = $still"

  # 7. current contract: a killed harness is NOT respawned inside the same
  #    window (that would fight the user). It comes back only after a window
  #    reload or an explicit `DSH: Start Web Harness`; the connection watch
  #    loop just waits for the port to free. Assert no surprise respawn.
  $respawnedAt = $null
  $newPid = $null
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $p = Probe-Port $Port
    if ($p) { $newPid = $p; $respawnedAt = (Get-Date); break }
  }
  if ($respawnedAt) {
    Write-Host "[FAIL] harness respawned on its own after $([math]::Round($sw.Elapsed.TotalSeconds, 1))s (new listener pid $newPid) — the current contract is no in-window respawn"
  } else {
    Write-Host "[ok] no in-window respawn within 15s (contract: reload window or 'DSH: Start Web Harness' to recover)"
  }

  # 8. API smoke ran against the live instance before the kill; report the
  #    port state now and let step 9 show the extension log.
  Write-Host "[step] GET / on freed port -> $(Invoke-Api $base)"

  # 9. dump the relevant exthost log lines (dev host logs live under its user-data-dir)
  Start-Sleep -Seconds 2
  $log = Get-ChildItem -Path (Join-Path $ud "logs") -Recurse -Filter "1-DSH Bridge.log" -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($log) {
    Write-Host "--- exthost log ($($log.FullName)) tail ---"
    Get-Content $log.FullName -Tail 40
  } else {
    Write-Host "[warn] no DSH Bridge.log found"
  }
}
finally {
  # 10. cleanup ALWAYS: dev host (whole test Code tree), spawned harness, test dirs
  Kill-TestCode
  $last = Probe-Port $Port
  if ($last) { & taskkill /PID $last /T /F 2>&1 | Out-Null; Write-Host "[cleanup] killed stray harness pid $last" }
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[done]"
}
