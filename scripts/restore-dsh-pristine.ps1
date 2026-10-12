# restore-dsh-pristine.ps1  [-VerifyOnly]
#
# Verify the official @deepseek-ai/dsh installation is byte-exact to the npm
# registry release (v0.1.7-rc.2). The extension applies its deltas at RUNTIME
# as a per-process ESM loader overlay (src/harness/overlay/), so the installed
# tree must stay pristine ("pure bridge": never write DSH official files).
#
# The old disk-patch scripts (scripts/patch-dsh-*.ps1) and their reversal
# paths are RETIRED: the only remaining in-memory delta patches
# dsh-client-connection/lib/index.js (browser-auth bypass) at load time and
# never touches disk. This script therefore only verifies.
#
# -VerifyOnly is implied (kept for CLI compatibility).
$ErrorActionPreference = "Stop"

$dshRoot = Join-Path $env:APPDATA "npm\node_modules\@deepseek-ai\dsh"
$subRoot = Join-Path $dshRoot "node_modules\@deepseek-ai"
$expectedDshVersion = "0.1.7-rc.2"

# relative path under $subRoot -> pristine SHA256 of the npm release file
$pristine = @{
  "dsh-client-connection\lib\index.js" = "3950F524AED44E28240140A254CD928EA40EBA8E2D04CC8FD04F92A687F5C91D"
}

function Get-Sha256([string]$path) {
  return (Get-FileHash $path -Algorithm SHA256).Hash
}

$failed = 0

foreach ($rel in $pristine.Keys) {
  $file = Join-Path $subRoot $rel
  $label = $rel
  if (-not (Test-Path $file)) {
    Write-Host "[FAIL] $label : file not found: $file" -ForegroundColor Red
    $failed++
    continue
  }

  $hashNow = Get-Sha256 $file
  if ($hashNow -eq $pristine[$rel]) {
    Write-Host "[ok]   $label : pristine ($hashNow)"
  } else {
    Write-Host "[FAIL] $label : NOT pristine (sha256 $hashNow)" -ForegroundColor Red
    Write-Host "       the overlay never writes to disk — reinstall dsh: npm i -g @deepseek-ai/dsh@$expectedDshVersion" -ForegroundColor Red
    $failed++
  }
}

# version sanity
$pkg = Join-Path $dshRoot "package.json"
if (Test-Path $pkg) {
  $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version
  if ($ver -ne $expectedDshVersion) {
    Write-Host "[warn] installed @deepseek-ai/dsh is $ver ; pristine hashes recorded for $expectedDshVersion — upgrade checkpoints in internal/runtime-overlay.md" -ForegroundColor Yellow
  }
}

Write-Host ""
if ($failed -gt 0) { exit 1 }
Write-Host "official DSH body is pristine — the runtime overlay (src/harness/overlay) provides the patch in-memory"
