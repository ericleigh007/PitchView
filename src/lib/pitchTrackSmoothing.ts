import type { PitchPoint } from './types';

const MAX_NEIGHBOR_GAP_SEC = 0.05;
const SPIKE_DELTA_SEMITONES = 5.5;
const SPIKE_NEIGHBOR_MAX_SEMITONES = 0.75;
const SPIKE_SUPPORT_MAX_SEMITONES = 1.5;
const OCTAVE_DELTA_SEMITONES = 12;
const OCTAVE_DELTA_TOLERANCE_SEMITONES = 1.1;
const OCTAVE_CLASS_TOLERANCE_SEMITONES = 0.6;
const MAX_OCTAVE_GLITCH_LENGTH = 5;
const MAX_OCTAVE_GLITCH_DURATION_SEC = 0.04;
const OCTAVE_CONTEXT_RADIUS = 3;
const MAX_FILLED_GAP_SEC = 0.1;
const MAX_FILLED_GAP_INTERVAL_SEMITONES = 5.5;
const MIN_FILLED_CONFIDENCE = 0.18;
const MIN_PROMOTED_CONFIDENCE = 0.18;
const MAX_CONFIDENCE_PROMOTION_INTERVAL_SEMITONES = 5.5;

type VoicedPitchPoint = PitchPoint & { midi: number };
type PreparedPoint = VoicedPitchPoint | null;

const isVoiced = (point: PitchPoint | PreparedPoint): point is VoicedPitchPoint => point !== null && point.midi !== null;

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

const suppressShortOctaveGlitches = (pitchPoints: PitchPoint[]) => {
  const preparedPoints = pitchPoints.map((point) => (isVoiced(point) ? { ...point } : null));
  if (preparedPoints.length < 4) {
    return pitchPoints;
  }

  const filtered = [...preparedPoints];

  for (let startIndex = 1; startIndex < filtered.length - 1; startIndex += 1) {
    const previous = filtered[startIndex - 1];
    if (!previous) {
      continue;
    }

    let endIndex = startIndex;
    while (endIndex < filtered.length && filtered[endIndex]) {
      endIndex += 1;
    }

    const runStartPoint = filtered[startIndex];
    if (!runStartPoint) {
      continue;
    }

    const lastCandidateIndex = Math.min(endIndex - 1, startIndex + MAX_OCTAVE_GLITCH_LENGTH - 1);

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

      if (next && next.timeSec - previous.timeSec > MAX_NEIGHBOR_GAP_SEC * (candidateEndIndex - startIndex + 2)) {
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
        if (!candidate || !isOctaveShiftFromReference(candidate.midi, targetMidi)) {
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
          ...candidate,
          midi: referenceMidi === null
            ? previous.midi + ((next?.midi ?? previous.midi) - previous.midi) * interpolation
            : targetMidi,
          confidence: Math.max(previous.confidence, candidate.confidence, next?.confidence ?? previous.confidence),
        };
      }

      startIndex = candidateEndIndex;
      break;
    }
  }

  return pitchPoints.map((point, index) => {
    const filteredPoint = filtered[index];
    return filteredPoint ? filteredPoint : point;
  });
};

const suppressDisplaySpikes = (pitchPoints: PitchPoint[]) => {
  if (pitchPoints.length < 3) {
    return pitchPoints;
  }

  const filtered = pitchPoints.map((point) => ({ ...point }));

  for (let index = 1; index < pitchPoints.length - 1; index += 1) {
    const previousPrevious = index > 1 ? filtered[index - 2] : null;
    const previous = filtered[index - 1];
    const current = filtered[index];
    const next = filtered[index + 1];
    const nextNext = index < pitchPoints.length - 2 ? filtered[index + 2] : null;

    if (!isVoiced(previous) || !isVoiced(current) || !isVoiced(next)) {
      continue;
    }

    if (current.timeSec - previous.timeSec > MAX_NEIGHBOR_GAP_SEC || next.timeSec - current.timeSec > MAX_NEIGHBOR_GAP_SEC) {
      continue;
    }

    const previousGap = Math.abs(current.midi - previous.midi);
    const nextGap = Math.abs(current.midi - next.midi);
    const neighborGap = Math.abs(next.midi - previous.midi);
    const hasPreviousSupport =
      isVoiced(previousPrevious) &&
      previous.timeSec - previousPrevious.timeSec <= MAX_NEIGHBOR_GAP_SEC &&
      Math.abs(previousPrevious.midi - current.midi) <= SPIKE_SUPPORT_MAX_SEMITONES;
    const hasNextSupport =
      isVoiced(nextNext) &&
      nextNext.timeSec - next.timeSec <= MAX_NEIGHBOR_GAP_SEC &&
      Math.abs(nextNext.midi - current.midi) <= SPIKE_SUPPORT_MAX_SEMITONES;

    if (
      previousGap >= SPIKE_DELTA_SEMITONES &&
      nextGap >= SPIKE_DELTA_SEMITONES &&
      neighborGap <= SPIKE_NEIGHBOR_MAX_SEMITONES &&
      !hasPreviousSupport &&
      !hasNextSupport
    ) {
      filtered[index] = {
        ...current,
        midi: (previous.midi + next.midi) / 2,
        confidence: Math.max(previous.confidence, current.confidence, next.confidence),
      };
    }
  }

  return filtered;
};

