import fs from 'node:fs';
import path from 'node:path';

import wav from 'node-wav';

import { analyzePitchSamples } from '../src/lib/pitchAnalysis';
import { buildPitchSegments } from '../src/lib/pitchDisplay';
import { scanRenderedOctaveGlitches } from '../src/lib/pitchViewportDiagnostics';

type CliOptions = {
  filePath: string;
  timeScaleSec: number;
  pitchRangeSemitones: number;
};

const DEFAULT_FILE_PATH = path.resolve(
  'sample/out/imported/the-carpenters---close-to-you-1970-remastered-hd-npqrsxrduc8/The Carpenters - Close To You (1970) (Remastered HD) [NpQRsXrduc8]_(vocals)_vocals_mel_band_roformer.wav',
);

const parseArgs = (argv: string[]): CliOptions => {
  let filePath = DEFAULT_FILE_PATH;
  let timeScaleSec = 0.1;
  let pitchRangeSemitones = 18;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--time-scale' && argv[index + 1]) {
      timeScaleSec = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (value === '--pitch-range' && argv[index + 1]) {
      pitchRangeSemitones = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (!value.startsWith('--')) {
      filePath = path.resolve(value);
    }
  }

  return {
    filePath,
    timeScaleSec,
    pitchRangeSemitones,
  };
};

