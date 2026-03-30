$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"
Initialize-PitchViewEnvironment -RequireCargo -RequirePython

Ensure-PitchViewTauriDriver | Out-Null

$env:PITCHVIEW_E2E_NATIVE_DRIVER = Ensure-PitchViewEdgeDriver
$ports = Set-PitchViewE2EDriverPorts

Write-Host "[PitchView] Building desktop app for GUI automation"
Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "build.ps1") -Arguments @("-BuildDesktopBinary")

Write-Host "[PitchView] Running desktop GUI automation"
Write-Host "[PitchView] Using WebDriver ports $($ports.DriverPort)/$($ports.NativePort)"
npm exec wdio run e2e/wdio.conf.mjs
