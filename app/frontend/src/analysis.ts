const TARGET_LEVEL = 0.18;
const MAX_GAIN = 6;
const PITCH_POINTS_PER_SECOND = 48;
const MIN_PITCH_POINTS = 192;
const MAX_PITCH_POINTS = 12288;
const YIN_WINDOW_SECONDS = 0.05;

export type AnalysisResult = {
  amplitudeEnvelope: number[];
  pitchContour: number[];
  pitchConfidence: number[];
  analysisNote: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rms(values: Float32Array): number {
  if (!values.length) {
    return 0;
  }

  let sum = 0;

  for (const value of values) {
    sum += value * value;
  }

  return Math.sqrt(sum / values.length);
}

function levelFrame(values: Float32Array): Float32Array {
  const frameRms = rms(values);
  const gain = frameRms > 0.0001 ? clamp(TARGET_LEVEL / frameRms, 0.35, MAX_GAIN) : 1;
  const leveled = new Float32Array(values.length);

  for (let index = 0; index < values.length; index += 1) {
    leveled[index] = clamp(values[index] * gain, -1, 1);
  }

  return leveled;
}

export function computeAmplitudeEnvelope(samples: Float32Array, bucketCount: number): number[] {
  if (!samples.length || bucketCount <= 0) {
    return [];
  }

  const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount));
  const amplitude = Array.from({ length: bucketCount }, (_, index) => {
    const start = index * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(samples[sampleIndex]));
    }

    return Number(peak.toFixed(4));
  });

  const maxValue = Math.max(...amplitude, 0.001);
  return amplitude.map((value) => Number((value / maxValue).toFixed(4)));
}

function estimatePitchHz(frame: Float32Array, sampleRate: number): { pitch: number; confidence: number } {
  const minFrequency = 80;
  const maxFrequency = 1000;
  const minLag = Math.max(2, Math.floor(sampleRate / maxFrequency));
  const maxLag = Math.min(Math.floor(sampleRate / minFrequency), frame.length - 2);
  const threshold = 0.12;

  if (rms(frame) < 0.01 || maxLag <= minLag) {
    return { pitch: 0, confidence: 0 };
  }

  const difference = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index < frame.length - lag; index += 1) {
      const delta = frame[index] - frame[index + lag];
      sum += delta * delta;
    }
    difference[lag] = sum;
  }

  const normalizedDifference = new Float32Array(maxLag + 1);
  normalizedDifference[0] = 1;
  let runningSum = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    runningSum += difference[lag];
    normalizedDifference[lag] = runningSum > 0 ? (difference[lag] * lag) / runningSum : 1;
  }

  let bestLag = 0;
  let bestValue = 1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = normalizedDifference[lag];
    if (value < threshold) {
      bestLag = lag;
      while (bestLag + 1 <= maxLag && normalizedDifference[bestLag + 1] < normalizedDifference[bestLag]) {
        bestLag += 1;
      }
      bestValue = normalizedDifference[bestLag];
      break;
    }

    if (value < bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }

  if (!bestLag) {
    return { pitch: 0, confidence: 0 };
  }

  let refinedLag = bestLag;
  if (bestLag > 1 && bestLag < maxLag) {
    const previous = normalizedDifference[bestLag - 1];
    const current = normalizedDifference[bestLag];
    const next = normalizedDifference[bestLag + 1];
    const denominator = 2 * ((2 * current) - previous - next);
    if (Math.abs(denominator) > 1e-6) {
      refinedLag = bestLag + (previous - next) / denominator;
    }
  }

  const pitch = sampleRate / refinedLag;
  const confidence = clamp(1 - bestValue, 0, 1);
  if (!Number.isFinite(pitch) || pitch < minFrequency || pitch > maxFrequency || confidence < 0.1) {
    return { pitch: 0, confidence: 0 };
  }

  return { pitch: Number(pitch.toFixed(3)), confidence: Number(confidence.toFixed(4)) };
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function deglitchPitchContour(contour: number[], confidence: number[]): number[] {
  const smoothed = [...contour];

  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const previous = smoothed[index - 1];
    const current = smoothed[index];
    const next = smoothed[index + 1];

    if (current <= 0 || previous <= 0 || next <= 0) {
      continue;
    }

    const jumpFromPrevious = Math.abs(12 * Math.log2(current / previous));
    const jumpToNext = Math.abs(12 * Math.log2(current / next));
    const surroundingJump = Math.abs(12 * Math.log2(next / previous));

    if (jumpFromPrevious > 3.5 && jumpToNext > 3.5 && surroundingJump < 1.5 && confidence[index] < 0.92) {
      smoothed[index] = Number((((previous + next) / 2)).toFixed(3));
    }
  }

  return smoothed.map((value) => Number(value.toFixed(3)));
}

