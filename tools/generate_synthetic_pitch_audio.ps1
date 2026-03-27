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
$tempoTestBpm = 144.0
$tempoQuarterSec = 60.0 / $tempoTestBpm
$tempoHalfSec = $tempoQuarterSec * 2.0
$tempoSixteenthSec = $tempoQuarterSec / 4.0
$tempoThirtySecondSec = $tempoQuarterSec / 8.0
$glissandoAmplitude = 0.6
$glissandoCases = @(
  @{ FileName = 'synthetic_glissando_C4_F4_1s.wav'; StartHz = 261.625565; EndHz = 349.228231; DurationSec = 1.0 },
  @{ FileName = 'synthetic_glissando_C4_F4_2s.wav'; StartHz = 261.625565; EndHz = 349.228231; DurationSec = 2.0 },
  @{ FileName = 'synthetic_glissando_C4_G4_1s.wav'; StartHz = 261.625565; EndHz = 391.995436; DurationSec = 1.0 },
  @{ FileName = 'synthetic_glissando_C4_G4_2s.wav'; StartHz = 261.625565; EndHz = 391.995436; DurationSec = 2.0 },
  @{ FileName = 'synthetic_glissando_C4_C5_100ms.wav'; StartHz = 261.625565; EndHz = 523.251131; DurationSec = 0.1 },
  @{ FileName = 'synthetic_glissando_C4_C5_50ms.wav'; StartHz = 261.625565; EndHz = 523.251131; DurationSec = 0.05 },
  @{ FileName = 'synthetic_glissando_C5_C4_100ms.wav'; StartHz = 523.251131; EndHz = 261.625565; DurationSec = 0.1 },
  @{ FileName = 'synthetic_glissando_C5_C4_50ms.wav'; StartHz = 523.251131; EndHz = 261.625565; DurationSec = 0.05 }
)

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

function Add-LinearGlissando {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double]$StartFrequencyHz,
    [double]$EndFrequencyHz,
    [double]$Amplitude,
    [double]$DurationSec
  )

  $sampleCount = [int][Math]::Round($DurationSec * $sampleRate)
  if ($sampleCount -le 0) {
    return
  }

  $sweepRateHzPerSec = ($EndFrequencyHz - $StartFrequencyHz) / $DurationSec
  for ($index = 0; $index -lt $sampleCount; $index += 1) {
    $timeSec = $index / $sampleRate
    $phase = 2 * [Math]::PI * ($StartFrequencyHz * $timeSec + 0.5 * $sweepRateHzPerSec * $timeSec * $timeSec)
    $value = $Amplitude * [Math]::Sin($phase)
    [void]$Samples.Add($value)
  }
}

function Add-HarmonicTone {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double]$FundamentalHz,
    [double[]]$HarmonicAmplitudes,
    [double]$DurationSec
  )

  $sampleCount = [int][Math]::Round($DurationSec * $sampleRate)
  for ($index = 0; $index -lt $sampleCount; $index += 1) {
    $timeSec = $index / $sampleRate
    $value = 0.0
    for ($harmonicIndex = 0; $harmonicIndex -lt $HarmonicAmplitudes.Length; $harmonicIndex += 1) {
      $partialAmplitude = $HarmonicAmplitudes[$harmonicIndex]
      if ($partialAmplitude -le 0) {
        continue
      }

      $harmonicNumber = $harmonicIndex + 1
      $value += $partialAmplitude * [Math]::Sin(2 * [Math]::PI * $FundamentalHz * $harmonicNumber * $timeSec)
    }

    [void]$Samples.Add([Math]::Max(-1.0, [Math]::Min(1.0, $value)))
  }
}

function Add-FrequencySequence {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double[]]$Frequencies,
    [double]$Amplitude,
    [double]$TotalDurationSec
  )

  if ($Frequencies.Length -eq 0 -or $TotalDurationSec -le 0) {
    return
  }

  $durationPerStepSec = $TotalDurationSec / $Frequencies.Length
  foreach ($frequencyHz in $Frequencies) {
    Add-SineNote -Samples $Samples -FrequencyHz $frequencyHz -Amplitude $Amplitude -DurationSec $durationPerStepSec
  }
}

function Add-PhaseContinuousFrequencySequence {
  param(
    [System.Collections.Generic.List[double]]$Samples,
    [double[]]$Frequencies,
    [double]$Amplitude,
    [double]$TotalDurationSec,
    [ref]$PhaseRadians
  )

  if ($Frequencies.Length -eq 0 -or $TotalDurationSec -le 0) {
    return
  }

  $durationPerStepSec = $TotalDurationSec / $Frequencies.Length
  if ($null -eq $PhaseRadians.Value) {
    $PhaseRadians.Value = 0.0
  }

  foreach ($frequencyHz in $Frequencies) {
    $sampleCount = [int][Math]::Round($durationPerStepSec * $sampleRate)
    for ($sampleIndex = 0; $sampleIndex -lt $sampleCount; $sampleIndex += 1) {
      [void]$Samples.Add($Amplitude * [Math]::Sin($PhaseRadians.Value))
      $PhaseRadians.Value += 2 * [Math]::PI * $frequencyHz / $sampleRate
      if ($PhaseRadians.Value -gt 2 * [Math]::PI) {
        $PhaseRadians.Value = $PhaseRadians.Value % (2 * [Math]::PI)
      }
    }
  }
}

