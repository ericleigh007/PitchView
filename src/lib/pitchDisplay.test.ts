import { describe, expect, it } from 'vitest';

import { buildPitchSegments } from './pitchDisplay';
import type { PitchPoint } from './types';

const point = (timeSec: number, midi: number | null, confidence = 0.8): PitchPoint => ({
  timeSec,
  midi,
  confidence,
});

describe('buildPitchSegments', () => {
  it('bridges tiny null gaps between otherwise continuous notes', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.012, 60.2), point(0.024, null, 0), point(0.036, 60.3), point(0.048, 60.5)],
      0,
      1,
      48,
      72,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(4);
  });

  it('keeps abrupt note changes connected when there is no silence gap', () => {
    const segments = buildPitchSegments(
      [point(0, 52), point(0.012, 52.1), point(0.024, 69), point(0.036, 69.2)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].map((entry) => Math.round(entry.midi))).toEqual([52, 52, 69, 69]);
  });

  it('breaks segments when the detector reports an actual missing region', () => {
    const segments = buildPitchSegments(
      [point(0, 52), point(0.012, 52.1), point(0.024, null, 0), point(0.096, 69), point(0.108, 69.2)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].map((entry) => Math.round(entry.midi))).toEqual([52, 52]);
    expect(segments[1].map((entry) => Math.round(entry.midi))).toEqual([69, 69]);
  });

  it('bridges a short null-only slur gap between nearby notes', () => {
    const segments = buildPitchSegments(
      [
        point(0, 63.1, 0.14),
        point(0.012, 63.0, 0.14),
        point(0.024, null, 0),
        point(0.036, null, 0),
        point(0.048, null, 0),
        point(0.06, null, 0.1),
        point(0.072, null, 0.1),
        point(0.078, 59.82, 0.14),
        point(0.09, 59.58, 0.14),
      ],
      0,
      1,
      48,
      72,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].map((entry) => Number(entry.midi.toFixed(2)))).toEqual([63.1, 63, 59.82, 59.58]);
  });

  it('suppresses isolated one-frame spikes between stable neighbors', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.012, 60.1), point(0.024, 67, 0.3), point(0.036, 60.2), point(0.048, 60.3)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0][2].midi).toBeCloseTo(60.15, 1);
  });

  it('keeps short supported changes instead of flattening them as spikes', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.012, 60.1), point(0.024, 67, 0.95), point(0.036, 67.1, 0.95), point(0.048, 60.3)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0][2].midi).toBeCloseTo(67, 1);
    expect(segments[0][3].midi).toBeCloseTo(67.1, 1);
  });

  it('does not leave a spike visible just because stable neighbors are outside the pitch window', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.012, 60.1), point(0.024, 67, 0.95), point(0.036, 60.2), point(0.048, 60.3)],
      0,
      1,
      66,
      68,
      0.14,
    );

    expect(segments).toHaveLength(0);
  });

  it('suppresses short same-pitch-class octave glitches bracketed by stable neighbors', () => {
    const segments = buildPitchSegments(
      [point(0, 58), point(0.012, 58.1), point(0.024, 70.05, 0.95), point(0.036, 70.15, 0.95), point(0.048, 58.2), point(0.06, 58.1)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(6);
    expect(segments[0][0].midi).toBeCloseTo(58, 3);
    expect(segments[0][1].midi).toBeCloseTo(58.1, 3);
    expect(segments[0][2].midi).toBeCloseTo(58.1, 3);
    expect(segments[0][3].midi).toBeCloseTo(58.1, 3);
    expect(segments[0][4].midi).toBeCloseTo(58.2, 3);
    expect(segments[0][5].midi).toBeCloseTo(58.1, 3);
  });

  it('uses lower-confidence neighbors to suppress a confident one-frame octave glitch', () => {
    const segments = buildPitchSegments(
      [point(0, 58.4, 0.12), point(0.006, 70.35, 0.9), point(0.012, 58.5, 0.12), point(0.018, 58.45, 0.9)],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(2);
    expect(segments[0][0].midi).toBeCloseTo(58.45, 2);
    expect(segments[0][1].midi).toBeCloseTo(58.45, 2);
  });

  it('suppresses a two-hop octave island using the surrounding stable reference', () => {
    const segments = buildPitchSegments(
      [
        point(0.0, 58.56, 0.9),
        point(0.006, 58.45, 0.9),
        point(0.012, 70.35, 0.9),
        point(0.018, 70.2, 0.9),
        point(0.024, 58.5, 0.9),
        point(0.03, 58.48, 0.9),
      ],
      0,
      1,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(6);
    expect(segments[0][0].midi).toBeCloseTo(58.56, 2);
    expect(segments[0][1].midi).toBeCloseTo(58.45, 2);
    expect(segments[0][2].midi).toBeCloseTo(58.5, 1);
    expect(segments[0][3].midi).toBeCloseTo(58.5, 1);
    expect(segments[0][4].midi).toBeCloseTo(58.5, 2);
    expect(segments[0][5].midi).toBeCloseTo(58.48, 2);
  });

  it('suppresses an octave island when the stabilizing neighbors sit just outside the visible time window', () => {
    const segments = buildPitchSegments(
      [
        point(0.0, 58.56, 0.9),
        point(0.006, 58.45, 0.9),
        point(0.012, 70.35, 0.9),
        point(0.018, 70.2, 0.9),
        point(0.024, 58.5, 0.9),
        point(0.03, 58.48, 0.9),
      ],
      0.012,
      0.024,
      48,
      80,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(3);
    expect(segments[0][0].midi).toBeCloseTo(58.5, 1);
    expect(segments[0][1].midi).toBeCloseTo(58.5, 1);
    expect(segments[0][2].midi).toBeCloseTo(58.5, 2);
  });

  it('breaks the line instead of bridging through hidden out-of-range voiced points', () => {
    const segments = buildPitchSegments(
      [point(0, 60), point(0.006, 60.1), point(0.012, 41.2), point(0.018, 41.3), point(0.024, 48.3), point(0.03, 60.2)],
      0,
      1,
      48,
      72,
      0.14,
    );

    expect(segments).toHaveLength(3);
    expect(segments[0].map((entry) => Math.round(entry.midi))).toEqual([60, 60]);
    expect(segments[1].map((entry) => Math.round(entry.midi))).toEqual([48]);
    expect(segments[2].map((entry) => Math.round(entry.midi))).toEqual([60]);
  });

  it('breaks unresolved direct octave steps into separate segments', () => {
    const segments = buildPitchSegments(
      [point(0, 49.05), point(0.006, 61.42), point(0.012, 61.31), point(0.018, 61.26)],
      0,
      1,
      36,
      72,
      0.14,
    );

    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(1);
    expect(segments[1].map((entry) => Math.round(entry.midi))).toEqual([61, 61, 61]);
  });

  it('suppresses a slightly longer rapid octave island with a stable local context', () => {
    const segments = buildPitchSegments(
      [
        point(0.0, 49.02, 0.9),
        point(0.006, 49.05, 0.9),
        point(0.012, 61.42, 0.9),
        point(0.018, 61.31, 0.9),
        point(0.024, 61.26, 0.9),
        point(0.03, 49.08, 0.9),
        point(0.036, 49.04, 0.9),
      ],
      0,
      1,
      36,
      72,
      0.14,
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(7);
    expect(segments[0][0].midi).toBeCloseTo(49.02, 2);
    expect(segments[0][1].midi).toBeCloseTo(49.05, 2);
    expect(segments[0][2].midi).toBeCloseTo(49.05, 1);
    expect(segments[0][3].midi).toBeCloseTo(49.05, 1);
    expect(segments[0][4].midi).toBeCloseTo(49.05, 1);
    expect(segments[0][5].midi).toBeCloseTo(49.08, 2);
    expect(segments[0][6].midi).toBeCloseTo(49.04, 2);
  });
});