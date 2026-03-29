param(
  [switch]$SkipPythonDependencies
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

Write-Host "[PitchView] Bootstrapping workspace"
$venvPython = Install-PitchViewPythonRequirements -SkipInstall:$SkipPythonDependencies
Show-PitchViewTorchBuildGuidance -PythonPath $venvPython
Initialize-PitchViewEnvironment -RequireCargo -RequirePython

npm install

$ffmpegTools = Get-PitchViewFfmpegTools
if ($ffmpegTools.FFmpegPath -and $ffmpegTools.FFprobePath) {
  Write-Host "[PitchView] Using FFmpeg: $($ffmpegTools.FFmpegPath)"
  Write-Host "[PitchView] Using FFprobe: $($ffmpegTools.FFprobePath)"
}
else {
  Write-Warning "FFmpeg and ffprobe could not be resolved for PitchView. Install FFmpeg or make both binaries available from a WinGet install or PATH."
}

Write-Host "[PitchView] Bootstrap complete"
