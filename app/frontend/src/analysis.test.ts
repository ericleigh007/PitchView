import { describe, expect, test } from "vitest";
import { computeAmplitudeEnvelope, computePitchContour, deglitchPitchContour, repairPitchDropouts } from "./analysis";

function buildSineWave(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const sampleCount = Math.floor(sampleRate * seconds);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * (index % 4000 < 2000 ? 0.2 : 0.8);
  }

  return samples;
}

function buildWarblingSineWave(baseFrequency: number, sampleRate: number, seconds: number): Float32Array {
  const sampleCount = Math.floor(sampleRate * seconds);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const vibrato = 12 * Math.sin(2 * Math.PI * 7 * time);
    const instantaneousFrequency = baseFrequency + vibrato;
    samples[index] = Math.sin((2 * Math.PI * instantaneousFrequency * index) / sampleRate) * 0.45;
  }

  return samples;
}

describe("analysis helpers", () => {
  test("normalizes amplitude envelope buckets", () => {
    const samples = new Float32Array([0, 0.5, 0.2, 1, 0.1, 0.9, 0.3, 0.7]);
    const envelope = computeAmplitudeEnvelope(samples, 4);

    expect(envelope).toHaveLength(4);
    expect(Math.max(...envelope)).toBe(1);
  });

  test("suppresses isolated pitch glitches", () => {
    const contour = [220, 221, 440, 222, 223];
    const confidence = [0.98, 0.98, 0.4, 0.98, 0.98];

    expect(deglitchPitchContour(contour, confidence)[2]).toBeGreaterThan(220);
    expect(deglitchPitchContour(contour, confidence)[2]).toBeLessThan(230);
  });

  test("repairs short pitch dropouts between stable voiced frames", () => {
    const contour = [220, 221, 0, 222, 223];
    const confidence = [0.95, 0.95, 0.2, 0.95, 0.95];

    const repaired = repairPitchDropouts(contour, confidence);

    expect(repaired[2]).toBeGreaterThan(220);
    expect(repaired[2]).toBeLessThan(223);
  });

  test("tracks pitch from leveled input across amplitude changes", () => {
    const samples = buildSineWave(220, 44100, 1.5);
    const pitch = computePitchContour(samples, 44100, 24);
    const detected = pitch.contour.filter((value) => value > 0);
    const average = detected.reduce((sum, value) => sum + value, 0) / detected.length;

    expect(detected.length).toBeGreaterThan(8);
    expect(average).toBeGreaterThan(210);
    expect(average).toBeLessThan(230);
  });

  test("preserves natural pitch modulation instead of flattening the contour", () => {
    const samples = buildWarblingSineWave(220, 44100, 1.5);
    const pitch = computePitchContour(samples, 44100, 72);
    const detected = pitch.contour.filter((value) => value > 0);
    const spread = Math.max(...detected) - Math.min(...detected);

    expect(detected.length).toBeGreaterThan(32);
    expect(spread).toBeGreaterThan(10);
  });
});
