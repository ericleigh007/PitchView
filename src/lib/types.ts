export type MixMode = 'mixed' | 'muted' | 'solo';

export type MediaKind = 'audio' | 'video';

export type StemTrack = {
  id: string;
  label: string;
  status: 'source' | 'planned' | 'generated';
  sourceUrl?: string;
  sourcePath?: string | null;
};

export type PitchPoint = {
  timeSec: number;
  midi: number | null;
  confidence: number;
};

export type PitchAnalysisStatus = 'idle' | 'loading' | 'ready' | 'error';

export type PitchCenterMode = 'fixed' | 'adaptive';

export type PlayerState = {
  id: string;
  name: string;
  mediaKind: MediaKind;
  sourceLabel: string;
  mediaSourceUrl: string;
  mediaSourcePath: string | null;
  audioCodec: string;
  videoCodec?: string;
  supportsTransparency: boolean;
  availableStems: StemTrack[];
  activeStemId: string;
  pitchStatus: PitchAnalysisStatus;
  pitchSourceUrl: string | null;
  durationSec: number;
  positionSec: number;
  isPlaying: boolean;
  isLocked: boolean;
  mixMode: MixMode;
  lineColor: string;
  lineWidth: number;
  opacity: number;
  zIndex: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  pitchPoints: PitchPoint[];
};

export type AppState = {
  players: PlayerState[];
  timeScaleSec: number;
  pitchRangeSemitones: number;
  pitchStemPreferenceId: string;
  pitchCenterMode: PitchCenterMode;
  selectedPlayerId: string;
};

export type TransportAction =
  | { type: 'toggle-play'; playerId: string }
  | { type: 'set-playing-state'; playerId: string; isPlaying: boolean }
  | { type: 'set-duration'; playerId: string; durationSec: number }
  | {
      type: 'set-pitch-status';
      playerId: string;
      pitchStatus: PitchAnalysisStatus;
      pitchSourceUrl?: string | null;
    }
  | { type: 'set-pitch-points'; playerId: string; pitchPoints: PitchPoint[]; pitchSourceUrl: string }
  | {
      type: 'replace-media-for-players';
      playerIds: string[];
      sourceLabel: string;
      mediaSourceUrl: string;
      mediaSourcePath?: string | null;
      mediaKind: MediaKind;
      audioCodec: string;
      videoCodec?: string;
    }
  | { type: 'set-generated-stems'; playerIds: string[]; stems: StemTrack[] }
  | { type: 'stop'; playerId: string }
  | { type: 'seek'; playerId: string; positionSec: number }
  | { type: 'skip'; playerId: string; deltaSec: number }
  | { type: 'tick'; deltaSec: number }
  | { type: 'sync-media-positions'; positions: Array<{ playerId: string; positionSec: number }> }
  | { type: 'toggle-lock'; playerId: string }
  | { type: 'set-lock-state'; playerId: string; isLocked: boolean }
  | { type: 'set-mix-mode'; playerId: string; mixMode: MixMode }
  | { type: 'set-active-stem'; playerId: string; stemId: string }
  | { type: 'set-line-color'; playerId: string; lineColor: string }
  | { type: 'set-line-width'; playerId: string; lineWidth: number }
  | { type: 'set-opacity'; playerId: string; opacity: number }
  | { type: 'set-z-index'; playerId: string; zIndex: number }
  | { type: 'set-layer-size'; playerId: string; width?: number; height?: number }
  | { type: 'nudge-layer-size'; playerId: string; deltaWidth?: number; deltaHeight?: number }
  | { type: 'set-layer-position'; playerId: string; offsetX: number; offsetY: number }
  | { type: 'set-time-scale'; timeScaleSec: number }
  | { type: 'set-pitch-range'; pitchRangeSemitones: number }
  | { type: 'set-pitch-stem-preference'; stemId: string }
  | { type: 'set-pitch-center-mode'; pitchCenterMode: PitchCenterMode }
  | { type: 'select-player'; playerId: string };