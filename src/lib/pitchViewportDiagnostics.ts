import { buildPitchSegments, buildVisiblePitchPoints } from './pitchDisplay';
import type { PitchPoint } from './types';

const MIN_GRAPH_CONFIDENCE = 0.1;
const OCTAVE_DELTA_SEMITONES = 12;
const OCTAVE_DELTA_TOLERANCE_SEMITONES = 1.1;
const OCTAVE_CLASS_TOLERANCE_SEMITONES = 0.6;
const MAX_OCTAVE_ISLAND_LENGTH = 8;
const MAX_OCTAVE_ISLAND_DURATION_SEC = 0.08;
const MAX_NEIGHBOR_GAP_SEC = 0.08;
const MAX_STABLE_NEIGHBOR_DELTA_SEMITONES = 1.5;
const CANDIDATE_CONTEXT_SEC = 0.03;

export type OctaveIsland = {
  startSec: number;
  endSec: number;
  durationSec: number;
  pointCount: number;
  referenceMidi: number;
  islandMidis: number[];
};

export type ViewportAlignment = 'center' | 'left-edge' | 'right-edge';

export type RenderedOctaveGlitchWindow = {
  alignment: ViewportAlignment;
  focusTimeSec: number;
  rangeStart: number;
  rangeEnd: number;
  midiCenter: number;
  candidate: OctaveIsland;
  renderedIslands: OctaveIsland[];
  renderedPoints: Array<{ timeSec: number; midi: number }>;
};

export type ViewportGlitchScan = {
  durationSec: number;
  rawOctaveIslands: OctaveIsland[];
  survivingRenderedWindows: RenderedOctaveGlitchWindow[];
  sweptRenderedJumps: RenderedOctaveJump[];
};

export type RenderedOctaveJump = {
  focusTimeSec: number;
  rangeStart: number;
  rangeEnd: number;
  midiCenter: number;
  jumpStartSec: number;
  jumpEndSec: number;
  jumpStartMidi: number;
  jumpEndMidi: number;
};

export type ViewportGlitchScanOptions = {
  timeScaleSec: number;
  pitchRangeSemitones: number;
  durationSec?: number;
  minConfidence?: number;
  pitchCenterMode?: 'adaptive' | 'fixed';
  fixedMidiCenter?: number;
  alignments?: ViewportAlignment[];
  focusStepSec?: number;
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

const getAdaptiveMidiCenter = (pitchPoints: PitchPoint[], focusTimeSec: number, timeScaleSec: number, minConfidence: number) => {
  const visibleMidis = pitchPoints
    .filter(
      (point) =>
        point.midi !== null &&
        point.confidence >= minConfidence &&
        Math.abs(point.timeSec - focusTimeSec) <= Math.max(1, timeScaleSec * 0.7),
    )
    .map((point) => point.midi as number)
    .sort((left, right) => left - right);

  if (visibleMidis.length === 0) {
    return 60;
  }

  const middleIndex = Math.floor(visibleMidis.length / 2);
  const median =
    visibleMidis.length % 2 === 0
      ? (visibleMidis[middleIndex - 1] + visibleMidis[middleIndex]) / 2
      : visibleMidis[middleIndex];

  return Math.round(Math.min(84, Math.max(36, median)));
};

const detectOctaveIslands = (points: Array<{ timeSec: number; midi: number }>): OctaveIsland[] => {
  if (points.length < 4) {
    return [];
  }

  const islands: OctaveIsland[] = [];

  for (let startIndex = 1; startIndex < points.length - 1; startIndex += 1) {
    const previous = points[startIndex - 1];
    if (!previous) {
      continue;
    }

    const lastCandidateIndex = Math.min(points.length - 2, startIndex + MAX_OCTAVE_ISLAND_LENGTH - 1);
    for (let candidateEndIndex = startIndex; candidateEndIndex <= lastCandidateIndex; candidateEndIndex += 1) {
      const next = points[candidateEndIndex + 1];
      const startPoint = points[startIndex];
      const endPoint = points[candidateEndIndex];
      if (!next || !startPoint || !endPoint) {
        continue;
      }

      if (endPoint.timeSec - startPoint.timeSec > MAX_OCTAVE_ISLAND_DURATION_SEC) {
        break;
      }

      if (next.timeSec - previous.timeSec > MAX_NEIGHBOR_GAP_SEC * (candidateEndIndex - startIndex + 2)) {
        continue;
      }

      const referenceGap = Math.abs(next.midi - previous.midi);
      if (referenceGap > MAX_STABLE_NEIGHBOR_DELTA_SEMITONES) {
        continue;
      }

      const referenceMidi = (previous.midi + next.midi) / 2;
      const islandMidis: number[] = [];
      let allCandidatesLookLikeOctaveShifts = true;

      for (let candidateIndex = startIndex; candidateIndex <= candidateEndIndex; candidateIndex += 1) {
        const candidate = points[candidateIndex];
        if (!candidate || !isOctaveShiftFromReference(candidate.midi, referenceMidi)) {
          allCandidatesLookLikeOctaveShifts = false;
          break;
        }

        islandMidis.push(candidate.midi);
      }

      if (!allCandidatesLookLikeOctaveShifts) {
        continue;
      }

      islands.push({
        startSec: startPoint.timeSec,
        endSec: endPoint.timeSec,
        durationSec: endPoint.timeSec - startPoint.timeSec,
        pointCount: candidateEndIndex - startIndex + 1,
        referenceMidi,
        islandMidis,
      });
      startIndex = candidateEndIndex;
      break;
    }
  }

  return islands;
};

const detectRenderedOctaveJumps = (segments: Array<Array<{ timeSec: number; midi: number }>>) => {
  const jumps: Array<{ jumpStartSec: number; jumpEndSec: number; jumpStartMidi: number; jumpEndMidi: number }> = [];

  for (const segment of segments) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      const current = segment[index];
      const next = segment[index + 1];
      if (!current || !next) {
        continue;
      }

      if (next.timeSec - current.timeSec > MAX_NEIGHBOR_GAP_SEC) {
        continue;
      }

      if (!isOctaveShiftFromReference(next.midi, current.midi)) {
        continue;
      }

      jumps.push({
        jumpStartSec: current.timeSec,
        jumpEndSec: next.timeSec,
        jumpStartMidi: current.midi,
        jumpEndMidi: next.midi,
      });
    }
  }

  return jumps;
};