export function repairPitchDropouts(contour: number[], confidence: number[]): number[] {
  const repaired = [...contour];

  for (let index = 1; index < repaired.length - 1; index += 1) {
    if (repaired[index] > 0) {
      continue;
    }

    const previous = repaired[index - 1];
    const next = repaired[index + 1];
    if (previous <= 0 || next <= 0) {
      continue;
    }

    const surroundingJump = Math.abs(12 * Math.log2(next / previous));
    if (surroundingJump < 1.5 && confidence[index] < 0.6) {
      repaired[index] = Number((((previous + next) / 2)).toFixed(3));
    }
  }

  for (let index = 1; index < repaired.length - 2; index += 1) {
    if (repaired[index] > 0 || repaired[index + 1] > 0) {
      continue;
    }

    const previous = repaired[index - 1];
    const next = repaired[index + 2];
    if (previous <= 0 || next <= 0) {
      continue;
    }

    const surroundingJump = Math.abs(12 * Math.log2(next / previous));
    if (surroundingJump < 2 && confidence[index] < 0.6 && confidence[index + 1] < 0.6) {
      const step = (next - previous) / 3;
      repaired[index] = Number((previous + step).toFixed(3));
      repaired[index + 1] = Number((previous + step * 2).toFixed(3));
    }
  }

  return repaired;
}

function choosePitchPointCount(sampleCount: number, sampleRate: number): number {
  if (sampleCount <= 0 || sampleRate <= 0) {
    return MIN_PITCH_POINTS;
  }

  const durationSeconds = sampleCount / sampleRate;
  return clamp(Math.round(durationSeconds * PITCH_POINTS_PER_SECOND), MIN_PITCH_POINTS, MAX_PITCH_POINTS);
}

export function computePitchContour(samples: Float32Array, sampleRate: number, pointCount: number): { contour: number[]; confidence: number[] } {
  if (!samples.length || pointCount <= 0) {
    return { contour: [], confidence: [] };
  }

  const windowSize = Math.min(samples.length, Math.max(1024, Math.round(sampleRate * YIN_WINDOW_SECONDS)));
  const availableSpan = Math.max(samples.length - windowSize, 0);
  const hopSize = availableSpan > 0 ? Math.max(1, Math.floor(availableSpan / Math.max(pointCount - 1, 1))) : windowSize;
  const contour: number[] = [];
  const confidence: number[] = [];

  for (let start = 0; start <= availableSpan; start += hopSize) {
    const frame = levelFrame(samples.slice(start, start + windowSize));
    const pitch = estimatePitchHz(frame, sampleRate);
    contour.push(pitch.pitch ? Number(pitch.pitch.toFixed(3)) : 0);
    confidence.push(pitch.confidence);

    if (contour.length >= pointCount) {
      break;
    }
  }

  return {
    contour: repairPitchDropouts(deglitchPitchContour(contour, confidence), confidence),
    confidence
  };
}

export async function analyzeAudioFile(file: File): Promise<AnalysisResult> {
  const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextConstructor) {
    return {
      amplitudeEnvelope: [],
      pitchContour: [],
      pitchConfidence: [],
      analysisNote: "Audio analysis is unavailable in this browser."
    };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioContext = new AudioContextConstructor();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const samples = audioBuffer.getChannelData(0);
    const leveledSamples = levelFrame(samples);
    const pitchPointCount = choosePitchPointCount(samples.length, audioBuffer.sampleRate);
    const amplitudeEnvelope = computeAmplitudeEnvelope(leveledSamples, pitchPointCount);
    const pitch = computePitchContour(samples, audioBuffer.sampleRate, pitchPointCount);
    await audioContext.close();

    return {
      amplitudeEnvelope,
      pitchContour: pitch.contour,
      pitchConfidence: pitch.confidence,
      analysisNote: "Pitch input leveled with light deglitching and short-dropout repair."
    };
  } catch {
    return {
      amplitudeEnvelope: [],
      pitchContour: [],
      pitchConfidence: [],
      analysisNote: "Imported media is playable, but browser-side analysis could not be generated."
    };
  }
}
