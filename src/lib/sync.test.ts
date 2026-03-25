import { describe, expect, it } from 'vitest';

import { initialState } from './data';
import { appReducer } from './sync';
import type { StemTrack } from './types';

const generatedStem = (id: string, sourceUrl: string): StemTrack => ({
  id,
  label: id === 'vocals' ? 'Separated vocals' : 'Other stem',
  status: 'generated',
  sourceUrl,
});

describe('appReducer stem state', () => {
  it('resets imported players to planned stems and original playback', () => {
    const nextState = appReducer(initialState, {
      type: 'replace-media-for-players',
      playerIds: ['lead'],
      sourceLabel: 'Imported clip',
      mediaSourceUrl: 'asset://imported/video.webm',
      mediaSourcePath: 'C:\\media\\video.webm',
      mediaKind: 'video',
      audioCodec: 'opus',
      videoCodec: 'vp9',
    });

    const lead = nextState.players.find((player) => player.id === 'lead');

    expect(lead?.activeStemId).toBe('original');
    expect(lead?.availableStems).toEqual([
      { id: 'original', label: 'Original mix', status: 'source', sourceUrl: 'asset://imported/video.webm' },
      { id: 'vocals', label: 'Separated vocals', status: 'planned' },
      { id: 'other', label: 'Other stem', status: 'planned' },
    ]);
  });

  it('auto-selects vocals when generated stems are attached', () => {
    const importedState = appReducer(initialState, {
      type: 'replace-media-for-players',
      playerIds: ['lead'],
      sourceLabel: 'Imported clip',
      mediaSourceUrl: 'asset://imported/video.webm',
      mediaSourcePath: 'C:\\media\\video.webm',
      mediaKind: 'video',
      audioCodec: 'opus',
      videoCodec: 'vp9',
    });

    const nextState = appReducer(importedState, {
      type: 'set-generated-stems',
      playerIds: ['lead'],
      stems: [generatedStem('other', 'asset://imported/other.wav'), generatedStem('vocals', 'asset://imported/vocals.wav')],
    });

    const lead = nextState.players.find((player) => player.id === 'lead');

    expect(lead?.activeStemId).toBe('vocals');
    expect(lead?.availableStems).toEqual([
      { id: 'original', label: 'Original mix', status: 'source', sourceUrl: 'asset://imported/video.webm' },
      generatedStem('other', 'asset://imported/other.wav'),
      generatedStem('vocals', 'asset://imported/vocals.wav'),
    ]);
  });

  it('falls back to original when no playable generated stem matches the current selection', () => {
    const importedState = appReducer(initialState, {
      type: 'replace-media-for-players',
      playerIds: ['lead'],
      sourceLabel: 'Imported clip',
      mediaSourceUrl: 'asset://imported/video.webm',
      mediaSourcePath: 'C:\\media\\video.webm',
      mediaKind: 'video',
      audioCodec: 'opus',
      videoCodec: 'vp9',
    });

    const stateWithMissingVocals = appReducer(importedState, {
      type: 'set-generated-stems',
      playerIds: ['lead'],
      stems: [
        {
          id: 'vocals',
          label: 'Separated vocals',
          status: 'generated',
        },
      ],
    });

    const lead = stateWithMissingVocals.players.find((player) => player.id === 'lead');

    expect(lead?.activeStemId).toBe('original');
  });
});