import { describe, expect, it } from 'vitest';

import { analyzePitchSamples } from './pitchAnalysis';

const SAMPLE_RATE = 44_100;
const A4_HZ = 440;
const C4_HZ = 261.625565;
const A1_HZ = 55;
const A5_HZ = 880;
const DETECTOR_MIN_FREQUENCY_HZ = 60;
const NOTE_SEQUENCE = [
  { label: 'A4', frequencyHz: A4_HZ },
  { label: 'C4', frequencyHz: C4_HZ },
] as const;
const AMPLITUDES = [0.9, 0.3, 0.1, 0.03, 0.01];
const NOTE_DURATION_SEC = 0.75;
const GAP_DURATION_SEC = 0.09;
const REPETITIONS = 3;
const A3_HZ = 220;

type GlissandoCase = {
  label: string;
  startHz: number;
  endHz: number;
  durationSec: number;
  amplitude: number;
};

type HarmonicCase = {
  label: string;
  fundamentalHz: number;
  harmonicAmplitudes: number[];
  durationSec: number;
};

type FastRunCase = {
  label: string;
  frequenciesHz: number[];
  totalDurationSec: number;
  amplitude: number;
};

type StructuredTempoRunCase = {
  label: string;
  establishHz: number;
  runFrequenciesHz: number[];
  landingHz: number;
  bpm: number;
  sustainSec: number;
  subdivisionDivisor: number;
  amplitude: number;
};

type Segment = {
  label: string;
  expectedMidi: number;
  startSec: number;
  endSec: number;
};

const frequencyToMidi = (frequencyHz: number) => 69 + 12 * Math.log2(frequencyHz / 440);

const median = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

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

