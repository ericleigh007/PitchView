import type { PitchPoint } from './types';

export const MAX_BRIDGE_GAP_SEC = 0.05;
const MAX_SLUR_BRIDGE_GAP_SEC = 0.08;
const MAX_SLUR_BRIDGE_INTERVAL_SEMITONES = 4.5;
const SPIKE_NEIGHBOR_GAP_SEC = 0.05;
const SPIKE_DELTA_SEMITONES = 5.5;
const SPIKE_NEIGHBOR_MAX_SEMITONES = 0.75;
const SPIKE_SUPPORT_MAX_SEMITONES = 1.5;
const OCTAVE_DELTA_SEMITONES = 12;
const OCTAVE_DELTA_TOLERANCE_SEMITONES = 1.1;
const OCTAVE_CLASS_TOLERANCE_SEMITONES = 0.6;
const MAX_OCTAVE_GLITCH_LENGTH = 5;
const MAX_OCTAVE_GLITCH_DURATION_SEC = 0.04;
const OCTAVE_CONTEXT_RADIUS = 3;
const SUPPRESSION_CONTEXT_SEC = 0.12;

export type SegmentPoint = {
  timeSec: number;
  midi: number;
};

type VisiblePreparedPoint = {
  sourceTimeSec: number;
  point: (SegmentPoint & { confidence: number }) | null;
  hiddenVoicedReason: 'out-of-range' | 'low-confidence' | null;
};

type PreparedPoint =
  | {
      timeSec: number;
      midi: number;
      confidence: number;
    }
  | null;

const prepareTrackablePoint = (point: PitchPoint): PreparedPoint => {
  if (point.midi === null) {
    return null;
  }

  return {
    timeSec: point.timeSec,
    midi: point.midi,
    confidence: point.confidence,
  };
};

const isPreparedPointVisible = (point: PreparedPoint, midiMin: number, midiMax: number, minConfidence: number) => {
  return !!point && point.confidence >= minConfidence && point.midi >= midiMin && point.midi <= midiMax;
};

const getHiddenVoicedReason = (point: PreparedPoint, midiMin: number, midiMax: number, minConfidence: number) => {
  if (!point) {
    return null;
  }

  if (point.confidence < minConfidence) {
    return 'low-confidence' as const;
  }

  if (point.midi < midiMin || point.midi > midiMax) {
    return 'out-of-range' as const;
  }

  return null;
};

const isUnresolvedOctaveStep = (left: SegmentPoint, right: SegmentPoint) => {
  return isOctaveShiftFromReference(right.midi, left.midi);
};

const getAllowedBridgeGapSec = (
  left: SegmentPoint,
  right: SegmentPoint,
  pendingGapHasHiddenVoicedPoint: boolean,
) => {
  if (pendingGapHasHiddenVoicedPoint) {
    return MAX_BRIDGE_GAP_SEC;
  }

  return Math.abs(right.midi - left.midi) <= MAX_SLUR_BRIDGE_INTERVAL_SEMITONES
    ? MAX_SLUR_BRIDGE_GAP_SEC
    : MAX_BRIDGE_GAP_SEC;
};

const getPendingGapBreakSec = (pendingGapHasHiddenVoicedPoint: boolean) => {
  return pendingGapHasHiddenVoicedPoint ? MAX_BRIDGE_GAP_SEC : MAX_SLUR_BRIDGE_GAP_SEC;
};

const wrappedSemitoneDistance = (left: number, right: number) => {
  const distance = Math.abs(left - right) % 12;
  return Math.min(distance, 12 - distance);
};

const isOctaveShiftFromReference = (candidateMidi: number, referenceMidi: number) => {
  const delta = Math.abs(candidateMidi - referenceMidi);
  return (
    Math.abs(delta - OCTAVE_DELTA_SEMITONES) <= OCTAVE_DELTA_TOLERANCE_SEMITONES &&
    wrappedSemitoneDistance(candidateMidi, referenceMidi) <= OCTAVE_CLASS_TOLERANCE_SEMITONES
  );
};

const getStableReferenceMidi = (points: PreparedPoint[], startIndex: number, endIndex: number) => {
  const contextMidis: number[] = [];

  for (let offset = 1; offset <= OCTAVE_CONTEXT_RADIUS; offset += 1) {
    const before = points[startIndex - offset];
    if (before) {
      contextMidis.push(before.midi);
    }

    const after = points[endIndex + offset];
    if (after) {
      contextMidis.push(after.midi);
    }
  }

  if (contextMidis.length < 2) {
    return null;
  }

  const sorted = [...contextMidis].sort((left, right) => left - right);
  const spread = sorted[sorted.length - 1] - sorted[0];
  if (spread > SPIKE_SUPPORT_MAX_SEMITONES) {
    return null;
  }

  const middleIndex = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
    : sorted[middleIndex];
};