const mixToMono = (channels: Float32Array[]) => {
  if (channels.length === 0) {
    return new Float32Array();
  }

  if (channels.length === 1) {
    return channels[0];
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

const LOCAL_CONTEXT_SEC = 0.05;
const MAX_SUSPICIOUS_GAP_SEC = 0.12;
const MIN_SUSPICIOUS_INTERVAL_SEMITONES = 3;
const MAX_SUSPICIOUS_INTERVAL_SEMITONES = 8.5;

const roundValue = (value: number) => Number(value.toFixed(3));

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const buffer = fs.readFileSync(options.filePath);
  const decoded = wav.decode(buffer);
  const monoSamples = mixToMono(decoded.channelData);
  const pitchPoints = analyzePitchSamples(monoSamples, decoded.sampleRate);
  const scan = scanRenderedOctaveGlitches(pitchPoints, {
    timeScaleSec: options.timeScaleSec,
    pitchRangeSemitones: options.pitchRangeSemitones,
  });
  const enrichedRenderedJumps = scan.sweptRenderedJumps.slice(0, 40).map((jump) => {
    const midiMin = jump.midiCenter - options.pitchRangeSemitones / 2;
    const midiMax = jump.midiCenter + options.pitchRangeSemitones / 2;
    const renderedSegments = buildPitchSegments(
      pitchPoints,
      jump.rangeStart,
      jump.rangeEnd,
      midiMin,
      midiMax,
      0.14,
    );
    const renderedNeighborhood = renderedSegments
      .flat()
      .filter((point) => point.timeSec >= jump.jumpStartSec - LOCAL_CONTEXT_SEC && point.timeSec <= jump.jumpEndSec + LOCAL_CONTEXT_SEC)
      .map((point) => ({ timeSec: roundValue(point.timeSec), midi: Number(point.midi.toFixed(2)) }));
    const rawNeighborhood = pitchPoints
      .filter((point) => point.timeSec >= jump.jumpStartSec - LOCAL_CONTEXT_SEC && point.timeSec <= jump.jumpEndSec + LOCAL_CONTEXT_SEC)
      .map((point) => ({
        timeSec: roundValue(point.timeSec),
        midi: point.midi === null ? null : Number(point.midi.toFixed(2)),
        confidence: Number(point.confidence.toFixed(3)),
      }));

    return {
      ...jump,
      rawNeighborhood,
      renderedNeighborhood,
    };
  });
  const suspiciousGapKeys = new Set<string>();
  const suspiciousRenderedGaps: Array<{
    focusTimeSec: number;
    rangeStart: number;
    rangeEnd: number;
    midiCenter: number;
    gapStartSec: number;
    gapEndSec: number;
    gapDurationSec: number;
    startMidi: number;
    endMidi: number;
    intervalSemitones: number;
    rawNeighborhood: Array<{ timeSec: number; midi: number | null; confidence: number }>;
    renderedNeighborhood: Array<{ timeSec: number; midi: number }>;
  }> = [];

  for (let focusTimeSec = 0; focusTimeSec <= (pitchPoints[pitchPoints.length - 1]?.timeSec ?? 0); focusTimeSec += 0.01) {
    const rangeStart = Math.max(0, focusTimeSec - options.timeScaleSec / 2);
    const rangeEnd = rangeStart + options.timeScaleSec;
    const nearbyMidis = pitchPoints
      .filter((point) => point.midi !== null && point.confidence >= 0.14 && Math.abs(point.timeSec - focusTimeSec) <= Math.max(1, options.timeScaleSec * 0.7))
      .map((point) => point.midi as number)
      .sort((left, right) => left - right);
    const midiCenter =
      nearbyMidis.length === 0
        ? 60
        : Math.round(
            Math.min(
              84,
              Math.max(
                36,
                nearbyMidis.length % 2 === 0
                  ? (nearbyMidis[nearbyMidis.length / 2 - 1] + nearbyMidis[nearbyMidis.length / 2]) / 2
                  : nearbyMidis[Math.floor(nearbyMidis.length / 2)],
              ),
            ),
          );
    const midiMin = midiCenter - options.pitchRangeSemitones / 2;
    const midiMax = midiCenter + options.pitchRangeSemitones / 2;
    const renderedSegments = buildPitchSegments(
      pitchPoints,
      rangeStart,
      rangeEnd,
      midiMin,
      midiMax,
      0.14,
    );

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

      const gapKey = `${currentEnd.timeSec.toFixed(3)}:${nextStart.timeSec.toFixed(3)}:${options.pitchRangeSemitones}`;
      if (suspiciousGapKeys.has(gapKey)) {
        continue;
      }
      suspiciousGapKeys.add(gapKey);

      const rawNeighborhood = pitchPoints
        .filter((point) => point.timeSec >= currentEnd.timeSec - LOCAL_CONTEXT_SEC && point.timeSec <= nextStart.timeSec + LOCAL_CONTEXT_SEC)
        .map((point) => ({
          timeSec: roundValue(point.timeSec),
          midi: point.midi === null ? null : Number(point.midi.toFixed(2)),
          confidence: Number(point.confidence.toFixed(3)),
        }));
      const renderedNeighborhood = renderedSegments
        .flat()
        .filter((point) => point.timeSec >= currentEnd.timeSec - LOCAL_CONTEXT_SEC && point.timeSec <= nextStart.timeSec + LOCAL_CONTEXT_SEC)
        .map((point) => ({ timeSec: roundValue(point.timeSec), midi: Number(point.midi.toFixed(2)) }));

      suspiciousRenderedGaps.push({
        focusTimeSec,
        rangeStart,
        rangeEnd,
        midiCenter,
        gapStartSec: currentEnd.timeSec,
        gapEndSec: nextStart.timeSec,
        gapDurationSec,
        startMidi: currentEnd.midi,
        endMidi: nextStart.midi,
        intervalSemitones,
        rawNeighborhood,
        renderedNeighborhood,
      });
    }
  }

  const report = {
    filePath: options.filePath,
    timeScaleSec: options.timeScaleSec,
    pitchRangeSemitones: options.pitchRangeSemitones,
    analyzedPitchPoints: pitchPoints.length,
    rawOctaveIslandCount: scan.rawOctaveIslands.length,
    survivingRenderedWindowCount: scan.survivingRenderedWindows.length,
    sweptRenderedJumpCount: scan.sweptRenderedJumps.length,
    suspiciousRenderedGapCount: suspiciousRenderedGaps.length,
    survivingRenderedWindows: scan.survivingRenderedWindows.slice(0, 20),
    sweptRenderedJumps: enrichedRenderedJumps,
    suspiciousRenderedGaps: suspiciousRenderedGaps.slice(0, 40),
  };

  const outputDir = path.resolve('sample/out/debug');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `display-glitch-report-${path.basename(options.filePath, path.extname(options.filePath))}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.info(JSON.stringify(report, null, 2));
  console.info(`Wrote display glitch report to ${outputPath}`);
};

main();