import { describe, expect, it } from 'vitest';

import { analyzePitchSamples } from './pitchAnalysis';

const SAMPLE_RATE = 44_100;
const A4_HZ = 440;
const C4_HZ = 261.625565;
const NOTE_SEQUENCE = [
  { label: 'A4', frequencyHz: A4_HZ },
  { label: 'C4', frequencyHz: C4_HZ },
] as const;
const AMPLITUDES = [0.9, 0.3, 0.1, 0.03, 0.01];
const NOTE_DURATION_SEC = 0.75;
const GAP_DURATION_SEC = 0.09;
const REPETITIONS = 3;

type Segment = {
  label: string;
  expectedMidi: number;
  startSec: number;
  endSec: number;
};

const frequencyToMidi = (frequencyHz: number) => 69 + 12 * Math.log2(frequencyHz / 440);

const createAlternatingSignal = (amplitude: number) => {
  const totalDurationSec = REPETITIONS * NOTE_SEQUENCE.length * (NOTE_DURATION_SEC + GAP_DURATION_SEC);
  const samples = new Float32Array(Math.ceil(totalDurationSec * SAMPLE_RATE));
  const segments: Segment[] = [];
  let cursorSec = 0;

  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    for (const note of NOTE_SEQUENCE) {
      const startSample = Math.floor(cursorSec * SAMPLE_RATE);
      const noteSamples = Math.floor(NOTE_DURATION_SEC * SAMPLE_RATE);

      for (let sampleIndex = 0; sampleIndex < noteSamples; sampleIndex += 1) {
        const absoluteIndex = startSample + sampleIndex;
        const timeSec = sampleIndex / SAMPLE_RATE;
        samples[absoluteIndex] = amplitude * Math.sin(2 * Math.PI * note.frequencyHz * timeSec);
      }

      segments.push({
        label: note.label,
        expectedMidi: frequencyToMidi(note.frequencyHz),
        startSec: cursorSec,
        endSec: cursorSec + NOTE_DURATION_SEC,
      });

      cursorSec += NOTE_DURATION_SEC + GAP_DURATION_SEC;
    }
  }

  return { samples, segments };
};

const summarizeSegments = (segments: Segment[], pitchPoints: ReturnType<typeof analyzePitchSamples>) => {
  return segments.map((segment) => {
    const settledStartSec = segment.startSec + 0.05;
    const settledEndSec = segment.endSec - 0.05;
    const pointsInSegment = pitchPoints.filter(
      (point) => point.timeSec >= settledStartSec && point.timeSec <= settledEndSec,
    );
    const matchedPoints = pointsInSegment.filter(
      (point) => point.midi !== null && Math.abs(point.midi - segment.expectedMidi) <= 0.65,
    );
    const voicedRatio = pointsInSegment.length === 0 ? 0 : matchedPoints.length / pointsInSegment.length;

    let longestRun = 0;
    let currentRun = 0;
    for (const point of pointsInSegment) {
      if (point.midi !== null && Math.abs(point.midi - segment.expectedMidi) <= 0.65) {
        currentRun += 1;
        longestRun = Math.max(longestRun, currentRun);
      } else {
        currentRun = 0;
      }
    }

    return {
      label: segment.label,
      points: pointsInSegment.length,
      matched: matchedPoints.length,
      voicedRatio,
      longestRun,
    };
  });
};

const summarizeDetectedMidis = (pitchPoints: ReturnType<typeof analyzePitchSamples>) => {
  const buckets = new Map<number, number>();

  for (const point of pitchPoints) {
    if (point.midi === null) {
      continue;
    }

    const roundedMidi = Math.round(point.midi * 10) / 10;
    buckets.set(roundedMidi, (buckets.get(roundedMidi) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([midi, count]) => `${midi}:${count}`)
    .join(', ');
};

describe('analyzePitchSamples synthetic bench', () => {
  it('reports detector behavior on alternating A4 and C4 synthetic tones', () => {
    const reportLines: string[] = [];

    for (const amplitude of AMPLITUDES) {
      const { samples, segments } = createAlternatingSignal(amplitude);
      const pitchPoints = analyzePitchSamples(samples, SAMPLE_RATE);
      const summary = summarizeSegments(segments, pitchPoints);
      const averageVoicedRatio = summary.reduce((sum, item) => sum + item.voicedRatio, 0) / summary.length;
      const averageLongestRun = summary.reduce((sum, item) => sum + item.longestRun, 0) / summary.length;
      const nonNullPoints = pitchPoints.filter((point) => point.midi !== null).length;
      const dominantMidis = summarizeDetectedMidis(pitchPoints);

      reportLines.push(
        `amp=${amplitude.toFixed(2)} voiced=${nonNullPoints}/${pitchPoints.length} avgVoiced=${averageVoicedRatio.toFixed(3)} avgRun=${averageLongestRun.toFixed(1)} dominant=[${dominantMidis}] segments=${summary
          .map((item) => `${item.label}:${item.matched}/${item.points}`)
          .join(' ')}`,
      );
    }

    console.log(['Synthetic pitch bench', ...reportLines].join('\n'));
    expect(reportLines).toHaveLength(AMPLITUDES.length);
  });
});