const suppressShortOctaveGlitches = (points: PreparedPoint[]) => {
  if (points.length < 4) {
    return points;
  }

  const filtered = [...points];

  for (let startIndex = 1; startIndex < points.length - 1; startIndex += 1) {
    const previous = filtered[startIndex - 1];
    if (!previous) {
      continue;
    }

    let endIndex = startIndex;
    while (endIndex < filtered.length && filtered[endIndex]) {
      endIndex += 1;
    }

    const lastCandidateIndex = Math.min(endIndex - 1, startIndex + MAX_OCTAVE_GLITCH_LENGTH - 1);
    const runStartPoint = filtered[startIndex];
    if (!runStartPoint) {
      continue;
    }

    for (let candidateEndIndex = startIndex; candidateEndIndex <= lastCandidateIndex; candidateEndIndex += 1) {
      const runEndPoint = filtered[candidateEndIndex];
      if (!runEndPoint) {
        continue;
      }

      if (runEndPoint.timeSec - runStartPoint.timeSec > MAX_OCTAVE_GLITCH_DURATION_SEC) {
        break;
      }

      const referenceMidi = getStableReferenceMidi(filtered, startIndex, candidateEndIndex);
      const next = filtered[candidateEndIndex + 1];
      if (!referenceMidi && !next) {
        continue;
      }

      if (next && next.timeSec - previous.timeSec > SPIKE_NEIGHBOR_GAP_SEC * (candidateEndIndex - startIndex + 2)) {
        continue;
      }

      const fallbackReferenceMidi = next ? (previous.midi + next.midi) / 2 : previous.midi;
      const targetMidi = referenceMidi ?? fallbackReferenceMidi;
      const outerNeighborGap = next ? Math.abs(next.midi - previous.midi) : 0;
      if (referenceMidi === null && outerNeighborGap > SPIKE_SUPPORT_MAX_SEMITONES) {
        continue;
      }

      let allCandidatesLookLikeOctaveErrors = true;
      for (let index = startIndex; index <= candidateEndIndex; index += 1) {
        const candidate = filtered[index];
        if (
          !candidate ||
          !isOctaveShiftFromReference(candidate.midi, targetMidi)
        ) {
          allCandidatesLookLikeOctaveErrors = false;
          break;
        }
      }

      if (!allCandidatesLookLikeOctaveErrors) {
        continue;
      }

      const runLength = candidateEndIndex - startIndex + 1;
      for (let index = 0; index < runLength; index += 1) {
        const pointIndex = startIndex + index;
        const candidate = filtered[pointIndex];
        if (!candidate) {
          continue;
        }

        const interpolation = (index + 1) / (runLength + 1);
        filtered[pointIndex] = {
          timeSec: candidate.timeSec,
          midi: referenceMidi === null ? previous.midi + ((next?.midi ?? previous.midi) - previous.midi) * interpolation : targetMidi,
          confidence: Math.max(previous.confidence, candidate.confidence, next?.confidence ?? previous.confidence),
        };
      }

      startIndex = candidateEndIndex;
      break;
    }
  }

  return filtered;
};

const suppressDisplaySpikes = (points: PreparedPoint[]) => {
  if (points.length < 3) {
    return points;
  }

  const filtered = [...points];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previousPrevious = index > 1 ? points[index - 2] : null;
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const nextNext = index < points.length - 2 ? points[index + 2] : null;

    if (!previous || !current || !next) {
      continue;
    }

    if (current.timeSec - previous.timeSec > SPIKE_NEIGHBOR_GAP_SEC || next.timeSec - current.timeSec > SPIKE_NEIGHBOR_GAP_SEC) {
      continue;
    }

    const previousGap = Math.abs(current.midi - previous.midi);
    const nextGap = Math.abs(current.midi - next.midi);
    const neighborGap = Math.abs(next.midi - previous.midi);
    const hasPreviousSupport =
      !!previousPrevious &&
      previous.timeSec - previousPrevious.timeSec <= SPIKE_NEIGHBOR_GAP_SEC &&
      Math.abs(previousPrevious.midi - current.midi) <= SPIKE_SUPPORT_MAX_SEMITONES;
    const hasNextSupport =
      !!nextNext &&
      nextNext.timeSec - next.timeSec <= SPIKE_NEIGHBOR_GAP_SEC &&
      Math.abs(nextNext.midi - current.midi) <= SPIKE_SUPPORT_MAX_SEMITONES;

    if (
      previousGap >= SPIKE_DELTA_SEMITONES &&
      nextGap >= SPIKE_DELTA_SEMITONES &&
      neighborGap <= SPIKE_NEIGHBOR_MAX_SEMITONES &&
      !hasPreviousSupport &&
      !hasNextSupport
    ) {
      filtered[index] = {
        timeSec: current.timeSec,
        midi: (previous.midi + next.midi) / 2,
        confidence: Math.max(previous.confidence, current.confidence, next.confidence),
      };
    }
  }

  return filtered;
};