const buildFocusTime = (candidate: OctaveIsland, timeScaleSec: number, alignment: ViewportAlignment, durationSec: number) => {
  const midpoint = (candidate.startSec + candidate.endSec) / 2;
  const unclampedFocus =
    alignment === 'left-edge'
      ? candidate.startSec + timeScaleSec / 2
      : alignment === 'right-edge'
        ? candidate.endSec - timeScaleSec / 2
        : midpoint;
  return Math.max(0, Math.min(durationSec, unclampedFocus));
};

export const scanRenderedOctaveGlitches = (
  pitchPoints: PitchPoint[],
  {
    timeScaleSec,
    pitchRangeSemitones,
    durationSec = pitchPoints[pitchPoints.length - 1]?.timeSec ?? 0,
    minConfidence = MIN_GRAPH_CONFIDENCE,
    pitchCenterMode = 'adaptive',
    fixedMidiCenter = 60,
    alignments = ['center', 'left-edge', 'right-edge'],
    focusStepSec = 0.01,
  }: ViewportGlitchScanOptions,
): ViewportGlitchScan => {
  const rawVoicedPoints = pitchPoints.flatMap((point) =>
    point.midi === null
      ? []
      : [
          {
            timeSec: point.timeSec,
            midi: point.midi,
          },
        ],
  );
  const rawOctaveIslands = detectOctaveIslands(rawVoicedPoints);
  const survivingRenderedWindows: RenderedOctaveGlitchWindow[] = [];
  const sweptRenderedJumps: RenderedOctaveJump[] = [];

  for (const candidate of rawOctaveIslands) {
    for (const alignment of alignments) {
      const focusTimeSec = buildFocusTime(candidate, timeScaleSec, alignment, durationSec);
      const rangeStart = Math.max(0, focusTimeSec - timeScaleSec / 2);
      const rangeEnd = Math.min(durationSec + timeScaleSec, rangeStart + timeScaleSec);
      const midiCenter =
        pitchCenterMode === 'adaptive'
          ? getAdaptiveMidiCenter(pitchPoints, focusTimeSec, timeScaleSec, minConfidence)
          : fixedMidiCenter;
      const midiMin = midiCenter - pitchRangeSemitones / 2;
      const midiMax = midiCenter + pitchRangeSemitones / 2;
      const renderedPoints = buildVisiblePitchPoints(
        pitchPoints,
        rangeStart,
        rangeEnd,
        midiMin,
        midiMax,
        minConfidence,
      );
      const localRenderedPoints = renderedPoints.filter(
        (point) => point.timeSec >= candidate.startSec - CANDIDATE_CONTEXT_SEC && point.timeSec <= candidate.endSec + CANDIDATE_CONTEXT_SEC,
      );
      const renderedIslands = detectOctaveIslands(localRenderedPoints);

      if (renderedIslands.length === 0) {
        continue;
      }

      survivingRenderedWindows.push({
        alignment,
        focusTimeSec,
        rangeStart,
        rangeEnd,
        midiCenter,
        candidate,
        renderedIslands,
        renderedPoints: localRenderedPoints,
      });
    }
  }

  const seenJumpKeys = new Set<string>();
  for (let focusTimeSec = 0; focusTimeSec <= durationSec; focusTimeSec += focusStepSec) {
    const rangeStart = Math.max(0, focusTimeSec - timeScaleSec / 2);
    const rangeEnd = Math.min(durationSec + timeScaleSec, rangeStart + timeScaleSec);
    const midiCenter =
      pitchCenterMode === 'adaptive'
        ? getAdaptiveMidiCenter(pitchPoints, focusTimeSec, timeScaleSec, minConfidence)
        : fixedMidiCenter;
    const midiMin = midiCenter - pitchRangeSemitones / 2;
    const midiMax = midiCenter + pitchRangeSemitones / 2;
    const renderedPoints = buildVisiblePitchPoints(
      pitchPoints,
      rangeStart,
      rangeEnd,
      midiMin,
      midiMax,
      minConfidence,
    );
    const renderedSegments = buildPitchSegments(
      pitchPoints,
      rangeStart,
      rangeEnd,
      midiMin,
      midiMax,
      minConfidence,
    );
    const directJumps = detectRenderedOctaveJumps(renderedSegments);

    for (const jump of directJumps) {
      const jumpKey = `${jump.jumpStartSec.toFixed(3)}:${jump.jumpEndSec.toFixed(3)}:${pitchRangeSemitones}`;
      if (seenJumpKeys.has(jumpKey)) {
        continue;
      }

      seenJumpKeys.add(jumpKey);
      sweptRenderedJumps.push({
        focusTimeSec,
        rangeStart,
        rangeEnd,
        midiCenter,
        ...jump,
      });
    }
  }

  return {
    durationSec,
    rawOctaveIslands,
    survivingRenderedWindows,
    sweptRenderedJumps,
  };
};