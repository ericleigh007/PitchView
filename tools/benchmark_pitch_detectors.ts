import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import wav from 'node-wav';

import { analyzePitchSamples } from '../src/lib/pitchAnalysis';
import { analyzePitchDiagnostics } from '../src/lib/pitchDiagnostics';
import { buildPitchSegments } from '../src/lib/pitchDisplay';
import { smoothPitchTrack } from '../src/lib/pitchTrackSmoothing';
import { scanRenderedOctaveGlitches } from '../src/lib/pitchViewportDiagnostics';
import type { PitchPoint } from '../src/lib/types';

type CliOptions = {
  filePath: string;
  pythonExecutable: string;
  detectors: string[];
};

type DetectorResult = {
  detectorId: string;
  pitchPoints: PitchPoint[];
};

type SyntheticMetrics = {
  sustainedA4CentError: number | null;
  sustainedC4CentError: number | null;
  slurCoverageRatio: number;
  slurStartCentError: number | null;
  slurEndCentError: number | null;
};

type RealMetrics = {
  voicedRatio: number;
  spikeCount: number;
  shortGapCount: number;
  octaveIslandCount: number;
  survivingRenderedWindowCount: number;
  sweptRenderedJumpCount: number;
  suspiciousRenderedGapCount: number;
};

type BenchmarkEntry = {
  detectorId: string;
  synthetic: SyntheticMetrics;
  real: RealMetrics;
  syntheticScore: number;
  realScore: number;
  overallScore: number;
};

const SAMPLE_RATE = 44_100;
const DEFAULT_FILE_PATH = path.resolve(
  'sample/out/imported/the-carpenters---close-to-you-1970-remastered-hd-npqrsxrduc8/The Carpenters - Close To You (1970) (Remastered HD) [NpQRsXrduc8]_(vocals)_vocals_mel_band_roformer.wav',
);
const DEFAULT_DETECTORS = ['js-yin', 'librosa-pyin', 'librosa-pyin-continuous', 'torchcrepe-full', 'aubio-yinfft'];
const LOCAL_CONTEXT_SEC = 0.05;
const MAX_SUSPICIOUS_GAP_SEC = 0.12;
const MIN_SUSPICIOUS_INTERVAL_SEMITONES = 3;
const MAX_SUSPICIOUS_INTERVAL_SEMITONES = 8.5;

const frequencyToMidi = (frequencyHz: number) => 69 + 12 * Math.log2(frequencyHz / 440);
const centError = (measuredMidi: number, expectedMidi: number) => Math.abs(measuredMidi - expectedMidi) * 100;

const parseArgs = (argv: string[]): CliOptions => {
  let filePath = DEFAULT_FILE_PATH;
  let pythonExecutable = process.env.PITCHVIEW_PYTHON ?? 'python';
  let detectors = [...DEFAULT_DETECTORS];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--python' && argv[index + 1]) {
      pythonExecutable = argv[index + 1] as string;
      index += 1;
      continue;
    }

    if (value === '--detectors' && argv[index + 1]) {
      detectors = (argv[index + 1] as string).split(',').map((entry) => entry.trim()).filter(Boolean);
      index += 1;
      continue;
    }

    if (!value.startsWith('--')) {
      filePath = path.resolve(value);
    }
  }

  return { filePath, pythonExecutable, detectors };
};

const mixToMono = (channels: Float32Array[]) => {
  if (channels.length === 0) {
    return new Float32Array();
  }

  if (channels.length === 1) {
    return channels[0] as Float32Array;
  }

  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) {
      mono[index] += channel[index] ?? 0;
    }
  }

  for (let index = 0; index < length; index += 1) {
    mono[index] /= channels.length;
  }

  return mono;
};

const median = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const createSineSignal = (frequencyHz: number, durationSec: number, amplitude: number) => {
  const totalSamples = Math.ceil(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
    const timeSec = sampleIndex / SAMPLE_RATE;
    samples[sampleIndex] = amplitude * Math.sin(2 * Math.PI * frequencyHz * timeSec);
  }

  return samples;
};