const createGlissandoSignal = ({ startHz, endHz, durationSec, amplitude }: GlissandoCase) => {
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

const createHarmonicSignal = ({ fundamentalHz, harmonicAmplitudes, durationSec }: HarmonicCase) => {
  const totalSamples = Math.ceil(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
    const timeSec = sampleIndex / SAMPLE_RATE;
    let value = 0;

    for (let harmonicIndex = 0; harmonicIndex < harmonicAmplitudes.length; harmonicIndex += 1) {
      const amplitude = harmonicAmplitudes[harmonicIndex] ?? 0;
      if (amplitude <= 0) {
        continue;
      }

      const harmonicNumber = harmonicIndex + 1;
      value += amplitude * Math.sin(2 * Math.PI * fundamentalHz * harmonicNumber * timeSec);
    }

    samples[sampleIndex] = Math.max(-1, Math.min(1, value));
  }

  return samples;
};

const createFrequencySequenceSignal = ({ frequenciesHz, totalDurationSec, amplitude }: FastRunCase) => {
  const totalSamples = Math.ceil(totalDurationSec * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  if (frequenciesHz.length === 0) {
    return samples;
  }

  const stepDurationSec = totalDurationSec / frequenciesHz.length;

  for (let stepIndex = 0; stepIndex < frequenciesHz.length; stepIndex += 1) {
    const startSample = Math.floor(stepIndex * stepDurationSec * SAMPLE_RATE);
    const endSample = Math.min(totalSamples, Math.floor((stepIndex + 1) * stepDurationSec * SAMPLE_RATE));
    const frequencyHz = frequenciesHz[stepIndex] ?? frequenciesHz[frequenciesHz.length - 1] ?? C4_HZ;

    for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
      const localTimeSec = (sampleIndex - startSample) / SAMPLE_RATE;
      samples[sampleIndex] = amplitude * Math.sin(2 * Math.PI * frequencyHz * localTimeSec);
    }
  }

  return samples;
};

const createPhaseContinuousFrequencySequenceSignal = (frequenciesHz: number[], totalDurationSec: number, amplitude: number) => {
  return createPhaseContinuousFrequencySequenceSignalWithPhase(frequenciesHz, totalDurationSec, amplitude, 0).samples;
};

const createPhaseContinuousFrequencySequenceSignalWithPhase = (
  frequenciesHz: number[],
  totalDurationSec: number,
  amplitude: number,
  initialPhaseRadians: number,
) => {
  const totalSamples = Math.ceil(totalDurationSec * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  if (frequenciesHz.length === 0) {
    return { samples, endPhaseRadians: initialPhaseRadians };
  }

  const stepDurationSec = totalDurationSec / frequenciesHz.length;
  let phaseRadians = initialPhaseRadians;
  let writeIndex = 0;

  for (let stepIndex = 0; stepIndex < frequenciesHz.length; stepIndex += 1) {
    const frequencyHz = frequenciesHz[stepIndex] ?? frequenciesHz[frequenciesHz.length - 1] ?? C4_HZ;
    const targetEndIndex = Math.min(totalSamples, Math.round((stepIndex + 1) * stepDurationSec * SAMPLE_RATE));

    while (writeIndex < targetEndIndex) {
      samples[writeIndex] = amplitude * Math.sin(phaseRadians);
      phaseRadians += (2 * Math.PI * frequencyHz) / SAMPLE_RATE;
      if (phaseRadians > 2 * Math.PI) {
        phaseRadians %= 2 * Math.PI;
      }
      writeIndex += 1;
    }
  }

  return { samples, endPhaseRadians: phaseRadians };
};

const createStructuredTempoRunSignal = ({
  establishHz,
  runFrequenciesHz,
  landingHz,
  bpm,
  sustainSec,
  subdivisionDivisor,
  amplitude,
}: StructuredTempoRunCase) => {
  const secondsPerQuarter = 60 / bpm;
  const secondsPerSubdivision = secondsPerQuarter / subdivisionDivisor;
  const totalDurationSec = sustainSec + runFrequenciesHz.length * secondsPerSubdivision + sustainSec;
  const establish = createPhaseContinuousFrequencySequenceSignalWithPhase([establishHz], sustainSec, amplitude, 0);
  const run = createPhaseContinuousFrequencySequenceSignalWithPhase(
    runFrequenciesHz,
    runFrequenciesHz.length * secondsPerSubdivision,
    amplitude,
    establish.endPhaseRadians,
  );
  const landing = createPhaseContinuousFrequencySequenceSignalWithPhase([landingHz], sustainSec, amplitude, run.endPhaseRadians);
  const samples = new Float32Array(establish.samples.length + run.samples.length + landing.samples.length);
  samples.set(establish.samples, 0);
  samples.set(run.samples, establish.samples.length);
  samples.set(landing.samples, establish.samples.length + run.samples.length);

  const cursorSec = sustainSec + runFrequenciesHz.length * secondsPerSubdivision;

  return {
    samples,
    establishStartSec: 0,
    establishEndSec: sustainSec,
    runStartSec: sustainSec,
    runEndSec: cursorSec,
    landingStartSec: cursorSec,
    landingEndSec: cursorSec + sustainSec,
  };
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

const GLISSANDO_CASES: GlissandoCase[] = [
  { label: 'C4-F4 1s', startHz: C4_HZ, endHz: 349.228231, durationSec: 1.0, amplitude: 0.6 },
  { label: 'C4-F4 2s', startHz: C4_HZ, endHz: 349.228231, durationSec: 2.0, amplitude: 0.6 },
  { label: 'C4-G4 1s', startHz: C4_HZ, endHz: 391.995436, durationSec: 1.0, amplitude: 0.6 },
  { label: 'C4-G4 2s', startHz: C4_HZ, endHz: 391.995436, durationSec: 2.0, amplitude: 0.6 },
  { label: 'C4-C5 100ms', startHz: C4_HZ, endHz: 523.251131, durationSec: 0.1, amplitude: 0.6 },
  { label: 'C4-C5 50ms', startHz: C4_HZ, endHz: 523.251131, durationSec: 0.05, amplitude: 0.6 },
  { label: 'C5-C4 100ms', startHz: 523.251131, endHz: C4_HZ, durationSec: 0.1, amplitude: 0.6 },
  { label: 'C5-C4 50ms', startHz: 523.251131, endHz: C4_HZ, durationSec: 0.05, amplitude: 0.6 },
];

const CHROMATIC_OCTAVE_FREQUENCIES = [261.625565, 277.182631, 293.664768, 311.126984, 329.627557, 349.228231, 369.994423, 391.995436, 415.304698, 440.0, 466.163762, 493.883301, 523.251131];
const CHROMATIC_A1_TO_A5_FREQUENCIES = Array.from({ length: 81 - 33 + 1 }, (_, index) => 440 * Math.pow(2, (33 + index - 69) / 12));

const HARMONIC_CASES: HarmonicCase[] = [
  { label: 'A3 balanced', fundamentalHz: A3_HZ, harmonicAmplitudes: [0.42, 0.24, 0.16, 0.1], durationSec: 3.0 },
  { label: 'A3 second dominant', fundamentalHz: A3_HZ, harmonicAmplitudes: [0.18, 0.52, 0.22, 0.12], durationSec: 3.0 },
  { label: 'A3 missing fundamental', fundamentalHz: A3_HZ, harmonicAmplitudes: [0, 0.54, 0.24, 0.14], durationSec: 3.0 },
];

const FAST_RUN_CASES: FastRunCase[] = [
  { label: 'C4-C5 chromatic 100ms', frequenciesHz: CHROMATIC_OCTAVE_FREQUENCIES, totalDurationSec: 0.1, amplitude: 0.6 },
  { label: 'C4-C5 chromatic 50ms', frequenciesHz: CHROMATIC_OCTAVE_FREQUENCIES, totalDurationSec: 0.05, amplitude: 0.6 },
  { label: 'C5-C4 chromatic 100ms', frequenciesHz: [...CHROMATIC_OCTAVE_FREQUENCIES].reverse(), totalDurationSec: 0.1, amplitude: 0.6 },
  { label: 'C5-C4 chromatic 50ms', frequenciesHz: [...CHROMATIC_OCTAVE_FREQUENCIES].reverse(), totalDurationSec: 0.05, amplitude: 0.6 },
];

const STRUCTURED_TEMPO_RUN_CASES: StructuredTempoRunCase[] = [
  {
    label: '144 BPM 16ths C4-C5 establish-run-land',
    establishHz: C4_HZ,
    runFrequenciesHz: CHROMATIC_OCTAVE_FREQUENCIES,
    landingHz: 523.251131,
    bpm: 144,
    sustainSec: (60 / 144) * 2,
    subdivisionDivisor: 4,
    amplitude: 0.6,
  },
  {
    label: '144 BPM 32nds A1-A5 cycles establish-run-land',
    establishHz: A1_HZ,
    runFrequenciesHz: [
      ...CHROMATIC_A1_TO_A5_FREQUENCIES,
      ...[...CHROMATIC_A1_TO_A5_FREQUENCIES].slice(0, -1).reverse(),
      ...CHROMATIC_A1_TO_A5_FREQUENCIES,
      ...[...CHROMATIC_A1_TO_A5_FREQUENCIES].slice(0, -1).reverse(),
    ],
    landingHz: A1_HZ,
    bpm: 144,
    sustainSec: (60 / 144) * 2,
    subdivisionDivisor: 8,
    amplitude: 0.6,
  },
];

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

  it('reports detector behavior on calibrated fourth and fifth glissandos', () => {
    const reportLines: string[] = [];

    for (const glissandoCase of GLISSANDO_CASES.filter((entry) => entry.durationSec >= 1.0)) {
      const samples = createGlissandoSignal(glissandoCase);
      const pitchPoints = analyzePitchSamples(samples, SAMPLE_RATE);
      const voicedMidis = pitchPoints.flatMap((point) => (point.midi === null ? [] : [point.midi]));
      const firstQuarter = voicedMidis.slice(0, Math.max(1, Math.floor(voicedMidis.length * 0.25)));
      const lastQuarter = voicedMidis.slice(Math.max(0, Math.floor(voicedMidis.length * 0.75)));
      const startMedian = median(firstQuarter);
      const endMedian = median(lastQuarter);
      const expectedDelta = frequencyToMidi(glissandoCase.endHz) - frequencyToMidi(glissandoCase.startHz);
      const measuredDelta = startMedian === null || endMedian === null ? null : endMedian - startMedian;
      const monotonicSteps = voicedMidis.slice(1).filter((midi, index) => midi >= voicedMidis[index] - 0.35).length;
      const monotonicRatio = voicedMidis.length <= 1 ? 0 : monotonicSteps / (voicedMidis.length - 1);

      reportLines.push(
        `${glissandoCase.label} voiced=${voicedMidis.length}/${pitchPoints.length} start=${startMedian?.toFixed(2) ?? 'null'} end=${endMedian?.toFixed(2) ?? 'null'} delta=${measuredDelta?.toFixed(2) ?? 'null'} expected=${expectedDelta.toFixed(2)} monotonic=${monotonicRatio.toFixed(3)}`,
      );

      expect(voicedMidis.length).toBeGreaterThan(12);
      expect(measuredDelta ?? 0).toBeGreaterThan(expectedDelta * 0.7);
    }

    console.log(['Synthetic glissando bench', ...reportLines].join('\n'));
  });

  it('reports detector behavior on harmonic stress signals', () => {
    const reportLines: string[] = [];
    const expectedFundamentalMidi = frequencyToMidi(A3_HZ);

    for (const harmonicCase of HARMONIC_CASES) {
      const samples = createHarmonicSignal(harmonicCase);
      const pitchPoints = analyzePitchSamples(samples, SAMPLE_RATE);
      const voicedMidis = pitchPoints.flatMap((point) => (point.midi === null ? [] : [point.midi]));
      const detectedMedian = median(voicedMidis);
      const dominantMidis = summarizeDetectedMidis(pitchPoints);

      reportLines.push(
        `${harmonicCase.label} voiced=${voicedMidis.length}/${pitchPoints.length} median=${detectedMedian?.toFixed(2) ?? 'null'} fundamental=${expectedFundamentalMidi.toFixed(2)} dominant=[${dominantMidis}]`,
      );

      expect(voicedMidis.length).toBeGreaterThan(12);
      if (harmonicCase.label !== 'A3 missing fundamental') {
        expect(Math.abs((detectedMedian ?? expectedFundamentalMidi) - expectedFundamentalMidi)).toBeLessThan(1.2);
      }
    }

    console.log(['Synthetic harmonic bench', ...reportLines].join('\n'));
  });

  it('reports detector behavior on ultra-fast octave glissandos and runs', () => {
    const reportLines: string[] = [];

    for (const glissandoCase of GLISSANDO_CASES.filter((entry) => entry.durationSec <= 0.1)) {
      const samples = createGlissandoSignal(glissandoCase);
      const pitchPoints = analyzePitchSamples(samples, SAMPLE_RATE);
      const voicedMidis = pitchPoints.flatMap((point) => (point.midi === null ? [] : [point.midi]));
      const firstMedian = median(voicedMidis.slice(0, Math.max(1, Math.floor(voicedMidis.length / 3))));
      const lastMedian = median(voicedMidis.slice(Math.max(0, Math.floor((voicedMidis.length * 2) / 3))));

      reportLines.push(
        `gliss ${glissandoCase.label} voiced=${voicedMidis.length}/${pitchPoints.length} first=${firstMedian?.toFixed(2) ?? 'null'} last=${lastMedian?.toFixed(2) ?? 'null'} dominant=[${summarizeDetectedMidis(pitchPoints)}]`,
      );
    }

    for (const fastRunCase of FAST_RUN_CASES) {
      const samples = createFrequencySequenceSignal(fastRunCase);
      const pitchPoints = analyzePitchSamples(samples, SAMPLE_RATE);
      const voicedMidis = pitchPoints.flatMap((point) => (point.midi === null ? [] : [point.midi]));

      reportLines.push(
        `run ${fastRunCase.label} voiced=${voicedMidis.length}/${pitchPoints.length} median=${median(voicedMidis)?.toFixed(2) ?? 'null'} dominant=[${summarizeDetectedMidis(pitchPoints)}]`,
      );
    }

    console.log(['Synthetic fast-motion bench', ...reportLines].join('\n'));
    expect(reportLines).toHaveLength(GLISSANDO_CASES.filter((entry) => entry.durationSec <= 0.1).length + FAST_RUN_CASES.length);
  });

  it('reports detector behavior on structured 144 BPM 16th-note runs with establishing notes', () => {
    const reportLines: string[] = [];

    for (const structuredCase of STRUCTURED_TEMPO_RUN_CASES) {
      const signal = createStructuredTempoRunSignal(structuredCase);
      const pitchPoints = analyzePitchSamples(signal.samples, SAMPLE_RATE);

      const establishPoints = pitchPoints.filter(
        (point) => point.timeSec >= signal.establishStartSec + 0.08 && point.timeSec <= signal.establishEndSec - 0.08,
      );
      const runPoints = pitchPoints.filter((point) => point.timeSec >= signal.runStartSec && point.timeSec <= signal.runEndSec);
      const landingPoints = pitchPoints.filter(
        (point) => point.timeSec >= signal.landingStartSec + 0.08 && point.timeSec <= signal.landingEndSec - 0.08,
      );

      const establishMatches = establishPoints.filter(
        (point) => point.midi !== null && Math.abs(point.midi - frequencyToMidi(structuredCase.establishHz)) <= 0.65,
      );
      const landingMatches = landingPoints.filter(
        (point) => point.midi !== null && Math.abs(point.midi - frequencyToMidi(structuredCase.landingHz)) <= 0.65,
      );
      const runVoiced = runPoints.filter((point) => point.midi !== null);
      const runDominantMidis = summarizeDetectedMidis(runPoints);

      reportLines.push(
        `${structuredCase.label} establish=${establishMatches.length}/${establishPoints.length} runVoiced=${runVoiced.length}/${runPoints.length} landing=${landingMatches.length}/${landingPoints.length} runDominant=[${runDominantMidis}]`,
      );

      if (structuredCase.establishHz >= DETECTOR_MIN_FREQUENCY_HZ) {
        expect(establishMatches.length).toBeGreaterThan(Math.max(2, Math.floor(establishPoints.length * 0.75)));
      }

      if (structuredCase.landingHz >= DETECTOR_MIN_FREQUENCY_HZ) {
        expect(landingMatches.length).toBeGreaterThan(Math.max(2, Math.floor(landingPoints.length * 0.75)));
      }
    }

    console.log(['Structured tempo run bench', ...reportLines].join('\n'));
  });
});