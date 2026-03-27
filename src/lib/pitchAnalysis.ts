import { YIN } from 'pitchfinder';
import { analyzePitchDiagnostics } from './pitchDiagnostics';
import { smoothPitchTrack } from './pitchTrackSmoothing';
import { runPitchAnalysisJob } from './tauriPreprocess';
import type { WorkerResult } from './tauriPreprocess';
import type { PitchPoint } from './types';

const CACHE_PREFIX = 'pitch-analysis:v7:';
const FRAME_SIZE = 1536;
const HOP_SIZE = 256;
const SILENCE_RMS_THRESHOLD = 0.006;
const MIN_VOCAL_CONFIDENCE = 0.14;
const MAX_FREQUENCY_HZ = 1600;
const MIN_FREQUENCY_HZ = 60;
const TARGET_FRAME_RMS = 0.18;
const MAX_FRAME_GAIN = 12;
const VOCAL_BANDPASS_LOW_HZ = 80;
const VOCAL_BANDPASS_HIGH_HZ = 1000;
const VOCAL_BANDPASS_TAPS = 81;

const frequencyToMidi = (frequency: number) => 69 + 12 * Math.log2(frequency / 440);

const sinc = (value: number) => {
  if (value === 0) {
    return 1;
  }

  return Math.sin(Math.PI * value) / (Math.PI * value);
};

const createLowPassKernel = (cutoffHz: number, sampleRate: number, tapCount: number) => {
  const normalizedCutoff = cutoffHz / sampleRate;
  const middle = (tapCount - 1) / 2;
  const kernel = new Float32Array(tapCount);
  let kernelSum = 0;

  for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
    const distance = tapIndex - middle;
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * tapIndex) / (tapCount - 1));
    const coefficient = 2 * normalizedCutoff * sinc(2 * normalizedCutoff * distance) * window;
    kernel[tapIndex] = coefficient;
    kernelSum += coefficient;
  }

  for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
    kernel[tapIndex] /= kernelSum;
  }

  return kernel;
};

const createBandPassKernel = (lowCutoffHz: number, highCutoffHz: number, sampleRate: number, tapCount: number) => {
  const lowPassHigh = createLowPassKernel(highCutoffHz, sampleRate, tapCount);
  const lowPassLow = createLowPassKernel(lowCutoffHz, sampleRate, tapCount);
  const kernel = new Float32Array(tapCount);

  for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
    kernel[tapIndex] = lowPassHigh[tapIndex] - lowPassLow[tapIndex];
  }

  return kernel;
};

const applyFirFilter = (samples: Float32Array, kernel: Float32Array) => {
  const filtered = new Float32Array(samples.length);
  const tapCount = kernel.length;

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    let accumulator = 0;

    for (let tapIndex = 0; tapIndex < tapCount; tapIndex += 1) {
      const sourceIndex = sampleIndex - tapIndex;
      if (sourceIndex < 0) {
        break;
      }

      accumulator += samples[sourceIndex] * kernel[tapIndex];
    }

    filtered[sampleIndex] = accumulator;
  }

  return filtered;
};

const compensateFirDelay = (filtered: Float32Array, groupDelaySamples: number) => {
  const aligned = new Float32Array(filtered.length);

  for (let sampleIndex = 0; sampleIndex < filtered.length; sampleIndex += 1) {
    const shiftedIndex = sampleIndex + groupDelaySamples;
    aligned[sampleIndex] = shiftedIndex < filtered.length ? filtered[shiftedIndex] : 0;
  }

  return aligned;
};

const prefilterForVocals = (samples: Float32Array, sampleRate: number) => {
  const kernel = createBandPassKernel(VOCAL_BANDPASS_LOW_HZ, VOCAL_BANDPASS_HIGH_HZ, sampleRate, VOCAL_BANDPASS_TAPS);
  const filtered = applyFirFilter(samples, kernel);
  const groupDelaySamples = (VOCAL_BANDPASS_TAPS - 1) / 2;
  return compensateFirDelay(filtered, groupDelaySamples);
};

