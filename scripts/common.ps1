$ErrorActionPreference = "Stop"

$script:PitchViewSupportedCudaWheelTargets = @(
  [pscustomobject]@{ MinimumVersion = [version]"13.0"; RuntimeVersion = "13.0"; WheelTag = "cu130" },
  [pscustomobject]@{ MinimumVersion = [version]"12.8"; RuntimeVersion = "12.8"; WheelTag = "cu128" },
  [pscustomobject]@{ MinimumVersion = [version]"12.6"; RuntimeVersion = "12.6"; WheelTag = "cu126" }
)

function Get-PitchViewRepoRoot {
  return (Split-Path $PSScriptRoot -Parent)
}

function Get-PitchViewVenvPythonPath {
  return Join-Path (Get-PitchViewRepoRoot) ".venv/Scripts/python.exe"
}

function Get-PitchViewDesktopBinaryPath {
  return Join-Path (Get-PitchViewRepoRoot) "app/desktop/src-tauri/target/debug/pitchview-desktop.exe"
}

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

function Ensure-PitchViewTauriDriver {
  $driverPath = Join-Path $HOME ".cargo\bin\tauri-driver.exe"
  if (-not (Test-Path $driverPath)) {
    Write-Host "[PitchView] Installing tauri-driver"
    cargo install tauri-driver --locked
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to install tauri-driver."
    }
  }

  return $driverPath
}

function Find-PitchViewEdgeDriver {
  $repoRoot = Get-PitchViewRepoRoot
  $driverRoot = Join-Path $repoRoot ".tmp/gui-e2e/msedgedriver"
  $nestedDriver = Get-ChildItem -Path $driverRoot -Recurse -Filter "msedgedriver.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nestedDriver) {
    return $nestedDriver.FullName
  }

  $repoRootDriver = Join-Path $repoRoot "msedgedriver.exe"
  if (Test-Path $repoRootDriver) {
    New-Item -ItemType Directory -Path $driverRoot -Force | Out-Null
    $normalizedDriverPath = Join-Path $driverRoot "msedgedriver.exe"
    Copy-Item $repoRootDriver $normalizedDriverPath -Force
    return $normalizedDriverPath
  }

  return $null
}

function Ensure-PitchViewEdgeDriver {
  $edgeVersion = Get-PitchViewEdgeVersion
  $driverRoot = Join-Path (Get-PitchViewRepoRoot) ".tmp/gui-e2e/msedgedriver"
  $driverTool = Join-Path $HOME ".cargo\bin\msedgedriver-tool.exe"
  $existingDriver = Find-PitchViewEdgeDriver

  if ($existingDriver) {
    return $existingDriver
  }

  Remove-Item $driverRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $driverRoot -Force | Out-Null

  if (-not (Test-Path $driverTool)) {
    Write-Host "[PitchView] Installing msedgedriver-tool"
    cargo install --git https://github.com/chippers/msedgedriver-tool --locked
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to install msedgedriver-tool."
    }
  }

  Write-Host "[PitchView] Downloading Edge WebDriver $edgeVersion via msedgedriver-tool"
  & $driverTool --output-dir $driverRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Edge WebDriver download failed for Edge $edgeVersion."
  }

  $downloadedDriver = Find-PitchViewEdgeDriver
  if (-not $downloadedDriver) {
    throw "Edge WebDriver download did not produce msedgedriver.exe under $driverRoot or the repo root."
  }

  return $downloadedDriver
}

function Find-PitchViewBinary {
  param(
    [Parameter(Mandatory)]
    [string]$BinaryName
  )

  $command = Get-Command $BinaryName -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $localAppData = $env:LOCALAPPDATA
  if (-not $localAppData) {
    return $null
  }

  $packagesRoot = Join-Path $localAppData "Microsoft\WinGet\Packages"
  if (-not (Test-Path $packagesRoot)) {
    return $null
  }

  $match = Get-ChildItem -Path $packagesRoot -Filter "$BinaryName.exe" -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($match) {
    return $match.FullName
  }

  return $null
}

function Get-PitchViewFfmpegTools {
  $ffmpegPath = Find-PitchViewBinary -BinaryName "ffmpeg"
  $ffprobePath = Find-PitchViewBinary -BinaryName "ffprobe"

  return [pscustomobject]@{
    FFmpegPath = $ffmpegPath
    FFprobePath = $ffprobePath
  }
}

