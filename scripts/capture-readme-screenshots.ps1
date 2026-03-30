$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"
Initialize-PitchViewEnvironment -RequireCargo -RequirePython

Ensure-PitchViewTauriDriver | Out-Null

$env:PITCHVIEW_E2E_NATIVE_DRIVER = Ensure-PitchViewEdgeDriver

Write-Host "[PitchView] Building desktop app for README screenshots"
Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "build.ps1") -Arguments @("-BuildDesktopBinary")

Write-Host "[PitchView] Capturing README screenshots"
$env:PITCHVIEW_CAPTURE_README_SCREENSHOTS = "1"
npx wdio run e2e/wdio.conf.mjs --spec e2e/specs/readme-screenshots.e2e.mjs
if ($LASTEXITCODE -ne 0) {
  throw "README screenshot capture failed."
}

Write-Host "[PitchView] README screenshots written to docs/screenshots"