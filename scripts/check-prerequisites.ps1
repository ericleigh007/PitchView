param(
  [switch]$IncludeGuiAutomation
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot/common.ps1"

function Get-PitchViewCommandVersion {
  param(
    [Parameter(Mandatory)]
    [string]$Command,

    [string[]]$Arguments = @("--version"),

    [Parameter(Mandatory)]
    [string]$Pattern
  )

  $commandInfo = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $commandInfo) {
    return $null
  }

  $output = & $commandInfo.Source @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    return $null
  }

  $match = [regex]::Match($output, $Pattern)
  if (-not $match.Success) {
    return $null
  }

  return [pscustomobject]@{
    Path = $commandInfo.Source
    RawOutput = $output.Trim()
    Version = $match.Groups[1].Value
  }
}

function Add-PitchViewPrerequisiteResult {
  param(
    [Parameter(Mandatory)]
    [System.Collections.IList]$Results,

    [Parameter(Mandatory)]
    [string]$Name,

    [Parameter(Mandatory)]
    [string]$Scope,

    [Parameter(Mandatory)]
    [string]$Minimum,

    [Parameter(Mandatory)]
    [string]$Current,

    [Parameter(Mandatory)]
    [string]$Status,

    [Parameter(Mandatory)]
    [string]$Help,

    [bool]$Required = $true
  )

  $Results.Add([pscustomobject]@{
      Name = $Name
      Scope = $Scope
      Minimum = $Minimum
      Current = $Current
      Status = $Status
      Help = $Help
      Required = $Required
    }) | Out-Null
}

function Test-PitchViewVersionAtLeast {
  param(
    [Parameter(Mandatory)]
    [string]$Version,

    [Parameter(Mandatory)]
    [string]$MinimumVersion
  )

  try {
    return ([version]$Version -ge [version]$MinimumVersion)
  }
  catch {
    return $false
  }
}

$results = [System.Collections.Generic.List[object]]::new()

$powerShellVersion = $PSVersionTable.PSVersion
$pitchViewIsWindows = $env:OS -eq "Windows_NT"
Add-PitchViewPrerequisiteResult -Results $results -Name "Windows" -Scope "Core" -Minimum "Windows 10 or 11" -Current ($(if ($pitchViewIsWindows) { "Detected Windows" } else { "Unsupported OS" })) -Status ($(if ($pitchViewIsWindows) { "OK" } else { "Missing" })) -Help "PitchView is currently a Windows-first project." -Required $true
Add-PitchViewPrerequisiteResult -Results $results -Name "PowerShell" -Scope "Core" -Minimum "5.1+" -Current $powerShellVersion.ToString() -Status ($(if ($powerShellVersion -ge [version]"5.1") { "OK" } else { "Missing" })) -Help "Use Windows PowerShell 5.1 or newer to run the repository scripts." -Required $true

$nodeInfo = Get-PitchViewCommandVersion -Command "node" -Arguments @("--version") -Pattern "v?(\d+\.\d+\.\d+)"
if ($nodeInfo -and (Test-PitchViewVersionAtLeast -Version $nodeInfo.Version -MinimumVersion "20.19.0")) {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Node.js" -Scope "Core" -Minimum "20.19.0+" -Current $nodeInfo.Version -Status "OK" -Help "Install a Node.js release compatible with Vite 7 and jsdom 27." -Required $true
}
elseif ($nodeInfo) {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Node.js" -Scope "Core" -Minimum "20.19.0+" -Current $nodeInfo.Version -Status "Missing" -Help "Upgrade Node.js to 20.19.0 or newer. WinGet: winget install OpenJS.NodeJS.LTS" -Required $true
}
else {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Node.js" -Scope "Core" -Minimum "20.19.0+" -Current "Not found" -Status "Missing" -Help "Install Node.js 20.19.0 or newer. WinGet: winget install OpenJS.NodeJS.LTS" -Required $true
}

$npmInfo = Get-PitchViewCommandVersion -Command "npm" -Arguments @("--version") -Pattern "(\d+\.\d+\.\d+)"
Add-PitchViewPrerequisiteResult -Results $results -Name "npm" -Scope "Core" -Minimum "Bundled with supported Node.js" -Current ($(if ($npmInfo) { $npmInfo.Version } else { "Not found" })) -Status ($(if ($npmInfo) { "OK" } else { "Missing" })) -Help "npm ships with Node.js. Reinstall Node.js if npm is missing." -Required $true

