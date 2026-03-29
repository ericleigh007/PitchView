$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"
Initialize-PitchViewEnvironment -RequireCargo -RequirePython

function Get-PitchViewEdgeVersion {
  $edgePaths = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($edgePath in $edgePaths) {
    if (Test-Path $edgePath) {
      return (Get-Item $edgePath).VersionInfo.ProductVersion
    }
  }

  throw "Microsoft Edge is required for Tauri WebDriver automation on Windows."
}

function Ensure-PitchViewEdgeDriver {
  $edgeVersion = Get-PitchViewEdgeVersion
  $driverRoot = Join-Path (Get-PitchViewRepoRoot) ".tmp/gui-e2e/msedgedriver"
  $driverTool = Join-Path $HOME ".cargo\bin\msedgedriver-tool.exe"
  $existingDriver = Get-ChildItem -Path $driverRoot -Recurse -Filter "msedgedriver.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

  if ($existingDriver) {
    return $existingDriver.FullName
  }

  Remove-Item $driverRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $driverRoot -Force | Out-Null

  if (-not (Test-Path $driverTool)) {
    Write-Host "[PitchView] Installing msedgedriver-tool"
    cargo install --git https://github.com/chippers/msedgedriver-tool --locked
  }

  Write-Host "[PitchView] Downloading Edge WebDriver $edgeVersion via msedgedriver-tool"
  & $driverTool --output-dir $driverRoot

  $downloadedDriver = Get-ChildItem -Path $driverRoot -Recurse -Filter "msedgedriver.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

  if (-not $downloadedDriver) {
    throw "Edge WebDriver download did not produce msedgedriver.exe under $driverRoot"
  }

  return $downloadedDriver.FullName
}

$driverPath = Join-Path $HOME ".cargo\bin\tauri-driver.exe"
if (-not (Test-Path $driverPath)) {
  Write-Host "[PitchView] Installing tauri-driver"
  cargo install tauri-driver --locked
}

$env:PITCHVIEW_E2E_NATIVE_DRIVER = Ensure-PitchViewEdgeDriver

Write-Host "[PitchView] Building desktop app for GUI automation"
Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "build.ps1")

Write-Host "[PitchView] Running desktop GUI automation"
npm exec wdio run e2e/wdio.conf.mjs