function New-ChromaticFrequencies {
  param(
    [int]$StartMidi,
    [int]$EndMidi
  )

  $frequencies = New-Object System.Collections.Generic.List[double]
  for ($midi = $StartMidi; $midi -le $EndMidi; $midi += 1) {
    $frequencyHz = 440.0 * [Math]::Pow(2.0, ($midi - 69) / 12.0)
    [void]$frequencies.Add($frequencyHz)
  }

  return $frequencies.ToArray()
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

foreach ($glissandoCase in $glissandoCases) {
  $glissandoBench = New-SampleBuffer
  Add-LinearGlissando -Samples $glissandoBench -StartFrequencyHz $glissandoCase.StartHz -EndFrequencyHz $glissandoCase.EndHz -Amplitude $glissandoAmplitude -DurationSec $glissandoCase.DurationSec
  Write-GeneratedFile -FileName $glissandoCase.FileName -Samples $glissandoBench
}

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

$fastRunCases = @(
  @{ FileName = 'synthetic_fast_run_C4_C5_100ms.wav'; Frequencies = $chromaticFrequencies; TotalDurationSec = 0.1 },
  @{ FileName = 'synthetic_fast_run_C4_C5_50ms.wav'; Frequencies = $chromaticFrequencies; TotalDurationSec = 0.05 },
  @{ FileName = 'synthetic_fast_run_C5_C4_100ms.wav'; Frequencies = @($chromaticFrequencies[($chromaticFrequencies.Count - 1)..0]); TotalDurationSec = 0.1 },
  @{ FileName = 'synthetic_fast_run_C5_C4_50ms.wav'; Frequencies = @($chromaticFrequencies[($chromaticFrequencies.Count - 1)..0]); TotalDurationSec = 0.05 }
)

foreach ($fastRunCase in $fastRunCases) {
  $fastRunBench = New-SampleBuffer
  $fastRunPhase = 0.0
  Add-PhaseContinuousFrequencySequence -Samples $fastRunBench -Frequencies $fastRunCase.Frequencies -Amplitude 0.6 -TotalDurationSec $fastRunCase.TotalDurationSec -PhaseRadians ([ref]$fastRunPhase)
  Write-GeneratedFile -FileName $fastRunCase.FileName -Samples $fastRunBench
}

$structuredTempoRunBench = New-SampleBuffer
$structuredTempoRunPhase = 0.0
Add-PhaseContinuousFrequencySequence -Samples $structuredTempoRunBench -Frequencies @($noteFrequencies['C4']) -Amplitude 0.6 -TotalDurationSec $tempoHalfSec -PhaseRadians ([ref]$structuredTempoRunPhase)
Add-PhaseContinuousFrequencySequence -Samples $structuredTempoRunBench -Frequencies $chromaticFrequencies -Amplitude 0.6 -TotalDurationSec ($tempoSixteenthSec * $chromaticFrequencies.Count) -PhaseRadians ([ref]$structuredTempoRunPhase)
Add-PhaseContinuousFrequencySequence -Samples $structuredTempoRunBench -Frequencies @($noteFrequencies['C5']) -Amplitude 0.6 -TotalDurationSec $tempoHalfSec -PhaseRadians ([ref]$structuredTempoRunPhase)
Write-GeneratedFile -FileName 'synthetic_tempo_run_144bpm_16ths_C4_C5.wav' -Samples $structuredTempoRunBench

$a1ToA5ChromaticFrequencies = New-ChromaticFrequencies -StartMidi 33 -EndMidi 81
$a5ToA1ChromaticFrequencies = @($a1ToA5ChromaticFrequencies[($a1ToA5ChromaticFrequencies.Count - 2)..0])
$structuredThirtySecondRun = New-SampleBuffer
$structuredThirtySecondPhase = 0.0
Add-PhaseContinuousFrequencySequence -Samples $structuredThirtySecondRun -Frequencies @(55.0) -Amplitude 0.6 -TotalDurationSec $tempoHalfSec -PhaseRadians ([ref]$structuredThirtySecondPhase)
Add-PhaseContinuousFrequencySequence -Samples $structuredThirtySecondRun -Frequencies @($a1ToA5ChromaticFrequencies + $a5ToA1ChromaticFrequencies + $a1ToA5ChromaticFrequencies + $a5ToA1ChromaticFrequencies) -Amplitude 0.6 -TotalDurationSec ($tempoThirtySecondSec * (($a1ToA5ChromaticFrequencies.Count + $a5ToA1ChromaticFrequencies.Count) * 2)) -PhaseRadians ([ref]$structuredThirtySecondPhase)
Add-PhaseContinuousFrequencySequence -Samples $structuredThirtySecondRun -Frequencies @(55.0) -Amplitude 0.6 -TotalDurationSec $tempoHalfSec -PhaseRadians ([ref]$structuredThirtySecondPhase)
Write-GeneratedFile -FileName 'synthetic_tempo_run_144bpm_32nds_A1_A5_cycles.wav' -Samples $structuredThirtySecondRun

$harmonicCases = @(
  @{ FileName = 'synthetic_harmonics_A3_balanced.wav'; FundamentalHz = 220.0; Harmonics = @(0.42, 0.24, 0.16, 0.1); DurationSec = 3.0 },
  @{ FileName = 'synthetic_harmonics_A3_second_harmonic_dominant.wav'; FundamentalHz = 220.0; Harmonics = @(0.18, 0.52, 0.22, 0.12); DurationSec = 3.0 },
  @{ FileName = 'synthetic_harmonics_A3_missing_fundamental.wav'; FundamentalHz = 220.0; Harmonics = @(0.0, 0.54, 0.24, 0.14); DurationSec = 3.0 }
)

foreach ($harmonicCase in $harmonicCases) {
  $harmonicBench = New-SampleBuffer
  Add-HarmonicTone -Samples $harmonicBench -FundamentalHz $harmonicCase.FundamentalHz -HarmonicAmplitudes $harmonicCase.Harmonics -DurationSec $harmonicCase.DurationSec
  Write-GeneratedFile -FileName $harmonicCase.FileName -Samples $harmonicBench
}