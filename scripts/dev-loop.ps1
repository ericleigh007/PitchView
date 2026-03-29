param(
  [switch]$SkipTests,
  [switch]$SkipBuild,
  [switch]$Launch,
  [switch]$Loop,
  [switch]$ClearLog,
  [switch]$ShowLog,
  [int]$LogLines = 60
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot/common.ps1"

function Invoke-PitchViewDevCycle {
  Initialize-PitchViewEnvironment -RequireCargo -RequirePython

  if ($ClearLog) {
    $logPath = Clear-PitchViewDiagnosticsLog
    Write-Host "[PitchView] Cleared diagnostics log at $logPath"
  }

  if (-not $SkipTests) {
    Write-Host "[PitchView] Dev loop: running tests"
    Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "test.ps1")
  }

  if (-not $SkipBuild) {
    Write-Host "[PitchView] Dev loop: running build"
    Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "build.ps1")
  }

  if ($ShowLog) {
    Show-PitchViewDiagnosticsTail -LineCount $LogLines
  }
}

do {
  Invoke-PitchViewDevCycle

  if ($Launch) {
    Write-Host "[PitchView] Dev loop: launching desktop app"
    Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "run.ps1")
  }

  if (-not $Loop) {
    break
  }

  $nextAction = Read-Host "[PitchView] Press Enter to rerun, L to launch app, T to show log tail, or Q to quit"
  switch ($nextAction.Trim().ToLowerInvariant()) {
    "q" { break }
    "l" { Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "run.ps1") }
    "t" { Show-PitchViewDiagnosticsTail -LineCount $LogLines }
    default { }
  }
} while ($true)