const buildProcessedVisiblePoints = (
  pitchPoints: PitchPoint[],
  rangeStart: number,
  rangeEnd: number,
  midiMin: number,
  midiMax: number,
  minConfidence: number,
): VisiblePreparedPoint[] => {
  const contextStart = Math.max(0, rangeStart - SUPPRESSION_CONTEXT_SEC);
  const contextEnd = rangeEnd + SUPPRESSION_CONTEXT_SEC;
  const pointsInContext = pitchPoints.filter((point) => point.timeSec >= contextStart && point.timeSec <= contextEnd);
  const preparedPoints = suppressDisplaySpikes(
    suppressShortOctaveGlitches(pointsInContext.map((point) => prepareTrackablePoint(point))),
  );

  return pointsInContext.flatMap((point, index) => {
    if (point.timeSec < rangeStart || point.timeSec > rangeEnd) {
      return [];
    }

    const processedPoint = preparedPoints[index];
    const preparedPoint = isPreparedPointVisible(processedPoint, midiMin, midiMax, minConfidence)
      ? processedPoint
      : null;

    return [
      {
        sourceTimeSec: point.timeSec,
        point: preparedPoint,
        hiddenVoicedReason: getHiddenVoicedReason(processedPoint, midiMin, midiMax, minConfidence),
      },
    ];
  });
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
  const visiblePoints = buildProcessedVisiblePoints(pitchPoints, rangeStart, rangeEnd, midiMin, midiMax, minConfidence);
  const segments: SegmentPoint[][] = [];
  let currentSegment: SegmentPoint[] = [];
  let lastAcceptedPoint: VisiblePreparedPoint['point'] | null = null;
  let pendingGapStartSec: number | null = null;
  let pendingGapHasHiddenVoicedPoint = false;
  const visiblePointMap = new Map(visiblePoints.map((entry) => [entry.sourceTimeSec, entry]));

  for (let index = 0; index < pointsInWindow.length; index += 1) {
    const point = pointsInWindow[index];
    const visiblePoint = visiblePointMap.get(point.timeSec) ?? null;
    const preparedPoint = visiblePoint?.point ?? null;

    if (!preparedPoint) {
      if (visiblePoint?.hiddenVoicedReason === 'out-of-range') {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
        lastAcceptedPoint = null;
        pendingGapStartSec = null;
        pendingGapHasHiddenVoicedPoint = false;
        continue;
      }

      if (lastAcceptedPoint && pendingGapStartSec === null) {
        pendingGapStartSec = point.timeSec;
      }

      if (visiblePoint?.hiddenVoicedReason === 'low-confidence') {
        pendingGapHasHiddenVoicedPoint = true;
      }

      if (
        pendingGapStartSec !== null &&
        point.timeSec - pendingGapStartSec > getPendingGapBreakSec(pendingGapHasHiddenVoicedPoint)
      ) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }

        lastAcceptedPoint = null;
        pendingGapStartSec = null;
        pendingGapHasHiddenVoicedPoint = false;
      }

      continue;
    }

    const nextPoint = preparedPoint;

    if (!lastAcceptedPoint) {
      currentSegment = [nextPoint];
      lastAcceptedPoint = nextPoint;
      pendingGapStartSec = null;
      pendingGapHasHiddenVoicedPoint = false;
      continue;
    }

    const bridgedGapSec = pendingGapStartSec === null ? 0 : nextPoint.timeSec - lastAcceptedPoint.timeSec;
    const allowedBridgeGapSec = getAllowedBridgeGapSec(lastAcceptedPoint, nextPoint, pendingGapHasHiddenVoicedPoint);
    const gapTooLarge = pendingGapStartSec !== null && bridgedGapSec > allowedBridgeGapSec;
    if (gapTooLarge) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = [nextPoint];
    } else if (isUnresolvedOctaveStep(lastAcceptedPoint, nextPoint)) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
      }
      currentSegment = [nextPoint];
    } else {
      currentSegment.push(nextPoint);
    }

    lastAcceptedPoint = nextPoint;
    pendingGapStartSec = null;
    pendingGapHasHiddenVoicedPoint = false;
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
};

export const buildVisiblePitchPoints = (
  pitchPoints: PitchPoint[],
  rangeStart: number,
  rangeEnd: number,
  midiMin: number,
  midiMax: number,
  minConfidence: number,
) => {
  return buildProcessedVisiblePoints(pitchPoints, rangeStart, rangeEnd, midiMin, midiMax, minConfidence).map((entry) => ({
    timeSec: entry.point?.timeSec ?? entry.sourceTimeSec,
    midi: entry.point?.midi ?? Number.NaN,
  })).filter((entry) => Number.isFinite(entry.midi));
};