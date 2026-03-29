export type PitchCenterMode = "adaptive" | "fixed";

export type MixMode = "blend" | "solo" | "mute";

export type MediaKind = "none" | "audio" | "video";

export type AnalysisState = "idle" | "pending" | "ready" | "error";

export type LayerSourceKind = "original" | "normalized" | "vocals" | "other";

export type PitchAnalysisSourceKind = "original" | "vocals" | "other";

export type ProcessingDeviceMode = "auto" | "gpu" | "cpu";

export type LayerSource = {
  kind: LayerSourceKind;
  label: string;
  path: string | null;
  url: string | null;
};

export type PlayerLayer = {
  id: string;
  name: string;
  mediaLabel: string;
  originalInputPath: string | null;
  mediaSourceUrl: string | null;
  sourcePath: string | null;
  displaySourceUrl: string | null;
  displaySourcePath: string | null;
  analysisCachePath: string | null;
  availableSources: LayerSource[];
  mediaKind: MediaKind;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  zIndex: number;
  syncLocked: boolean;
  visible: boolean;
  mixMode: MixMode;
  playbackPosition: number;
  duration: number;
  isPlaying: boolean;
  stemTarget: "original" | "vocals" | "other";
  preferredPitchSource: PitchAnalysisSourceKind;
  analysisSourceKind: PitchAnalysisSourceKind;
  pitchSpan: number;
  pitchContourColor: string;
  pitchContourWidth: number;
  pitchContourIntensity: number;
  pitchCenterMode: PitchCenterMode;
  pitchCenterOffset: number;
  amplitudeEnvelope: number[];
  pitchContour: number[];
  pitchConfidence: number[];
  analysisState: AnalysisState;
  analysisNote: string;
};

export type WorkspaceProject = {
  selectedLayerId: string;
  masterTime: number;
  recentFiles: string[];
  stemSeparatorModel: string;
  pitchDetectorModel: string;
  pitchAnalysisSource: PitchAnalysisSourceKind;
  processingDevice: ProcessingDeviceMode;
  bypassPreprocessingCache: boolean;
  layers: PlayerLayer[];
};