$bootstrapPython = Resolve-PitchViewBootstrapPython
if ($bootstrapPython) {
  $pythonInfo = Get-PitchViewCommandVersion -Command $bootstrapPython.Executable -Arguments @($bootstrapPython.Arguments + @("--version")) -Pattern "Python\s+(\d+\.\d+\.\d+)"
  if ($pythonInfo -and (Test-PitchViewVersionAtLeast -Version $pythonInfo.Version -MinimumVersion "3.12.0")) {
    Add-PitchViewPrerequisiteResult -Results $results -Name "Python" -Scope "Core" -Minimum "3.12+" -Current $pythonInfo.Version -Status "OK" -Help "Bootstrap uses py/python to create the repository-local .venv." -Required $true
  }
  elseif ($pythonInfo) {
    Add-PitchViewPrerequisiteResult -Results $results -Name "Python" -Scope "Core" -Minimum "3.12+" -Current $pythonInfo.Version -Status "Missing" -Help "Install Python 3.12 or newer and make py or python available. WinGet: winget install Python.Python.3.12" -Required $true
  }
  else {
    Add-PitchViewPrerequisiteResult -Results $results -Name "Python" -Scope "Core" -Minimum "3.12+" -Current "Version check failed" -Status "Missing" -Help "Install Python 3.12 or newer and make py or python available. WinGet: winget install Python.Python.3.12" -Required $true
  }
}
else {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Python" -Scope "Core" -Minimum "3.12+" -Current "Not found" -Status "Missing" -Help "Install Python 3.12 or newer and make py or python available. WinGet: winget install Python.Python.3.12" -Required $true
}

$rustcInfo = Get-PitchViewCommandVersion -Command "rustc" -Arguments @("--version") -Pattern "rustc\s+(\d+\.\d+\.\d+)"
if ($rustcInfo -and (Test-PitchViewVersionAtLeast -Version $rustcInfo.Version -MinimumVersion "1.77.2")) {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Rust toolchain" -Scope "Core" -Minimum "1.77.2+ (current stable recommended)" -Current $rustcInfo.Version -Status "OK" -Help "Install Rust with rustup and keep the stable toolchain current for Tauri builds." -Required $true
}
elseif ($rustcInfo) {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Rust toolchain" -Scope "Core" -Minimum "1.77.2+ (current stable recommended)" -Current $rustcInfo.Version -Status "Missing" -Help "Upgrade Rust via rustup. WinGet: winget install Rustlang.Rustup" -Required $true
}
else {
  Add-PitchViewPrerequisiteResult -Results $results -Name "Rust toolchain" -Scope "Core" -Minimum "1.77.2+ (current stable recommended)" -Current "Not found" -Status "Missing" -Help "Install Rust via rustup. WinGet: winget install Rustlang.Rustup" -Required $true
}

$cargoInfo = Get-PitchViewCommandVersion -Command "cargo" -Arguments @("--version") -Pattern "cargo\s+(\d+\.\d+\.\d+)"
Add-PitchViewPrerequisiteResult -Results $results -Name "Cargo" -Scope "Core" -Minimum "Bundled with Rust stable" -Current ($(if ($cargoInfo) { $cargoInfo.Version } else { "Not found" })) -Status ($(if ($cargoInfo) { "OK" } else { "Missing" })) -Help "Cargo ships with Rust via rustup." -Required $true

$ffmpegTools = Get-PitchViewFfmpegTools
$ffmpegCurrent = if ($ffmpegTools.FFmpegPath -and $ffmpegTools.FFprobePath) { "ffmpeg + ffprobe found" } else { "Missing ffmpeg and/or ffprobe" }
$ffmpegStatus = if ($ffmpegTools.FFmpegPath -and $ffmpegTools.FFprobePath) { "OK" } else { "Missing" }
Add-PitchViewPrerequisiteResult -Results $results -Name "FFmpeg" -Scope "Core" -Minimum "Present in PATH or WinGet install" -Current $ffmpegCurrent -Status $ffmpegStatus -Help "Install FFmpeg so both ffmpeg and ffprobe resolve. WinGet: winget install Gyan.FFmpeg" -Required $true