const promoteWeakVoicedConfidence = (pitchPoints: PitchPoint[]) => {
  if (pitchPoints.length < 3) {
    return pitchPoints;
  }

  const promoted = pitchPoints.map((point) => ({ ...point }));

  for (let index = 1; index < promoted.length - 1; index += 1) {
    const previous = promoted[index - 1];
    const current = promoted[index];
    const next = promoted[index + 1];

    if (!isVoiced(previous) || !isVoiced(current) || !isVoiced(next)) {
      continue;
    }

    if (current.confidence >= MIN_PROMOTED_CONFIDENCE) {
      continue;
    }

    if (current.timeSec - previous.timeSec > MAX_NEIGHBOR_GAP_SEC || next.timeSec - current.timeSec > MAX_NEIGHBOR_GAP_SEC) {
      continue;
    }

    if (
      Math.abs(current.midi - previous.midi) > MAX_CONFIDENCE_PROMOTION_INTERVAL_SEMITONES ||
      Math.abs(next.midi - current.midi) > MAX_CONFIDENCE_PROMOTION_INTERVAL_SEMITONES
    ) {
      continue;
    }

    promoted[index] = {
      ...current,
      confidence: Math.max(MIN_PROMOTED_CONFIDENCE, Math.min(previous.confidence, next.confidence)),
    };
  }

  return promoted;
};

const fillShortUnvoicedGaps = (pitchPoints: PitchPoint[]) => {
  const filled = pitchPoints.map((point) => ({ ...point }));
  let gapStartIndex: number | null = null;

  for (let index = 0; index < filled.length; index += 1) {
    const point = filled[index];

    if (!isVoiced(point)) {
      if (gapStartIndex === null) {
        gapStartIndex = index;
      }
      continue;
    }

    if (gapStartIndex === null) {
      continue;
    }

    const previous = gapStartIndex > 0 ? filled[gapStartIndex - 1] : null;
    const next = point;
    if (!isVoiced(previous) || !isVoiced(next)) {
      gapStartIndex = null;
      continue;
    }

    const gapStartPoint = filled[gapStartIndex];
    const gapDurationSec = next.timeSec - gapStartPoint.timeSec;
    const neighborIntervalSemitones = Math.abs(next.midi - previous.midi);
    if (gapDurationSec > MAX_FILLED_GAP_SEC || neighborIntervalSemitones > MAX_FILLED_GAP_INTERVAL_SEMITONES) {
      gapStartIndex = null;
      continue;
    }

    const gapLength = index - gapStartIndex;
    for (let gapIndex = 0; gapIndex < gapLength; gapIndex += 1) {
      const pointIndex = gapStartIndex + gapIndex;
      const originalPoint = filled[pointIndex];
      const interpolation = (gapIndex + 1) / (gapLength + 1);
      filled[pointIndex] = {
        ...originalPoint,
        midi: previous.midi + (next.midi - previous.midi) * interpolation,
        confidence: Math.max(MIN_FILLED_CONFIDENCE, Math.min(previous.confidence, next.confidence)),
      };
    }

    gapStartIndex = null;
  }

  return filled;
};

export const smoothPitchTrack = (pitchPoints: PitchPoint[]) => {
  return fillShortUnvoicedGaps(promoteWeakVoicedConfidence(suppressDisplaySpikes(suppressShortOctaveGlitches(pitchPoints))));
};