const createGlissandoSignal = (startHz: number, endHz: number, durationSec: number, amplitude: number) => {
  const totalSamples = Math.ceil(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  const sweepRateHzPerSec = (endHz - startHz) / durationSec;

  for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
    const timeSec = sampleIndex / SAMPLE_RATE;
    const phase = 2 * Math.PI * (startHz * timeSec + 0.5 * sweepRateHzPerSec * timeSec * timeSec);
    samples[sampleIndex] = amplitude * Math.sin(phase);
  }

  return samples;
};

const writeTempWav = (samples: Float32Array) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchview-benchmark-'));
  const filePath = path.join(tempDir, 'signal.wav');
  const encoded = wav.encode([samples], { sampleRate: SAMPLE_RATE, float: true, bitDepth: 32 });
  fs.writeFileSync(filePath, encoded);
  return { tempDir, filePath };
};

const runPythonDetector = (pythonExecutable: string, detectorId: string, filePath: string): PitchPoint[] => {
  const output = childProcess.execFileSync(
    pythonExecutable,
    ['tools/preprocess_media.py', 'analyze-pitch', '--source', filePath, '--detector-id', detectorId],
    { cwd: path.resolve('.'), encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output) as { pitchPoints?: PitchPoint[] };
  return Array.isArray(parsed.pitchPoints) ? parsed.pitchPoints : [];
};

const runDetectorOnSamples = (detectorId: string, pythonExecutable: string, samples: Float32Array): DetectorResult => {
  if (detectorId === 'js-yin') {
    return { detectorId, pitchPoints: analyzePitchSamples(samples, SAMPLE_RATE) };
  }

  const temp = writeTempWav(samples);
  try {
    return {
      detectorId,
      pitchPoints: smoothPitchTrack(runPythonDetector(pythonExecutable, detectorId, temp.filePath)),
    };
  } finally {
    fs.rmSync(temp.tempDir, { recursive: true, force: true });
  }
};

const runDetectorOnFile = (detectorId: string, pythonExecutable: string, filePath: string) => {
  if (detectorId === 'js-yin') {
    const decoded = wav.decode(fs.readFileSync(filePath));
    return {
      detectorId,
      pitchPoints: analyzePitchSamples(mixToMono(decoded.channelData), decoded.sampleRate),
    };
  }

  return {
    detectorId,
    pitchPoints: smoothPitchTrack(runPythonDetector(pythonExecutable, detectorId, filePath)),
  };
};

const countSuspiciousRenderedGaps = (pitchPoints: PitchPoint[]) => {
  const suspiciousGapKeys = new Set<string>();
  let count = 0;
  const durationSec = pitchPoints[pitchPoints.length - 1]?.timeSec ?? 0;

  for (let focusTimeSec = 0; focusTimeSec <= durationSec; focusTimeSec += 0.01) {
    const rangeStart = Math.max(0, focusTimeSec - 0.1 / 2);
    const rangeEnd = rangeStart + 0.1;
    const nearbyMidis = pitchPoints
      .filter((point) => point.midi !== null && point.confidence >= 0.14 && Math.abs(point.timeSec - focusTimeSec) <= Math.max(1, 0.1 * 0.7))
      .map((point) => point.midi as number)
      .sort((left, right) => left - right);
    const midiCenter =
      nearbyMidis.length === 0
        ? 60
        : Math.round(
            nearbyMidis.length % 2 === 0
              ? (nearbyMidis[nearbyMidis.length / 2 - 1] + nearbyMidis[nearbyMidis.length / 2]) / 2
              : nearbyMidis[Math.floor(nearbyMidis.length / 2)],
          );
    const midiMin = midiCenter - 18 / 2;
    const midiMax = midiCenter + 18 / 2;
    const renderedSegments = buildPitchSegments(pitchPoints, rangeStart, rangeEnd, midiMin, midiMax, 0.14);

    for (let segmentIndex = 0; segmentIndex < renderedSegments.length - 1; segmentIndex += 1) {
      const currentSegment = renderedSegments[segmentIndex];
      const nextSegment = renderedSegments[segmentIndex + 1];
      const currentEnd = currentSegment?.[currentSegment.length - 1];
      const nextStart = nextSegment?.[0];
      if (!currentEnd || !nextStart) {
        continue;
      }

      const gapDurationSec = nextStart.timeSec - currentEnd.timeSec;
      const intervalSemitones = Math.abs(nextStart.midi - currentEnd.midi);
      if (
        gapDurationSec <= 0 ||
        gapDurationSec > MAX_SUSPICIOUS_GAP_SEC ||
        intervalSemitones < MIN_SUSPICIOUS_INTERVAL_SEMITONES ||
        intervalSemitones > MAX_SUSPICIOUS_INTERVAL_SEMITONES
      ) {
        continue;
      }

      const rawNeighborhood = pitchPoints.filter(
        (point) => point.timeSec >= currentEnd.timeSec - LOCAL_CONTEXT_SEC && point.timeSec <= nextStart.timeSec + LOCAL_CONTEXT_SEC,
      );
      const neighborhoodMidis = rawNeighborhood.flatMap((point) => (point.midi === null ? [] : [point.midi]));
      const rawSpan = neighborhoodMidis.length > 0 ? Math.max(...neighborhoodMidis) - Math.min(...neighborhoodMidis) : 0;
      const gapKey = `${currentEnd.timeSec.toFixed(3)}:${nextStart.timeSec.toFixed(3)}:18`;
      if (rawSpan > 9 || suspiciousGapKeys.has(gapKey)) {
        continue;
      }

      suspiciousGapKeys.add(gapKey);
      count += 1;
    }
  }

  return count;
};

const getSyntheticMetrics = (detectorId: string, pythonExecutable: string): SyntheticMetrics => {
  const a4Result = runDetectorOnSamples(detectorId, pythonExecutable, createSineSignal(440, 1.5, 0.6));
  const c4Result = runDetectorOnSamples(detectorId, pythonExecutable, createSineSignal(261.625565, 1.5, 0.6));
  const glissResult = runDetectorOnSamples(detectorId, pythonExecutable, createGlissandoSignal(261.625565, 349.228231, 2.0, 0.6));

  const a4ExpectedMidi = frequencyToMidi(440);
  const c4ExpectedMidi = frequencyToMidi(261.625565);
  const startExpectedMidi = frequencyToMidi(261.625565);
  const endExpectedMidi = frequencyToMidi(349.228231);
  const a4Midis = a4Result.pitchPoints.flatMap((point) => (point.midi === null ? [] : [point.midi]));
  const c4Midis = c4Result.pitchPoints.flatMap((point) => (point.midi === null ? [] : [point.midi]));
  const glissVoiced = glissResult.pitchPoints.filter((point) => point.midi !== null);
  const firstQuarter = glissVoiced.slice(0, Math.max(1, Math.floor(glissVoiced.length * 0.25))).flatMap((point) => (point.midi === null ? [] : [point.midi]));
  const lastQuarter = glissVoiced.slice(Math.max(0, Math.floor(glissVoiced.length * 0.75))).flatMap((point) => (point.midi === null ? [] : [point.midi]));

  return {
    sustainedA4CentError: a4Midis.length === 0 ? null : centError(median(a4Midis) ?? a4ExpectedMidi, a4ExpectedMidi),
    sustainedC4CentError: c4Midis.length === 0 ? null : centError(median(c4Midis) ?? c4ExpectedMidi, c4ExpectedMidi),
    slurCoverageRatio: glissResult.pitchPoints.length === 0 ? 0 : glissVoiced.length / glissResult.pitchPoints.length,
    slurStartCentError: firstQuarter.length === 0 ? null : centError(median(firstQuarter) ?? startExpectedMidi, startExpectedMidi),
    slurEndCentError: lastQuarter.length === 0 ? null : centError(median(lastQuarter) ?? endExpectedMidi, endExpectedMidi),
  };
};

const getRealMetrics = (detectorId: string, pythonExecutable: string, filePath: string): RealMetrics => {
  const result = runDetectorOnFile(detectorId, pythonExecutable, filePath);
  const diagnostics = analyzePitchDiagnostics(result.pitchPoints);
  const scan = scanRenderedOctaveGlitches(result.pitchPoints, { timeScaleSec: 0.1, pitchRangeSemitones: 18 });
  const voicedPoints = result.pitchPoints.filter((point) => point.midi !== null).length;

  return {
    voicedRatio: result.pitchPoints.length === 0 ? 0 : voicedPoints / result.pitchPoints.length,
    spikeCount: diagnostics.spikeCount,
    shortGapCount: diagnostics.shortGapCount,
    octaveIslandCount: diagnostics.octaveIslandCount,
    survivingRenderedWindowCount: scan.survivingRenderedWindows.length,
    sweptRenderedJumpCount: scan.sweptRenderedJumps.length,
    suspiciousRenderedGapCount: countSuspiciousRenderedGaps(result.pitchPoints),
  };
};

const scoreSynthetic = (metrics: SyntheticMetrics) => {
  const a4Penalty = (metrics.sustainedA4CentError ?? 100) * 0.5;
  const c4Penalty = (metrics.sustainedC4CentError ?? 100) * 0.5;
  const startPenalty = (metrics.slurStartCentError ?? 150) * 0.2;
  const endPenalty = (metrics.slurEndCentError ?? 150) * 0.2;
  const coveragePenalty = (1 - metrics.slurCoverageRatio) * 60;
  return Math.max(0, Number((100 - a4Penalty - c4Penalty - startPenalty - endPenalty - coveragePenalty).toFixed(2)));
};

const scoreReal = (metrics: RealMetrics) => {
  const voicedPenalty = (1 - metrics.voicedRatio) * 50;
  const jumpPenalty = metrics.sweptRenderedJumpCount * 15;
  const renderedWindowPenalty = metrics.survivingRenderedWindowCount * 8;
  const suspiciousGapPenalty = metrics.suspiciousRenderedGapCount * 6;
  const spikePenalty = metrics.spikeCount * 0.02;
  const shortGapPenalty = metrics.shortGapCount * 0.03;
  const octavePenalty = metrics.octaveIslandCount * 0.08;
  return Math.max(
    0,
    Number((100 - voicedPenalty - jumpPenalty - renderedWindowPenalty - suspiciousGapPenalty - spikePenalty - shortGapPenalty - octavePenalty).toFixed(2)),
  );
};

const toMarkdown = (entries: BenchmarkEntry[], options: CliOptions) => {
  const lines = [
    '# Pitch Detector Benchmark',
    '',
    `Input: ${options.filePath}`,
    `Python: ${options.pythonExecutable}`,
    '',
    '| Detector | Overall | Synthetic | Real | A4 cents | C4 cents | Slur coverage | Slur start cents | Slur end cents | Rendered jumps | Suspicious gaps |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...entries.map((entry) => [
      entry.detectorId,
      entry.overallScore.toFixed(2),
      entry.syntheticScore.toFixed(2),
      entry.realScore.toFixed(2),
      entry.synthetic.sustainedA4CentError?.toFixed(2) ?? 'n/a',
      entry.synthetic.sustainedC4CentError?.toFixed(2) ?? 'n/a',
      entry.synthetic.slurCoverageRatio.toFixed(3),
      entry.synthetic.slurStartCentError?.toFixed(2) ?? 'n/a',
      entry.synthetic.slurEndCentError?.toFixed(2) ?? 'n/a',
      entry.real.sweptRenderedJumpCount.toString(),
      entry.real.suspiciousRenderedGapCount.toString(),
    ].join(' | ')).map((line) => `| ${line} |`),
    '',
    'Scoring is heuristic and favors cent-level stability, slur continuity, and low real-stem glitch counts.',
  ];

  return lines.join('\n');
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const entries: BenchmarkEntry[] = options.detectors.map((detectorId) => {
    const synthetic = getSyntheticMetrics(detectorId, options.pythonExecutable);
    const real = getRealMetrics(detectorId, options.pythonExecutable, options.filePath);
    const syntheticScore = scoreSynthetic(synthetic);
    const realScore = scoreReal(real);
    const overallScore = Number((syntheticScore * 0.45 + realScore * 0.55).toFixed(2));
    return {
      detectorId,
      synthetic,
      real,
      syntheticScore,
      realScore,
      overallScore,
    };
  }).sort((left, right) => right.overallScore - left.overallScore);

  const report = {
    generatedAt: new Date().toISOString(),
    filePath: options.filePath,
    pythonExecutable: options.pythonExecutable,
    detectors: entries,
  };

  const outputDir = path.resolve('sample/out/debug');
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'pitch-detector-benchmark.json');
  const markdownPath = path.join(outputDir, 'pitch-detector-benchmark.md');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, toMarkdown(entries, options));

  console.info(JSON.stringify(report, null, 2));
  console.info(`Wrote detector benchmark report to ${jsonPath}`);
  console.info(`Wrote detector benchmark markdown to ${markdownPath}`);
};

main();