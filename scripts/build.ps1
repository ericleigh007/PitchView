param(
  [switch]$RunTests,
  [switch]$BuildDesktopBinary
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Initialize-PitchViewEnvironment -RequireCargo -RequirePython

Write-Host "[PitchView] Building frontend"
npm --workspace app/frontend run build

if ($BuildDesktopBinary) {
  Write-Host "[PitchView] Building desktop host"
}
else {
  Write-Host "[PitchView] Checking desktop host"
}

Push-Location app/desktop/src-tauri
if ($BuildDesktopBinary) {
  cargo build
}
else {
  cargo check
}
Pop-Location

if ($RunTests) {
  Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "test.ps1")
}

Write-Host "[PitchView] Build complete"