function Get-PitchViewCudaWheelTarget {
  $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $nvidiaSmi) {
    throw "PitchView requires an NVIDIA GPU with a supported CUDA runtime. nvidia-smi was not found."
  }

  $nvidiaSmiOutput = & $nvidiaSmi.Source 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "PitchView could not query NVIDIA GPU state with nvidia-smi."
  }

  $cudaMatch = [regex]::Match($nvidiaSmiOutput, "CUDA Version:\s*(\d+\.\d+)")
  if (-not $cudaMatch.Success) {
    throw "PitchView could not determine the CUDA runtime version from nvidia-smi output."
  }

  $cudaVersion = [version]$cudaMatch.Groups[1].Value
  foreach ($target in $script:PitchViewSupportedCudaWheelTargets) {
    if ($cudaVersion -ge $target.MinimumVersion) {
      return $target
    }
  }

  throw "PitchView requires CUDA 12.6 or newer. Detected CUDA runtime $($cudaVersion.ToString())."
}

function Install-PitchViewCudaTorchPackages {
  param(
    [Parameter(Mandatory)]
    [string]$PythonPath
  )

  $cudaTarget = Get-PitchViewCudaWheelTarget
  $indexUrl = "https://download.pytorch.org/whl/$($cudaTarget.WheelTag)"

  $probeOutput = & $PythonPath -c "import importlib.util, json; spec = importlib.util.find_spec('torch'); payload = {'installed': bool(spec)};`nif spec is not None:`n    import torch`n    payload['version'] = torch.__version__`n    payload['cuda_build'] = bool(torch.version.cuda)`n    payload['cuda_version'] = torch.version.cuda`n    payload['cuda_available'] = bool(torch.cuda.is_available())`nprint(json.dumps(payload))"
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($probeOutput)) {
    try {
      $torchInfo = $probeOutput | ConvertFrom-Json
      if ($torchInfo.installed -and $torchInfo.cuda_build -and $torchInfo.cuda_available -and $torchInfo.cuda_version -eq $cudaTarget.RuntimeVersion) {
        Write-Host "[PitchView] CUDA torch packages already match runtime $($cudaTarget.RuntimeVersion)"
        return
      }
    }
    catch {
    }
  }

  Write-Host "[PitchView] Installing CUDA-enabled torch packages from $indexUrl"
  & $PythonPath -m pip install --upgrade --force-reinstall torch torchaudio --index-url $indexUrl | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install CUDA-enabled torch packages from $indexUrl into .\.venv."
  }
}

function Resolve-PitchViewPython {
  $localVenvPython = Get-PitchViewVenvPythonPath
  if (Test-Path $localVenvPython) {
    return $localVenvPython
  }

  return $null
}

function Resolve-PitchViewBootstrapPython {
  $pyCommand = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCommand) {
    return [pscustomobject]@{
      Executable = $pyCommand.Source
      Arguments = @("-3")
    }
  }

  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if ($pythonCommand) {
    return [pscustomobject]@{
      Executable = $pythonCommand.Source
      Arguments = @()
    }
  }

  return $null
}

function Ensure-PitchViewVenv {
  $repoRoot = Get-PitchViewRepoRoot
  $venvPython = Get-PitchViewVenvPythonPath
  if (Test-Path $venvPython) {
    return $venvPython
  }

  $bootstrapPython = Resolve-PitchViewBootstrapPython
  if (-not $bootstrapPython) {
    throw "PitchView requires a repository-local .venv. Install Python 3, then run bootstrap again to create .\\.venv."
  }

  $bootstrapExecutable = $bootstrapPython.Executable
  $bootstrapArgs = @($bootstrapPython.Arguments)
  $venvPath = Join-Path $repoRoot ".venv"

  Write-Host "[PitchView] Creating repository Python environment at $venvPath"
  & $bootstrapExecutable @bootstrapArgs -m venv $venvPath | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPython)) {
    throw "Failed to create the repository Python environment at .\\.venv."
  }

  return $venvPython
}

function Install-PitchViewPythonRequirements {
  param(
    [switch]$SkipInstall
  )

  $venvPython = Ensure-PitchViewVenv
  $requirementsPath = Join-Path (Get-PitchViewRepoRoot) "requirements.txt"

  if ($SkipInstall) {
    Write-Warning "Skipping Python dependency installation. Ensure all required packages are installed into .\\.venv yourself."
    return $venvPython
  }

  if (-not (Test-Path $requirementsPath)) {
    Write-Warning "requirements.txt was not found. Install the required packages into .\\.venv manually."
    return $venvPython
  }

  Write-Host "[PitchView] Installing Python dependencies from $requirementsPath"
  & $venvPython -m pip install --upgrade pip | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upgrade pip inside .\\.venv."
  }

  Install-PitchViewCudaTorchPackages -PythonPath $venvPython

  & $venvPython -m pip install -r $requirementsPath | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install Python dependencies from requirements.txt into .\\.venv."
  }

  return $venvPython
}

