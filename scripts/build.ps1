param(
  [switch]$RunTests
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Initialize-PitchViewEnvironment -RequireCargo -RequirePython

Write-Host "[PitchView] Building frontend"
npm --workspace app/frontend run build

Write-Host "[PitchView] Checking desktop host"
Push-Location app/desktop/src-tauri
cargo check
Pop-Location

if ($RunTests) {
  Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "test.ps1")
}

Write-Host "[PitchView] Build complete"
