param(
  [string]$OutputDir = "sample/out/synthetic"
)

$ErrorActionPreference = 'Stop'

$sampleRate = 44100
$noteDurationSec = 0.75
$gapDurationSec = 0.09
$blockGapSec = 0.3
$repetitions = 3
$alternatingAmplitudes = @(0.9, 0.3, 0.1, 0.03, 0.01)
$vibratoRateHz = 5.5
$vibratoDepthSemitones = 0.6
$runNoteDurationSec = 0.28
$runGapSec = 0.0

$noteFrequencies = @{
  'C4' = 261.625565
  'D4' = 293.664768
  'E4' = 329.627557
  'F4' = 349.228231
  'G4' = 391.995436
  'A4' = 440.0
  'B4' = 493.883301
  'C5' = 523.251131
}

function Add-SilenceSamples {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double]$DurationSec
  )

  $sampleCount = [int][Math]::Round($DurationSec * $sampleRate)
  for ($index = 0; $index -lt $sampleCount; $index += 1) {
    [void]$Samples.Add(0.0)
  }
}

function Add-SineNote {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double]$FrequencyHz,
    [double]$Amplitude,
    [double]$DurationSec
  )

  $sampleCount = [int][Math]::Round($DurationSec * $sampleRate)
  for ($index = 0; $index -lt $sampleCount; $index += 1) {
    $timeSec = $index / $sampleRate
    $value = $Amplitude * [Math]::Sin(2 * [Math]::PI * $FrequencyHz * $timeSec)
    [void]$Samples.Add($value)
  }
}

function Add-VibratoNote {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double]$CenterFrequencyHz,
    [double]$Amplitude,
    [double]$DurationSec,
    [double]$RateHz,
    [double]$DepthSemitones
  )

  $sampleCount = [int][Math]::Round($DurationSec * $sampleRate)
  for ($index = 0; $index -lt $sampleCount; $index += 1) {
    $timeSec = $index / $sampleRate
    $depthOffset = $DepthSemitones * [Math]::Sin(2 * [Math]::PI * $RateHz * $timeSec)
    $instantaneousFrequencyHz = $CenterFrequencyHz * [Math]::Pow(2.0, $depthOffset / 12.0)
    $value = $Amplitude * [Math]::Sin(2 * [Math]::PI * $instantaneousFrequencyHz * $timeSec)
    [void]$Samples.Add($value)
  }
}

function Write-WavFile {
  param(
    [string]$Path,
    [double[]]$Samples
  )

  $pcm = New-Object byte[] ($Samples.Length * 2)
  for ($index = 0; $index -lt $Samples.Length; $index += 1) {
    $clamped = [Math]::Max(-1.0, [Math]::Min(1.0, $Samples[$index]))
    $intSample = [int16][Math]::Round($clamped * 32767)
    $bytes = [BitConverter]::GetBytes($intSample)
    $pcm[$index * 2] = $bytes[0]
    $pcm[$index * 2 + 1] = $bytes[1]
  }

  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  }

  $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $writer = New-Object System.IO.BinaryWriter($file)
    $subchunk2Size = $pcm.Length
    $chunkSize = 36 + $subchunk2Size
    $byteRate = $sampleRate * 2
    $blockAlign = 2
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
    $writer.Write([int]$chunkSize)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
    $writer.Write([int]16)
    $writer.Write([int16]1)
    $writer.Write([int16]1)
    $writer.Write([int]$sampleRate)
    $writer.Write([int]$byteRate)
    $writer.Write([int16]$blockAlign)
    $writer.Write([int16]16)
    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
    $writer.Write([int]$subchunk2Size)
    $writer.Write($pcm)
    $writer.Flush()
  }
  finally {
    $file.Dispose()
  }
}

function New-SampleBuffer {
  return New-Object System.Collections.Generic.List[double]
}

function Write-GeneratedFile {
  param(
    [string]$FileName,
    [System.Collections.Generic.List[double]]$Samples
  )

  $path = Join-Path $OutputDir $FileName
  Write-WavFile -Path $path -Samples $Samples.ToArray()
  $durationSec = [Math]::Round($Samples.Count / $sampleRate, 2)
  Write-Output "$path ($durationSec s)"
}

