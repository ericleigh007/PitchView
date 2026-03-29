$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Write-Host "[PitchView] Launching desktop app"
Initialize-PitchViewEnvironment -RequireCargo -RequirePython

if (-not (Test-Path "./node_modules") -or -not (Test-Path "./app/frontend/node_modules")) {
  Write-Host "[PitchView] Dependencies are missing; running bootstrap first"
  Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "bootstrap.ps1")
}

npx tauri dev --config app/desktop/src-tauri/tauri.conf.json