const mixToMono = (audioBuffer: AudioBuffer) => {
  const channelCount = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  if (channelCount <= 1) {
    return audioBuffer.getChannelData(0);
  }

  const mono = new Float32Array(length);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      mono[sampleIndex] += channelData[sampleIndex];
    }
  }

  for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
    mono[sampleIndex] /= channelCount;
  }

  return mono;
};

const normalizeFrame = (frame: Float32Array, rms: number) => {
  if (rms <= 0) {
    return frame;
  }

  const gain = Math.min(MAX_FRAME_GAIN, TARGET_FRAME_RMS / rms);
  if (!Number.isFinite(gain) || gain <= 1) {
    return frame;
  }

  const normalized = new Float32Array(frame.length);
  for (let index = 0; index < frame.length; index += 1) {
    normalized[index] = Math.max(-1, Math.min(1, frame[index] * gain));
  }

  return normalized;
};

const serializePitchPoints = (pitchPoints: PitchPoint[]) => JSON.stringify(pitchPoints);

const deserializePitchPoints = (raw: string | null): PitchPoint[] | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PitchPoint[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const getCacheKey = (mediaSourceUrl: string) => `${CACHE_PREFIX}${mediaSourceUrl}`;

const getCachedPitchPoints = (mediaSourceUrl: string) => {
  if (typeof window === 'undefined') {
    return null;
  }

  return deserializePitchPoints(window.localStorage.getItem(getCacheKey(mediaSourceUrl)));
};

const setCachedPitchPoints = (mediaSourceUrl: string, pitchPoints: PitchPoint[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getCacheKey(mediaSourceUrl), serializePitchPoints(pitchPoints));
  } catch {
    // Longer analyses can exceed localStorage quota; skip caching rather than failing playback.
  }
};

export type PitchTrackQuality = {
  score: number;
  voicedRatio: number;
  continuityRatio: number;
  averageVoicedConfidence: number;
  voicedPointCount: number;
  spikeCount: number;
  shortGapCount: number;
  octaveIslandCount: number;
};

const getVoicedRunFrameCount = (pitchPoints: PitchPoint[]) => {
  let currentRunLength = 0;
  let sustainedVoicedFrames = 0;

  for (const point of pitchPoints) {
    if (point.midi !== null) {
      currentRunLength += 1;
      continue;
    }

    if (currentRunLength >= 3) {
      sustainedVoicedFrames += currentRunLength;
    }

    currentRunLength = 0;
  }

  if (currentRunLength >= 3) {
    sustainedVoicedFrames += currentRunLength;
  }

  return sustainedVoicedFrames;
};

export const evaluatePitchTrackQuality = (pitchPoints: PitchPoint[]): PitchTrackQuality => {
  if (pitchPoints.length === 0) {
    return {
      score: 0,
      voicedRatio: 0,
      continuityRatio: 0,
      averageVoicedConfidence: 0,
      voicedPointCount: 0,
      spikeCount: 0,
      shortGapCount: 0,
      octaveIslandCount: 0,
    };
  }

  const voicedPoints = pitchPoints.filter((point) => point.midi !== null);
  const voicedPointCount = voicedPoints.length;
  const voicedRatio = voicedPointCount / pitchPoints.length;
  const averageVoicedConfidence =
    voicedPointCount === 0 ? 0 : voicedPoints.reduce((sum, point) => sum + point.confidence, 0) / voicedPointCount;
  const continuityRatio = voicedPointCount === 0 ? 0 : getVoicedRunFrameCount(pitchPoints) / voicedPointCount;
  const diagnostics = analyzePitchDiagnostics(pitchPoints);
  const score = Math.max(
    0,
    Number(
      (
        voicedRatio * 100 +
        continuityRatio * 55 +
        averageVoicedConfidence * 30 -
        diagnostics.spikeCount * 0.08 -
        diagnostics.shortGapCount * 0.18 -
        diagnostics.octaveIslandCount * 1.5
      ).toFixed(2),
    ),
  );

  return {
    score,
    voicedRatio,
    continuityRatio,
    averageVoicedConfidence,
    voicedPointCount,
    spikeCount: diagnostics.spikeCount,
    shortGapCount: diagnostics.shortGapCount,
    octaveIslandCount: diagnostics.octaveIslandCount,
  };
};

