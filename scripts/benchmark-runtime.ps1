param(
  [string]$ExternalSource,
  [string]$WriteBaseline = "context/benchmarks/preprocess-runtime-baseline.json"
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"
Initialize-PitchViewEnvironment -RequirePython

$pythonCommand = $env:PITCHVIEW_PYTHON
$scriptPath = Join-Path $PSScriptRoot "benchmark_preprocess_runtime.py"

$arguments = @($scriptPath)
if ($ExternalSource) {
  $arguments += @("--external-source", $ExternalSource)
}

if ($WriteBaseline) {
  $arguments += @("--write-baseline", $WriteBaseline)
}

& $pythonCommand @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Benchmark runtime script failed."
}