$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
  $nvidiaOutput = & $nvidiaSmi.Source 2>&1 | Out-String
  $cudaMatch = [regex]::Match($nvidiaOutput, "CUDA Version:\s*(\d+\.\d+)")
  if ($LASTEXITCODE -eq 0 -and $cudaMatch.Success -and (Test-PitchViewVersionAtLeast -Version $cudaMatch.Groups[1].Value -MinimumVersion "12.6")) {
    Add-PitchViewPrerequisiteResult -Results $results -Name "NVIDIA CUDA runtime" -Scope "Core" -Minimum "CUDA 12.6+" -Current $cudaMatch.Groups[1].Value -Status "OK" -Help "PitchView currently supports the GPU preprocessing path only." -Required $true
  }
  elseif ($cudaMatch.Success) {
    Add-PitchViewPrerequisiteResult -Results $results -Name "NVIDIA CUDA runtime" -Scope "Core" -Minimum "CUDA 12.6+" -Current $cudaMatch.Groups[1].Value -Status "Missing" -Help "Install an NVIDIA driver/runtime that exposes CUDA 12.6 or newer through nvidia-smi." -Required $true
  }
  else {
    Add-PitchViewPrerequisiteResult -Results $results -Name "NVIDIA CUDA runtime" -Scope "Core" -Minimum "CUDA 12.6+" -Current "Version not detected" -Status "Missing" -Help "Install an NVIDIA driver/runtime that exposes CUDA 12.6 or newer through nvidia-smi." -Required $true
  }
}
else {
  Add-PitchViewPrerequisiteResult -Results $results -Name "NVIDIA CUDA runtime" -Scope "Core" -Minimum "CUDA 12.6+" -Current "nvidia-smi not found" -Status "Missing" -Help "Install an NVIDIA GPU driver/runtime with CUDA 12.6 or newer support." -Required $true
}

$edgePath = $null
foreach ($candidate in @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )) {
  if (Test-Path $candidate) {
    $edgePath = $candidate
    break
  }
}

$edgeCurrent = if ($edgePath) { (Get-Item $edgePath).VersionInfo.ProductVersion } else { "Not found" }
$edgeStatus = if ($edgePath) { "OK" } else { "Missing" }
Add-PitchViewPrerequisiteResult -Results $results -Name "Microsoft Edge" -Scope "GUI only" -Minimum "Current stable" -Current $edgeCurrent -Status $edgeStatus -Help "Required for npm run test:gui and npm run capture:readme-screenshots. WinGet: winget install Microsoft.Edge" -Required $false

Write-Host "[PitchView] Prerequisite check"
Write-Host
$results | Select-Object Name, Scope, Minimum, Current, Status | Format-Table -AutoSize

$missingRequired = @($results | Where-Object { $_.Required -and $_.Status -ne "OK" })
$missingOptional = @($results | Where-Object { -not $_.Required -and $_.Status -ne "OK" })

if ($missingRequired.Count -gt 0) {
  Write-Host
  Write-Warning "PitchView is missing required prerequisites."
  foreach ($item in $missingRequired) {
    Write-Host "- $($item.Name): $($item.Help)"
  }
}

if ($IncludeGuiAutomation -and $missingOptional.Count -gt 0) {
  Write-Host
  Write-Warning "GUI automation prerequisites are incomplete."
  foreach ($item in $missingOptional) {
    Write-Host "- $($item.Name): $($item.Help)"
  }
}
elseif ($missingOptional.Count -gt 0) {
  Write-Host
  Write-Host "Optional GUI prerequisites"
  foreach ($item in $missingOptional) {
    Write-Host "- $($item.Name): $($item.Help)"
  }
}

Write-Host
if ($missingRequired.Count -eq 0 -and ($missingOptional.Count -eq 0 -or -not $IncludeGuiAutomation)) {
  Write-Host "[PitchView] Prerequisites look good. Next steps:"
  Write-Host "- npm run bootstrap"
  Write-Host "- npm run run"
  exit 0
}

if ($missingRequired.Count -eq 0 -and $IncludeGuiAutomation -and $missingOptional.Count -eq 0) {
  Write-Host "[PitchView] Core and GUI prerequisites look good. Next steps:"
  Write-Host "- npm run bootstrap"
  Write-Host "- npm run test:gui"
  exit 0
}

Write-Host "[PitchView] Install the missing prerequisites above, then rerun this check."
exit 1