function Show-PitchViewTorchBuildGuidance {
  param(
    [Parameter(Mandatory)]
    [string]$PythonPath
  )

  $probeOutput = & $PythonPath -c "import importlib.util, json; spec = importlib.util.find_spec('torch'); payload = {'installed': bool(spec)};`nif spec is not None:`n    import torch`n    payload['version'] = torch.__version__`n    payload['cuda_build'] = bool(torch.version.cuda)`n    payload['cuda_version'] = torch.version.cuda`n    payload['cuda_available'] = bool(torch.cuda.is_available())`nprint(json.dumps(payload))"
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($probeOutput)) {
    return
  }

  try {
    $torchInfo = $probeOutput | ConvertFrom-Json
  }
  catch {
    return
  }

  if (-not $torchInfo.installed) {
    return
  }

  if (-not $torchInfo.cuda_build) {
    $version = if ($torchInfo.version) { $torchInfo.version } else { "unknown" }
    throw "Installed torch build is CPU-only ($version). PitchView requires a CUDA-enabled torch build in .\.venv."
  }

  if (-not $torchInfo.cuda_available) {
    $version = if ($torchInfo.version) { $torchInfo.version } else { "unknown" }
    $cudaVersion = if ($torchInfo.cuda_version) { $torchInfo.cuda_version } else { "unknown" }
    throw "Installed torch build ($version, CUDA $cudaVersion) cannot access the GPU. PitchView requires CUDA to be available at runtime."
  }

  $version = if ($torchInfo.version) { $torchInfo.version } else { "unknown" }
  $cudaVersion = if ($torchInfo.cuda_version) { $torchInfo.cuda_version } else { "unknown" }
  Write-Host "[PitchView] Using torch build: $version (CUDA $cudaVersion)"
}

function Test-PitchViewCommand {
  param(
    [Parameter(Mandatory)]
    [string]$CommandName,

    [Parameter(Mandatory)]
    [string]$FailureMessage
  )

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw $FailureMessage
  }
}

function Initialize-PitchViewEnvironment {
  param(
    [switch]$RequireCargo,
    [switch]$RequirePython
  )

  Test-PitchViewCommand -CommandName node -FailureMessage "Node.js is required."
  Test-PitchViewCommand -CommandName npm -FailureMessage "npm is required."

  if ($RequireCargo) {
    Test-PitchViewCommand -CommandName cargo -FailureMessage "Cargo is required for the desktop host."
  }

  if ($RequirePython) {
    $pythonCommand = Resolve-PitchViewPython
    if (-not $pythonCommand) {
      throw "Python is required for preprocessing tools, but only the repository environment is supported. Create .venv at .\\.venv and install the project requirements there."
    }

    $env:PITCHVIEW_PYTHON = $pythonCommand

    $ffmpegTools = Get-PitchViewFfmpegTools
    if ($ffmpegTools.FFmpegPath) {
      $env:PITCHVIEW_FFMPEG_PATH = $ffmpegTools.FFmpegPath
    }

    if ($ffmpegTools.FFprobePath) {
      $env:PITCHVIEW_FFPROBE_PATH = $ffmpegTools.FFprobePath
    }

    Write-Host "[PitchView] Using Python: $env:PITCHVIEW_PYTHON"
  }
}

function Get-PitchViewDiagnosticsLogPath {
  return Join-Path $env:APPDATA "com.pitchview.app\pitchview.log"
}

function Clear-PitchViewDiagnosticsLog {
  $logPath = Get-PitchViewDiagnosticsLogPath
  $logDirectory = Split-Path $logPath -Parent

  if (-not (Test-Path $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  }

  Set-Content -Path $logPath -Value $null
  return $logPath
}

function Show-PitchViewDiagnosticsTail {
  param(
    [int]$LineCount = 40
  )

  $logPath = Get-PitchViewDiagnosticsLogPath
  if (-not (Test-Path $logPath)) {
    Write-Host "[PitchView] No diagnostics log found at $logPath"
    return
  }

  Write-Host "[PitchView] Diagnostics tail from $logPath"
  Get-Content $logPath -Tail $LineCount
}

function Invoke-PitchViewScript {
  param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [string[]]$Arguments = @()
  )

  & powershell -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Script failed: $ScriptPath"
  }
}