$alternatingNotes = @(
  @{ Label = 'A4'; Frequency = $noteFrequencies['A4'] },
  @{ Label = 'C4'; Frequency = $noteFrequencies['C4'] }
)

$gappedAlternating = New-SampleBuffer
foreach ($amplitude in $alternatingAmplitudes) {
  foreach ($repeat in 1..$repetitions) {
    foreach ($note in $alternatingNotes) {
      Add-SineNote -Samples $gappedAlternating -FrequencyHz $note.Frequency -Amplitude $amplitude -DurationSec $noteDurationSec
      Add-SilenceSamples -Samples $gappedAlternating -DurationSec $gapDurationSec
    }
  }

  Add-SilenceSamples -Samples $gappedAlternating -DurationSec $blockGapSec
}
Write-GeneratedFile -FileName 'synthetic_pitch_bench_A4_C4.wav' -Samples $gappedAlternating

$gaplessAlternating = New-SampleBuffer
foreach ($amplitude in $alternatingAmplitudes) {
  foreach ($repeat in 1..$repetitions) {
    foreach ($note in $alternatingNotes) {
      Add-SineNote -Samples $gaplessAlternating -FrequencyHz $note.Frequency -Amplitude $amplitude -DurationSec $noteDurationSec
    }
  }

  Add-SilenceSamples -Samples $gaplessAlternating -DurationSec $blockGapSec
}
Write-GeneratedFile -FileName 'synthetic_pitch_bench_A4_C4_gapless.wav' -Samples $gaplessAlternating

$vibratoBench = New-SampleBuffer
foreach ($amplitude in @(0.8, 0.3, 0.1)) {
  Add-VibratoNote -Samples $vibratoBench -CenterFrequencyHz $noteFrequencies['A4'] -Amplitude $amplitude -DurationSec 3.0 -RateHz $vibratoRateHz -DepthSemitones $vibratoDepthSemitones
  Add-SilenceSamples -Samples $vibratoBench -DurationSec 0.25
}
Write-GeneratedFile -FileName 'synthetic_vibrato_A4.wav' -Samples $vibratoBench

$majorScale = @('C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'B4', 'A4', 'G4', 'F4', 'E4', 'D4', 'C4')
$majorScaleBench = New-SampleBuffer
foreach ($noteName in $majorScale) {
  Add-SineNote -Samples $majorScaleBench -FrequencyHz $noteFrequencies[$noteName] -Amplitude 0.6 -DurationSec $runNoteDurationSec
  Add-SilenceSamples -Samples $majorScaleBench -DurationSec $runGapSec
}
Write-GeneratedFile -FileName 'synthetic_major_scale_C4_C5.wav' -Samples $majorScaleBench

$chromaticScale = @('C4', 'C4', 'D4', 'D4', 'E4', 'F4', 'F4', 'G4', 'G4', 'A4', 'A4', 'B4', 'C5')
$chromaticFrequencies = @(261.625565, 277.182631, 293.664768, 311.126984, 329.627557, 349.228231, 369.994423, 391.995436, 415.304698, 440.0, 466.163762, 493.883301, 523.251131)
$chromaticBench = New-SampleBuffer
for ($index = 0; $index -lt $chromaticFrequencies.Count; $index += 1) {
  Add-SineNote -Samples $chromaticBench -FrequencyHz $chromaticFrequencies[$index] -Amplitude 0.6 -DurationSec $runNoteDurationSec
  Add-SilenceSamples -Samples $chromaticBench -DurationSec $runGapSec
}
for ($index = $chromaticFrequencies.Count - 2; $index -ge 0; $index -= 1) {
  Add-SineNote -Samples $chromaticBench -FrequencyHz $chromaticFrequencies[$index] -Amplitude 0.6 -DurationSec $runNoteDurationSec
  Add-SilenceSamples -Samples $chromaticBench -DurationSec $runGapSec
}
Write-GeneratedFile -FileName 'synthetic_chromatic_run_C4_C5.wav' -Samples $chromaticBench