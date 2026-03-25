import type { PitchPoint } from './types';

const MAX_BRIDGE_GAP_SEC = 0.05;
const SPIKE_NEIGHBOR_GAP_SEC = 0.05;
const SPIKE_DELTA_SEMITONES = 4;

type SegmentPoint = {
  timeSec: number;
  midi: number;
};

type PreparedPoint = SegmentPoint | null;

const isPointVisible = (point: PitchPoint, midiMin: number, midiMax: number, minConfidence: number) => {
  return point.midi !== null && point.midi >= midiMin && point.midi <= midiMax && point.confidence >= minConfidence;
};

const suppressDisplaySpikes = (points: PreparedPoint[]) => {
  if (points.length < 3) {
    return points;
  }

  const filtered = [...points];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];

    if (!previous || !current || !next) {
      continue;
    }

    if (current.timeSec - previous.timeSec > SPIKE_NEIGHBOR_GAP_SEC || next.timeSec - current.timeSec > SPIKE_NEIGHBOR_GAP_SEC) {
      continue;
    }

    const previousGap = Math.abs(current.midi - previous.midi);
    const nextGap = Math.abs(current.midi - next.midi);
    const neighborGap = Math.abs(next.midi - previous.midi);

    if (previousGap >= SPIKE_DELTA_SEMITONES && nextGap >= SPIKE_DELTA_SEMITONES && neighborGap <= 1.5) {
      filtered[index] = {
        timeSec: current.timeSec,
        midi: (previous.midi + next.midi) / 2,
      };
    }
  }

  return filtered;
};

export const buildPitchSegments = (
  pitchPoints: PitchPoint[],
  rangeStart: number,
  rangeEnd: number,
  midiMin: number,
  midiMax: number,
  minConfidence: number,
) => {
  const pointsInWindow = pitchPoints.filter((point) => point.timeSec >= rangeStart && point.timeSec <= rangeEnd);
  const preparedPoints = suppressDisplaySpikes(
    pointsInWindow.map((point) =>
      isPointVisible(point, midiMin, midiMax, minConfidence)
        ? {
            timeSec: point.timeSec,
            midi: point.midi as number,
          }
        : null,
    ),
  );
  const segments: SegmentPoint[][] = [];
  let currentSegment: SegmentPoint[] = [];
  let lastAcceptedPoint: SegmentPoint | null = null;
  let pendingGapStartSec: number | null = null;

  for (let index = 0; index < pointsInWindow.length; index += 1) {
    const point = pointsInWindow[index];
    const preparedPoint = preparedPoints[index];

    if (!preparedPoint) {
      if (lastAcceptedPoint && pendingGapStartSec === null) {
        pendingGapStartSec = point.timeSec;
      }

      if (pendingGapStartSec !== null && point.timeSec - pendingGapStartSec > MAX_BRIDGE_GAP_SEC) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }

        lastAcceptedPoint = null;
        pendingGapStartSec = null;
      }

      continue;
    }

    const nextPoint = preparedPoint;

    if (!lastAcceptedPoint) {
      currentSegment = [nextPoint];
      lastAcceptedPoint = nextPoint;
      pendingGapStartSec = null;
      continue;
    }

    const bridgedGapSec = pendingGapStartSec === null ? 0 : nextPoint.timeSec - lastAcceptedPoint.timeSec;
    const gapTooLarge = pendingGapStartSec !== null && bridgedGapSec > MAX_BRIDGE_GAP_SEC;
    if (gapTooLarge) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = [nextPoint];
    } else {
      currentSegment.push(nextPoint);
    }

    lastAcceptedPoint = nextPoint;
    pendingGapStartSec = null;
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
};