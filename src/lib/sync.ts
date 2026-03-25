import type { AppState, PlayerState, TransportAction } from './types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clampLayerWidth = (value: number) => clamp(value, 720, 1500);
const clampLayerHeight = (value: number) => clamp(value, 420, 920);

const withSelectedPlayer = (state: AppState, playerId: string) => {
  const player = state.players.find((entry) => entry.id === playerId);
  return player ?? state.players[0];
};

const applyToLockedGroup = (
  players: PlayerState[],
  actor: PlayerState,
  updater: (player: PlayerState) => PlayerState,
) => {
  if (!actor.isLocked) {
    return players.map((player) => (player.id === actor.id ? updater(player) : player));
  }

  return players.map((player) => (player.isLocked ? updater(player) : player));
};

const stopPlayer = (player: PlayerState): PlayerState => ({
  ...player,
  isPlaying: false,
  positionSec: 0,
});

const setPosition = (player: PlayerState, positionSec: number): PlayerState => ({
  ...player,
  positionSec: clamp(positionSec, 0, player.durationSec),
});

const setPlaying = (player: PlayerState, isPlaying: boolean): PlayerState => ({
  ...player,
  isPlaying,
});

export const getMasterPosition = (players: PlayerState[]): number => {
  const lockedPlayers = players.filter((player) => player.isLocked);
  const source = lockedPlayers[0] ?? players[0];
  return source?.positionSec ?? 0;
};

export const getAudibleState = (players: PlayerState[], playerId: string) => {
  const hasSolo = players.some((player) => player.mixMode === 'solo');
  const player = players.find((entry) => entry.id === playerId);

  if (!player) {
    return { audible: false, emphasis: 0.15 };
  }

  if (player.mixMode === 'muted') {
    return { audible: false, emphasis: 0.15 };
  }

  if (hasSolo) {
    return {
      audible: player.mixMode === 'solo',
      emphasis: player.mixMode === 'solo' ? 1 : 0.18,
    };
  }

  return { audible: true, emphasis: 1 };
};

