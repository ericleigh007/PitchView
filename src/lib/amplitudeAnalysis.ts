export type AmplitudePoint = {
  timeSec: number;
  amplitude: number;
};

const CACHE_PREFIX = 'amplitude-envelope:v1:';
const FRAME_SIZE = 2048;
const HOP_SIZE = 256;
const WINDOW_BUCKET_COUNT = 180;

const analysisPromises = new Map<string, Promise<AmplitudePoint[]>>();

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
      mono[sampleIndex] += channelData[sampleIndex] ?? 0;
    }
  }

  for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
    mono[sampleIndex] /= channelCount;
  }

  return mono;
};

const serializeAmplitudePoints = (points: AmplitudePoint[]) => JSON.stringify(points);

const deserializeAmplitudePoints = (raw: string | null): AmplitudePoint[] | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as AmplitudePoint[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const getCacheKey = (mediaSourceUrl: string) => `${CACHE_PREFIX}${mediaSourceUrl}`;

const getCachedAmplitudePoints = (mediaSourceUrl: string) => {
  if (typeof window === 'undefined') {
    return null;
  }

  return deserializeAmplitudePoints(window.localStorage.getItem(getCacheKey(mediaSourceUrl)));
};

const setCachedAmplitudePoints = (mediaSourceUrl: string, points: AmplitudePoint[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(getCacheKey(mediaSourceUrl), serializeAmplitudePoints(points));
  } catch {
    // Skip caching rather than failing amplitude analysis.
  }
};

const percentile = (values: number[], percentileRank: number) => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(percentileRank * (sorted.length - 1))));
  return sorted[position] ?? 0;
};

const normalizeAmplitudes = (points: AmplitudePoint[]) => {
  const nonZeroAmplitudes = points.flatMap((point) => (point.amplitude > 0 ? [point.amplitude] : []));
  const referenceAmplitude = percentile(nonZeroAmplitudes, 0.95);
  const scale = referenceAmplitude > 0 ? referenceAmplitude : 1;

  return points.map((point) => ({
    ...point,
    amplitude: Math.min(1, Math.sqrt(point.amplitude / scale)),
  }));
};

const computeAmplitudePoints = (samples: Float32Array, sampleRate: number) => {
  const points: AmplitudePoint[] = [];

  for (let offset = 0; offset + FRAME_SIZE <= samples.length; offset += HOP_SIZE) {
    let energy = 0;
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      const sample = samples[offset + index] ?? 0;
      energy += sample * sample;
    }

    points.push({
      timeSec: (offset + FRAME_SIZE / 2) / sampleRate,
      amplitude: Math.sqrt(energy / FRAME_SIZE),
    });
  }

  return normalizeAmplitudes(points);
};

const decodeAmplitudePoints = async (mediaSourceUrl: string) => {
  const response = await fetch(mediaSourceUrl);
  if (!response.ok) {
    throw new Error(`Amplitude fetch failed with status ${response.status}.`);
  }

  const audioContext = new AudioContext();

  try {
    const sourceBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(sourceBuffer.slice(0));
    return computeAmplitudePoints(mixToMono(audioBuffer), audioBuffer.sampleRate);
  } finally {
    await audioContext.close();
  }
};

export const analyzeAmplitudeFromMediaSource = async (mediaSourceUrl: string) => {
  const cached = getCachedAmplitudePoints(mediaSourceUrl);
  if (cached) {
    return cached;
  }

  const existingPromise = analysisPromises.get(mediaSourceUrl);
  if (existingPromise) {
    return existingPromise;
  }

  const analysisPromise = decodeAmplitudePoints(mediaSourceUrl)
    .then((points) => {
      setCachedAmplitudePoints(mediaSourceUrl, points);
      return points;
    })
    .finally(() => {
      analysisPromises.delete(mediaSourceUrl);
    });

  analysisPromises.set(mediaSourceUrl, analysisPromise);
  return analysisPromise;
};

export const buildAmplitudeWindow = (
  points: AmplitudePoint[],
  rangeStart: number,
  rangeEnd: number,
  bucketCount = WINDOW_BUCKET_COUNT,
) => {
  const safeBucketCount = Math.max(1, bucketCount);
  const rangeDuration = Math.max(0.001, rangeEnd - rangeStart);
  const bucketDuration = rangeDuration / safeBucketCount;
  const buckets = new Array<number>(safeBucketCount).fill(0);

  let pointIndex = 0;
  while (pointIndex < points.length && (points[pointIndex]?.timeSec ?? 0) < rangeStart) {
    pointIndex += 1;
  }

  for (let bucketIndex = 0; bucketIndex < safeBucketCount; bucketIndex += 1) {
    const bucketStart = rangeStart + bucketIndex * bucketDuration;
    const bucketEnd = bucketIndex === safeBucketCount - 1 ? rangeEnd + 1e-6 : bucketStart + bucketDuration;
    let bucketAmplitude = 0;
    let scanIndex = pointIndex;

    while (scanIndex < points.length) {
      const point = points[scanIndex];
      if (!point || point.timeSec >= bucketEnd) {
        break;
      }

      bucketAmplitude = Math.max(bucketAmplitude, point.amplitude);
      scanIndex += 1;
    }

    pointIndex = scanIndex;
    buckets[bucketIndex] = bucketAmplitude;
  }

  return buckets;
};