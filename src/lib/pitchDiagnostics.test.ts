import { describe, expect, it } from 'vitest';

import { analyzePitchDiagnostics } from './pitchDiagnostics';
import type { PitchPoint } from './types';

const point = (timeSec: number, midi: number | null, confidence = 0.8): PitchPoint => ({
  timeSec,
  midi,
  confidence,
});

describe('analyzePitchDiagnostics', () => {
  it('detects single-frame spike candidates in raw pitch points', () => {
    const diagnostics = analyzePitchDiagnostics([
      point(0, 60),
      point(0.012, 60.2),
      point(0.024, 68, 0.22),
      point(0.036, 60.1),
      point(0.048, 60.3),
    ]);

    expect(diagnostics.spikeCount).toBe(1);
    expect(diagnostics.spikes[0]?.timeSec).toBeCloseTo(0.024, 3);
  });

  it('detects short null gaps between nearby voiced neighbors', () => {
    const diagnostics = analyzePitchDiagnostics([
      point(0, 60),
      point(0.012, 60.1),
      point(0.024, null, 0),
      point(0.036, null, 0),
      point(0.048, 60.2),
    ]);

    expect(diagnostics.shortGapCount).toBe(1);
    expect(diagnostics.shortGaps[0]?.durationSec).toBeGreaterThan(0);
  });

  it('detects short same-pitch-class octave islands in raw pitch points', () => {
    const diagnostics = analyzePitchDiagnostics([
      point(16.446, 58.56),
      point(16.451, 58.45),
      point(16.457, 70.35),
      point(16.463, 70.2),
      point(16.469, 58.5),
    ]);

    expect(diagnostics.octaveIslandCount).toBe(1);
    expect(diagnostics.octaveIslands[0]?.startSec).toBeCloseTo(16.457, 3);
    expect(diagnostics.octaveIslands[0]?.endSec).toBeCloseTo(16.463, 3);
    expect(diagnostics.octaveIslands[0]?.pointCount).toBe(2);
  });
});