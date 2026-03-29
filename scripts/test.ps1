param(
	[switch]$IncludeGui
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"
Initialize-PitchViewEnvironment -RequirePython

$pythonCommand = $env:PITCHVIEW_PYTHON

Write-Host "[PitchView] Running frontend tests"
npm --workspace app/frontend run test

Write-Host "[PitchView] Running demo verification"
Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "demo.ps1")

Write-Host "[PitchView] Running preprocessing smoke tests"
& $pythonCommand -m unittest discover -s tests -p "test_*.py"

if ($IncludeGui) {
	Write-Host "[PitchView] Running desktop GUI automation"
	Invoke-PitchViewScript -ScriptPath (Join-Path $PSScriptRoot "gui-test.ps1")
}

Write-Host "[PitchView] Tests complete"
