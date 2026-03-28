import { describe, expect, it } from 'vitest';

import { initialState } from './data';
import { MIN_LAYER_OFFSET_X, MAX_LAYER_OFFSET_Y, appReducer, getAudibleState, getMasterPosition } from './sync';

describe('appReducer workflow modes', () => {
  it('toggles play across the locked group only', () => {
    const nextState = appReducer(initialState, {
      type: 'toggle-play',
      playerId: 'lead',
    });

    const lead = nextState.players.find((player) => player.id === 'lead');
    const harmony = nextState.players.find((player) => player.id === 'harmony');
    const guitar = nextState.players.find((player) => player.id === 'guitar');

    expect(lead?.isPlaying).toBe(true);
    expect(harmony?.isPlaying).toBe(true);
    expect(guitar?.isPlaying).toBe(false);
  });

  it('seeks the locked group together while leaving unlocked players alone', () => {
    const nextState = appReducer(initialState, {
      type: 'seek',
      playerId: 'lead',
      positionSec: 42.5,
    });

    const lead = nextState.players.find((player) => player.id === 'lead');
    const harmony = nextState.players.find((player) => player.id === 'harmony');
    const guitar = nextState.players.find((player) => player.id === 'guitar');

    expect(lead?.positionSec).toBe(42.5);
    expect(harmony?.positionSec).toBe(42.5);
    expect(guitar?.positionSec).toBe(initialState.players.find((player) => player.id === 'guitar')?.positionSec);
  });

  it('locks a free player onto the current master position and play state', () => {
    const playingState = appReducer(initialState, {
      type: 'set-playing-state',
      playerId: 'lead',
      isPlaying: true,
    });

    const nextState = appReducer(playingState, {
      type: 'toggle-lock',
      playerId: 'guitar',
    });

    const guitar = nextState.players.find((player) => player.id === 'guitar');

    expect(guitar?.isLocked).toBe(true);
    expect(guitar?.isPlaying).toBe(true);
    expect(guitar?.positionSec).toBe(getMasterPosition(playingState.players));
  });

  it('replaces media for a targeted subset of players only', () => {
    const nextState = appReducer(initialState, {
      type: 'replace-media-for-players',
      playerIds: ['lead', 'guitar'],
      sourceLabel: 'Imported take',
      mediaSourceUrl: 'asset://imported/take.webm',
      mediaSourcePath: 'C:\\media\\take.webm',
      mediaKind: 'video',
      audioCodec: 'opus',
      videoCodec: 'vp9',
    });

    const lead = nextState.players.find((player) => player.id === 'lead');
    const harmony = nextState.players.find((player) => player.id === 'harmony');
    const guitar = nextState.players.find((player) => player.id === 'guitar');

    expect(lead?.sourceLabel).toBe('Imported take');
    expect(guitar?.sourceLabel).toBe('Imported take');
    expect(harmony?.sourceLabel).toBe(initialState.players.find((player) => player.id === 'harmony')?.sourceLabel);
  });

  it('clears pitch points while a source is re-analyzing', () => {
    const readyState = appReducer(initialState, {
      type: 'set-pitch-points',
      playerId: 'lead',
      pitchSourceUrl: 'asset://vocals.wav',
      pitchPoints: [{ timeSec: 0.1, midi: 60, confidence: 0.9 }],
    });

    const nextState = appReducer(readyState, {
      type: 'set-pitch-status',
      playerId: 'lead',
      pitchStatus: 'loading',
      pitchSourceUrl: 'asset://vocals.wav',
    });

    const lead = nextState.players.find((player) => player.id === 'lead');

    expect(lead?.pitchStatus).toBe('loading');
    expect(lead?.pitchPoints).toEqual([]);
  });

  it('clamps layer size and position changes to the allowed workspace bounds', () => {
    const resized = appReducer(initialState, {
      type: 'set-layer-size',
      playerId: 'lead',
      width: 9999,
      height: 5,
    });
    const moved = appReducer(resized, {
      type: 'set-layer-position',
      playerId: 'lead',
      offsetX: -999,
      offsetY: 9999,
    });

    const lead = moved.players.find((player) => player.id === 'lead');

    expect(lead?.width).toBe(1500);
    expect(lead?.height).toBe(240);
    expect(lead?.offsetX).toBe(MIN_LAYER_OFFSET_X);
    expect(lead?.offsetY).toBe(MAX_LAYER_OFFSET_Y);
  });
});

describe('audible mode resolution', () => {
  it('suppresses non-solo layers when any solo layer is active', () => {
    const harmonyState = appReducer(initialState, {
      type: 'set-mix-mode',
      playerId: 'harmony',
      mixMode: 'solo',
    });

    expect(getAudibleState(harmonyState.players, 'lead')).toEqual({ audible: true, emphasis: 1 });
    expect(getAudibleState(harmonyState.players, 'harmony')).toEqual({ audible: true, emphasis: 1 });
    expect(getAudibleState(harmonyState.players, 'guitar')).toEqual({ audible: false, emphasis: 0.15 });
  });

  it('returns muted layers as inaudible even without a solo layer', () => {
    expect(getAudibleState(initialState.players, 'guitar')).toEqual({ audible: false, emphasis: 0.15 });
  });
});