export const appReducer = (state: AppState, action: TransportAction): AppState => {
  switch (action.type) {
    case 'toggle-play': {
      const actor = withSelectedPlayer(state, action.playerId);
      const nextIsPlaying = !actor.isPlaying;
      return {
        ...state,
        players: applyToLockedGroup(state.players, actor, (player) => setPlaying(player, nextIsPlaying)),
      };
    }
    case 'set-playing-state': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId ? setPlaying(player, action.isPlaying) : player,
        ),
      };
    }
    case 'set-duration': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? {
                ...player,
                durationSec: Math.max(0.1, action.durationSec),
                positionSec: clamp(player.positionSec, 0, action.durationSec),
              }
            : player,
        ),
      };
    }
    case 'set-pitch-status': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? {
                ...player,
                pitchStatus: action.pitchStatus,
                pitchSourceUrl:
                  action.pitchSourceUrl === undefined ? player.pitchSourceUrl : action.pitchSourceUrl,
                pitchPoints: action.pitchStatus === 'loading' ? [] : player.pitchPoints,
              }
            : player,
        ),
      };
    }
    case 'set-pitch-points': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? {
                ...player,
                pitchPoints: action.pitchPoints,
                pitchStatus: 'ready',
                pitchSourceUrl: action.pitchSourceUrl,
              }
            : player,
        ),
      };
    }
    case 'replace-media-for-players': {
      return {
        ...state,
        players: state.players.map((player) => {
          if (!action.playerIds.includes(player.id)) {
            return player;
          }

          return {
            ...player,
            mediaKind: action.mediaKind,
            sourceLabel: action.sourceLabel,
            mediaSourceUrl: action.mediaSourceUrl,
            mediaSourcePath: action.mediaSourcePath ?? null,
            audioCodec: action.audioCodec,
            videoCodec: action.videoCodec,
            supportsTransparency: false,
            availableStems: [
              { id: 'original', label: 'Original mix', status: 'source', sourceUrl: action.mediaSourceUrl },
              { id: 'vocals', label: 'Separated vocals', status: 'planned' },
              { id: 'other', label: 'Other stem', status: 'planned' },
            ],
            activeStemId: 'original',
            durationSec: player.durationSec,
            positionSec: 0,
            isPlaying: false,
            pitchPoints: [],
            pitchStatus: 'idle',
            pitchSourceUrl: null,
          };
        }),
      };
    }
    case 'set-generated-stems': {
      return {
        ...state,
        players: state.players.map((player) => {
          if (!action.playerIds.includes(player.id)) {
            return player;
          }

          const originalStem = player.availableStems.find((stem) => stem.id === 'original') ?? {
            id: 'original',
            label: 'Original mix',
            status: 'source' as const,
            sourceUrl: player.mediaSourceUrl,
          };

          const nextAvailableStems = [originalStem, ...action.stems.filter((stem) => stem.id !== 'original')];
          const hasVocalsStem = nextAvailableStems.some((stem) => stem.id === 'vocals' && stem.sourceUrl);
          const hasCurrentStem = nextAvailableStems.some((stem) => stem.id === player.activeStemId && stem.sourceUrl);

          return {
            ...player,
            availableStems: nextAvailableStems,
            activeStemId: hasVocalsStem ? 'vocals' : hasCurrentStem ? player.activeStemId : 'original',
          };
        }),
      };
    }
    case 'stop': {
      const actor = withSelectedPlayer(state, action.playerId);
      return {
        ...state,
        players: applyToLockedGroup(state.players, actor, stopPlayer),
      };
    }
    case 'seek': {
      const actor = withSelectedPlayer(state, action.playerId);
      return {
        ...state,
        players: applyToLockedGroup(state.players, actor, (player) => setPosition(player, action.positionSec)),
      };
    }
    case 'skip': {
      const actor = withSelectedPlayer(state, action.playerId);
      return {
        ...state,
        players: applyToLockedGroup(state.players, actor, (player) => setPosition(player, player.positionSec + action.deltaSec)),
      };
    }
    case 'tick': {
      return {
        ...state,
        players: state.players.map((player) => {
          if (!player.isPlaying) {
            return player;
          }

          const nextPosition = player.positionSec + action.deltaSec;
          if (nextPosition >= player.durationSec) {
            return { ...player, positionSec: player.durationSec, isPlaying: false };
          }

          return { ...player, positionSec: nextPosition };
        }),
      };
    }
    case 'sync-media-positions': {
      const positionMap = new Map(action.positions.map((entry) => [entry.playerId, entry.positionSec]));
      return {
        ...state,
        players: state.players.map((player) => {
          const nextPosition = positionMap.get(player.id);
          if (nextPosition === undefined) {
            return player;
          }

          return {
            ...player,
            positionSec: clamp(nextPosition, 0, player.durationSec),
          };
        }),
      };
    }
    case 'toggle-lock': {
      return {
        ...state,
        players: state.players.map((player) => {
          if (player.id !== action.playerId) {
            return player;
          }

          if (!player.isLocked) {
            return {
              ...player,
              isLocked: true,
              positionSec: getMasterPosition(state.players),
              isPlaying: state.players.some((entry) => entry.isLocked && entry.isPlaying),
            };
          }

          return { ...player, isLocked: false };
        }),
      };
    }
    case 'set-lock-state': {
      return {
        ...state,
        players: state.players.map((player) => {
          if (player.id !== action.playerId || player.isLocked === action.isLocked) {
            return player;
          }

          if (action.isLocked) {
            return {
              ...player,
              isLocked: true,
              positionSec: getMasterPosition(state.players),
              isPlaying: state.players.some((entry) => entry.isLocked && entry.isPlaying),
            };
          }

          return { ...player, isLocked: false };
        }),
      };
    }
    case 'set-mix-mode': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId ? { ...player, mixMode: action.mixMode } : player,
        ),
      };
    }
    case 'set-active-stem': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId ? { ...player, activeStemId: action.stemId } : player,
        ),
      };
    }
    case 'set-line-color': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId ? { ...player, lineColor: action.lineColor } : player,
        ),
      };
    }
    case 'set-line-width': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? { ...player, lineWidth: clamp(action.lineWidth, 0.5, 1.5) }
            : player,
        ),
      };
    }
    case 'set-opacity': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId ? { ...player, opacity: clamp(action.opacity, 0.1, 1) } : player,
        ),
      };
    }
    case 'set-z-index': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId ? { ...player, zIndex: clamp(action.zIndex, 1, 8) } : player,
        ),
      };
    }
    case 'set-layer-size': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? {
                ...player,
                width: clampLayerWidth(action.width ?? player.width),
                height: clampLayerHeight(action.height ?? player.height),
              }
            : player,
        ),
      };
    }
    case 'nudge-layer-size': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? {
                ...player,
                width: clampLayerWidth(player.width + (action.deltaWidth ?? 0)),
                height: clampLayerHeight(player.height + (action.deltaHeight ?? 0)),
              }
            : player,
        ),
      };
    }
    case 'set-layer-position': {
      return {
        ...state,
        players: state.players.map((player) =>
          player.id === action.playerId
            ? {
                ...player,
                offsetX: clamp(action.offsetX, -120, 220),
                offsetY: clamp(action.offsetY, -80, 220),
              }
            : player,
        ),
      };
    }
    case 'set-time-scale':
      return { ...state, timeScaleSec: action.timeScaleSec };
    case 'set-pitch-range':
      return { ...state, pitchRangeSemitones: action.pitchRangeSemitones };
    case 'set-pitch-stem-preference':
      return { ...state, pitchStemPreferenceId: action.stemId };
    case 'set-pitch-center-mode':
      return { ...state, pitchCenterMode: action.pitchCenterMode };
    case 'select-player':
      return { ...state, selectedPlayerId: action.playerId };
    default:
      return state;
  }
};

export const formatClock = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
};

export const midiToNoteLabel = (midi: number) => {
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rounded = Math.round(midi);
  const note = notes[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${note}${octave}`;
};