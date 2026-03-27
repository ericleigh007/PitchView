import type { PitchPoint } from './types';

const MAX_NEIGHBOR_GAP_SEC = 0.08;
const SPIKE_DELTA_SEMITONES = 4.5;
const SPIKE_NEIGHBOR_DELTA_SEMITONES = 1.25;
const MAX_SHORT_GAP_SEC = 0.09;
const MAX_GAP_NEIGHBOR_DELTA_SEMITONES = 2.5;
const OCTAVE_DELTA_SEMITONES = 12;
const OCTAVE_DELTA_TOLERANCE_SEMITONES = 1.1;
const OCTAVE_CLASS_TOLERANCE_SEMITONES = 0.6;
const MAX_OCTAVE_ISLAND_LENGTH = 3;
const MAX_EXAMPLES = 6;

export type PitchSpikeCandidate = {
  timeSec: number;
  midi: number;
  previousMidi: number;
  nextMidi: number;
  confidence: number;
};

export type PitchGapCandidate = {
  startSec: number;
  endSec: number;
  durationSec: number;
  previousMidi: number;
  nextMidi: number;
};

export type PitchOctaveIslandCandidate = {
  startSec: number;
  endSec: number;
  durationSec: number;
  pointCount: number;
  referenceMidi: number;
  islandMidis: number[];
};

export type PitchDiagnostics = {
  voicedPoints: number;
  nullPoints: number;
  spikeCount: number;
  shortGapCount: number;
  octaveIslandCount: number;
  spikes: PitchSpikeCandidate[];
  shortGaps: PitchGapCandidate[];
  octaveIslands: PitchOctaveIslandCandidate[];
};

const isVoiced = (point: PitchPoint) => point.midi !== null;

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

export const analyzePitchDiagnostics = (pitchPoints: PitchPoint[]): PitchDiagnostics => {
  const spikes: PitchSpikeCandidate[] = [];
  const shortGaps: PitchGapCandidate[] = [];
  const octaveIslands: PitchOctaveIslandCandidate[] = [];
  const voicedPoints = pitchPoints.filter(isVoiced).length;
  const nullPoints = pitchPoints.length - voicedPoints;

  for (let index = 1; index < pitchPoints.length - 1; index += 1) {
    const previous = pitchPoints[index - 1];
    const current = pitchPoints[index];
    const next = pitchPoints[index + 1];

    if (!isVoiced(previous) || !isVoiced(current) || !isVoiced(next)) {
      continue;
    }

    if (current.timeSec - previous.timeSec > MAX_NEIGHBOR_GAP_SEC || next.timeSec - current.timeSec > MAX_NEIGHBOR_GAP_SEC) {
      continue;
    }

    const previousGap = Math.abs((current.midi as number) - (previous.midi as number));
    const nextGap = Math.abs((current.midi as number) - (next.midi as number));
    const neighborGap = Math.abs((next.midi as number) - (previous.midi as number));

    if (
      previousGap >= SPIKE_DELTA_SEMITONES &&
      nextGap >= SPIKE_DELTA_SEMITONES &&
      neighborGap <= SPIKE_NEIGHBOR_DELTA_SEMITONES
    ) {
      spikes.push({
        timeSec: current.timeSec,
        midi: current.midi as number,
        previousMidi: previous.midi as number,
        nextMidi: next.midi as number,
        confidence: current.confidence,
      });
    }
  }

  let gapStartIndex: number | null = null;

  for (let index = 0; index < pitchPoints.length; index += 1) {
    const point = pitchPoints[index];
    const isNull = point.midi === null;

    if (isNull && gapStartIndex === null) {
      gapStartIndex = index;
      continue;
    }

    if (isNull) {
      continue;
    }

    if (gapStartIndex === null) {
      continue;
    }

    const previousIndex = gapStartIndex - 1;
    const previous = previousIndex >= 0 ? pitchPoints[previousIndex] : null;
    const next = point;

    if (!previous || !isVoiced(previous) || !isVoiced(next)) {
      gapStartIndex = null;
      continue;
    }

    const gapStartSec = pitchPoints[gapStartIndex].timeSec;
    const gapEndSec = pitchPoints[index - 1]?.timeSec ?? gapStartSec;
    const durationSec = next.timeSec - gapStartSec;
    const neighborDelta = Math.abs((next.midi as number) - (previous.midi as number));

    if (durationSec <= MAX_SHORT_GAP_SEC && neighborDelta <= MAX_GAP_NEIGHBOR_DELTA_SEMITONES) {
      shortGaps.push({
        startSec: gapStartSec,
        endSec: gapEndSec,
        durationSec,
        previousMidi: previous.midi as number,
        nextMidi: next.midi as number,
      });
    }

    gapStartIndex = null;
  }

  for (let index = 1; index < pitchPoints.length - 2; index += 1) {
    const previous = pitchPoints[index - 1];
    if (!isVoiced(previous)) {
      continue;
    }

    let endIndex = index;
    while (endIndex < pitchPoints.length && isVoiced(pitchPoints[endIndex])) {
      endIndex += 1;
    }

    const lastCandidateIndex = Math.min(endIndex - 1, index + MAX_OCTAVE_ISLAND_LENGTH - 1);

    for (let candidateEndIndex = index; candidateEndIndex <= lastCandidateIndex; candidateEndIndex += 1) {
      const next = pitchPoints[candidateEndIndex + 1];
      if (!next || !isVoiced(next)) {
        continue;
      }

      if (next.timeSec - previous.timeSec > MAX_NEIGHBOR_GAP_SEC * (candidateEndIndex - index + 2)) {
        continue;
      }

      const referenceGap = Math.abs((next.midi as number) - (previous.midi as number));
      if (referenceGap > SPIKE_NEIGHBOR_DELTA_SEMITONES) {
        continue;
      }

      let allCandidatesLookLikeOctaveShifts = true;
      const islandMidis: number[] = [];
      for (let candidateIndex = index; candidateIndex <= candidateEndIndex; candidateIndex += 1) {
        const candidate = pitchPoints[candidateIndex];
        if (!isVoiced(candidate)) {
          allCandidatesLookLikeOctaveShifts = false;
          break;
        }

        const midi = candidate.midi as number;
        islandMidis.push(midi);
        if (!isOctaveShiftFromReference(midi, previous.midi as number) || !isOctaveShiftFromReference(midi, next.midi as number)) {
          allCandidatesLookLikeOctaveShifts = false;
          break;
        }
      }

      if (!allCandidatesLookLikeOctaveShifts) {
        continue;
      }

      octaveIslands.push({
        startSec: pitchPoints[index].timeSec,
        endSec: pitchPoints[candidateEndIndex].timeSec,
        durationSec: pitchPoints[candidateEndIndex].timeSec - pitchPoints[index].timeSec,
        pointCount: candidateEndIndex - index + 1,
        referenceMidi: ((previous.midi as number) + (next.midi as number)) / 2,
        islandMidis,
      });
      index = candidateEndIndex;
      break;
    }
  }

  return {
    voicedPoints,
    nullPoints,
    spikeCount: spikes.length,
    shortGapCount: shortGaps.length,
    octaveIslandCount: octaveIslands.length,
    spikes: spikes.slice(0, MAX_EXAMPLES),
    shortGaps: shortGaps.slice(0, MAX_EXAMPLES),
    octaveIslands: octaveIslands.slice(0, MAX_EXAMPLES),
  };
};