export function analyzePitchSamples(channelData: Float32Array, sampleRate: number): PitchPoint[] {
  const filteredChannelData = prefilterForVocals(channelData, sampleRate);
  const detector = YIN({ sampleRate, threshold: 0.1, probabilityThreshold: 0.05 });
  const analysisSamples = filteredChannelData.length;
  const pitchPoints: PitchPoint[] = [];

  for (let offset = 0; offset + FRAME_SIZE <= analysisSamples; offset += HOP_SIZE) {
    const frame = filteredChannelData.slice(offset, offset + FRAME_SIZE);
    let energy = 0;

    for (let index = 0; index < frame.length; index += 1) {
      energy += frame[index] * frame[index];
    }

    const rms = Math.sqrt(energy / frame.length);
    const timeSec = (offset + FRAME_SIZE / 2) / sampleRate;

    if (rms < SILENCE_RMS_THRESHOLD) {
      pitchPoints.push({ timeSec, midi: null, confidence: 0 });
      continue;
    }

    const frequency = detector(normalizeFrame(frame, rms));
    if (!frequency || !Number.isFinite(frequency) || frequency < MIN_FREQUENCY_HZ || frequency > MAX_FREQUENCY_HZ) {
      pitchPoints.push({ timeSec, midi: null, confidence: 0.1 });
      continue;
    }

    const midi = frequencyToMidi(frequency);
    const normalizedConfidence = Math.min(1, Math.max(MIN_VOCAL_CONFIDENCE, rms * 12));
    pitchPoints.push({ timeSec, midi, confidence: normalizedConfidence });
  }

  return smoothPitchTrack(pitchPoints);
}

const parsePitchAnalysisResult = (result: WorkerResult & { pitchPoints?: unknown }) => {
  if (!Array.isArray(result.pitchPoints)) {
    throw new Error('Pitch analysis worker returned no pitch points.');
  }

  return result.pitchPoints.flatMap((point) => {
    if (!point || typeof point !== 'object') {
      return [];
    }

    const candidate = point as Partial<PitchPoint>;
    if (typeof candidate.timeSec !== 'number' || typeof candidate.confidence !== 'number') {
      return [];
    }

    return [
      {
        timeSec: candidate.timeSec,
        midi: typeof candidate.midi === 'number' ? candidate.midi : null,
        confidence: candidate.confidence,
      },
    ];
  });
};

export async function analyzePitchFromMediaSource(mediaSourceUrl: string, nativeSourcePath?: string | null): Promise<PitchPoint[]> {
  const cached = getCachedPitchPoints(mediaSourceUrl);
  if (cached) {
    return cached;
  }

  if (nativeSourcePath) {
    try {
      const backendResult = await runPitchAnalysisJob({ source: nativeSourcePath, detectorId: 'librosa-pyin' });
      const pitchPoints = smoothPitchTrack(parsePitchAnalysisResult(backendResult));
      setCachedPitchPoints(mediaSourceUrl, pitchPoints);
      return pitchPoints;
    } catch {
      // Fall back to browser-side analysis when the desktop worker or detector is unavailable.
    }
  }

  const response = await fetch(mediaSourceUrl);
  const mediaBuffer = await response.arrayBuffer();
  const audioContext = new OfflineAudioContext(1, 1, 44100);

  try {
    const audioBuffer = await audioContext.decodeAudioData(mediaBuffer.slice(0));
    const sampleRate = audioBuffer.sampleRate;
    const channelData = mixToMono(audioBuffer);
    const pitchPoints = analyzePitchSamples(channelData, sampleRate);

    setCachedPitchPoints(mediaSourceUrl, pitchPoints);
    return pitchPoints;
  } finally {
    // OfflineAudioContext instances are reclaimed after decode/analysis in the browser.
  }
}