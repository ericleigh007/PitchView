import { useEffect, useRef, useReducer, useState } from 'react';
import { PitchGraph } from './components/PitchGraph';
import { TransportPanel } from './components/TransportPanel';
import { initialState } from './lib/data';
import { analyzePitchFromMediaSource } from './lib/pitchAnalysis';
import { buildPreprocessPlan } from './lib/preprocessPlan';
import { classifyGeneratedStemFile } from './lib/stemFiles';
import { defaultStemModelId, stemModelProfiles } from './lib/stemModels';
import { appReducer, formatClock, getAudibleState, getMasterPosition } from './lib/sync';
import { convertLocalFileToAssetUrl, detectPreprocessBackends, pickMediaFile, runPreprocessJob } from './lib/tauriPreprocess';
import type { PlayerState, StemTrack, TransportAction } from './lib/types';

const timeScaleOptions = [0.1, 0.5, 1, 2, 5, 10];
const pitchRangeOptions = [12, 18, 24, 36];
const DEMO_DURATION_MS = 21000;
const mixModeOptions = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'solo', label: 'Solo' },
  { value: 'muted', label: 'Muted' },
] as const;

const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'm4a', 'aiff', 'aif', 'ogg', 'opus']);
const PREPROCESS_PHASES = ['select', 'import', 'separate', 'attach', 'done'] as const;
type PreprocessPhaseId = (typeof PREPROCESS_PHASES)[number];
type PreprocessStatus = {
  state: 'idle' | 'running' | 'done' | 'error';
  phase: PreprocessPhaseId;
  message: string;
};

type DebugLogEntry = {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
};

const basename = (value: string) => value.split(/[/\\]/).pop() ?? value;
const extensionOf = (value: string) => basename(value).split('.').pop()?.toLowerCase() ?? 'unknown';
const sanitizePathToken = (value: string) => value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

const inferMediaKindFromPath = (value: string) => (AUDIO_EXTENSIONS.has(extensionOf(value)) ? 'audio' : 'video');
const isAbsoluteNativePath = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');

const resolveBrowserSelectedPath = (file: File & { path?: string }, fallbackPath: string) => {
  const filePath = typeof file.path === 'string' ? file.path.trim() : '';
  if (isAbsoluteNativePath(filePath)) {
    return filePath;
  }

  const trimmedFallback = fallbackPath.trim();
  return isAbsoluteNativePath(trimmedFallback) ? trimmedFallback : '';
};

const buildImportOutputDir = (sourcePath: string) => {
  const fileStem = basename(sourcePath).replace(/\.[^.]+$/, '');
  return `sample/out/imported/${sanitizePathToken(fileStem) || 'media'}`;
};

const mapOutputFilesToStems = async (outputFiles: string[]): Promise<StemTrack[]> => {
  const stems: StemTrack[] = [];

  for (const outputFile of outputFiles) {
    const stemDescriptor = classifyGeneratedStemFile(outputFile);
    const id = stemDescriptor?.id ?? null;
    const label = stemDescriptor?.label ?? basename(outputFile);

    if (!id || stems.some((stem) => stem.id === id)) {
      continue;
    }

    stems.push({
      id,
      label,
      status: 'generated',
      sourceUrl: await convertLocalFileToAssetUrl(outputFile),
    });
  }

  return stems;
};

const resolvePitchStem = (player: PlayerState, preferredStemId: string): StemTrack => {
  return (
    player.availableStems.find((stem) => stem.id === preferredStemId && stem.sourceUrl) ??
    player.availableStems.find((stem) => stem.id === 'original' && stem.sourceUrl) ??
    {
      id: 'original',
      label: 'Original mix',
      status: 'source',
      sourceUrl: player.mediaSourceUrl,
    }
  );
};

const getPlaybackTargetIds = (players: PlayerState[], playerId: string) => {
  const actor = players.find((player) => player.id === playerId) ?? players[0];
  if (!actor) {
    return [] as string[];
  }

  return actor.isLocked ? players.filter((player) => player.isLocked).map((player) => player.id) : [actor.id];
};

const getPitchStatusLabel = (pitchStatus: PlayerState['pitchStatus']) => {
  if (pitchStatus === 'loading') {
    return 'Analyzing';
  }

  if (pitchStatus === 'error') {
    return 'Unavailable';
  }

  if (pitchStatus === 'ready') {
    return 'Ready';
  }

  return 'Pending';
};

const hasPitchCoverageGap = (player: PlayerState, pitchSourceUrl: string) => {
  if (player.pitchSourceUrl !== pitchSourceUrl || player.pitchStatus !== 'ready' || player.pitchPoints.length === 0) {
    return false;
  }

  const lastPitchTimeSec = player.pitchPoints[player.pitchPoints.length - 1]?.timeSec ?? 0;
  return player.durationSec - lastPitchTimeSec > 5;
};

const getAdaptiveMidiCenter = (player: PlayerState, focusTimeSec: number, timeScaleSec: number) => {
  const visibleMidis = player.pitchPoints
    .filter(
      (point) =>
        point.midi !== null &&
        point.confidence >= 0.14 &&
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

const describeWorkerFailure = (result: {
  result?: string;
  stderr?: string;
  stdout?: string;
  returnCode?: unknown;
  outputFiles?: unknown;
  resolvedModelFile?: string | null;
}) => {
  if (result.stderr && result.stderr.trim().length > 0) {
    return result.stderr.trim();
  }

  const outputCount = Array.isArray(result.outputFiles) ? result.outputFiles.length : 0;
  const returnCode = typeof result.returnCode === 'number' ? result.returnCode : 'unknown';
  const modelFile = result.resolvedModelFile ? ` Model: ${result.resolvedModelFile}.` : '';
  return `Stem job failed with return code ${returnCode} and ${outputCount} output files.${modelFile}`;
};

const formatDebugData = (data?: unknown) => {
  if (data === undefined) {
    return '';
  }

  if (typeof data === 'string') {
    return data;
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
};

const resolvePreprocessSourcePath = (players: PlayerState[], targetPlayerIds: string[], importSourcePath: string) => {
  const trimmedImportPath = importSourcePath.trim();
  if (isAbsoluteNativePath(trimmedImportPath)) {
    return trimmedImportPath;
  }

  const targetPlayers = players.filter((player) => targetPlayerIds.includes(player.id));
  const nativePaths = Array.from(
    new Set(
      targetPlayers
        .map((player) => player.mediaSourcePath)
        .filter((path): path is string => typeof path === 'string' && isAbsoluteNativePath(path)),
    ),
  );

  if (nativePaths.length === 1) {
    return nativePaths[0];
  }

  return null;
};

type DemoStep = {
  atMs: number;
  title: string;
  run: (dispatch: React.Dispatch<TransportAction>) => void;
};

const DEMO_STEPS: DemoStep[] = [
  {
    atMs: 0,
    title: 'Reset scene to the baseline sync layout',
    run: (dispatch) => {
      dispatch({ type: 'select-player', playerId: 'lead' });
      dispatch({ type: 'set-time-scale', timeScaleSec: 5 });
      dispatch({ type: 'set-pitch-range', pitchRangeSemitones: 18 });

      dispatch({ type: 'set-lock-state', playerId: 'lead', isLocked: true });
      dispatch({ type: 'set-lock-state', playerId: 'harmony', isLocked: true });
      dispatch({ type: 'set-lock-state', playerId: 'guitar', isLocked: false });

      dispatch({ type: 'set-playing-state', playerId: 'lead', isPlaying: false });
      dispatch({ type: 'set-playing-state', playerId: 'harmony', isPlaying: false });
      dispatch({ type: 'set-playing-state', playerId: 'guitar', isPlaying: false });

      dispatch({ type: 'seek', playerId: 'lead', positionSec: 18.4 });
      dispatch({ type: 'seek', playerId: 'guitar', positionSec: 11.2 });

      dispatch({ type: 'set-mix-mode', playerId: 'lead', mixMode: 'solo' });
      dispatch({ type: 'set-mix-mode', playerId: 'harmony', mixMode: 'mixed' });
      dispatch({ type: 'set-mix-mode', playerId: 'guitar', mixMode: 'muted' });

      dispatch({ type: 'set-active-stem', playerId: 'lead', stemId: 'original' });
      dispatch({ type: 'set-active-stem', playerId: 'harmony', stemId: 'original' });
      dispatch({ type: 'set-active-stem', playerId: 'guitar', stemId: 'original' });

      dispatch({ type: 'set-opacity', playerId: 'lead', opacity: 0.9 });
      dispatch({ type: 'set-opacity', playerId: 'harmony', opacity: 0.62 });
      dispatch({ type: 'set-opacity', playerId: 'guitar', opacity: 0.45 });

      dispatch({ type: 'set-z-index', playerId: 'lead', zIndex: 3 });
      dispatch({ type: 'set-z-index', playerId: 'harmony', zIndex: 2 });
      dispatch({ type: 'set-z-index', playerId: 'guitar', zIndex: 1 });

      dispatch({ type: 'set-line-width', playerId: 'lead', lineWidth: 1 });
      dispatch({ type: 'set-line-width', playerId: 'harmony', lineWidth: 0.9 });
      dispatch({ type: 'set-line-width', playerId: 'guitar', lineWidth: 0.9 });

      dispatch({ type: 'set-layer-position', playerId: 'lead', offsetX: 0, offsetY: 0 });
      dispatch({ type: 'set-layer-position', playerId: 'harmony', offsetX: 44, offsetY: 30 });
      dispatch({ type: 'set-layer-position', playerId: 'guitar', offsetX: 88, offsetY: 58 });
    },
  },
  {
    atMs: 900,
    title: 'Start synced playback for the locked tracks',
    run: (dispatch) => {
      dispatch({ type: 'set-playing-state', playerId: 'lead', isPlaying: true });
      dispatch({ type: 'set-playing-state', playerId: 'harmony', isPlaying: true });
    },
  },
  {
    atMs: 3200,
    title: 'Lower harmony opacity and stack its contour over the lead',
    run: (dispatch) => {
      dispatch({ type: 'select-player', playerId: 'harmony' });
      dispatch({ type: 'set-opacity', playerId: 'harmony', opacity: 0.35 });
      dispatch({ type: 'set-line-width', playerId: 'harmony', lineWidth: 1.2 });
      dispatch({ type: 'set-layer-position', playerId: 'harmony', offsetX: 12, offsetY: 10 });
    },
  },
  {
    atMs: 5600,
    title: 'Zoom the graph to a tighter time and pitch window',
    run: (dispatch) => {
      dispatch({ type: 'set-time-scale', timeScaleSec: 1 });
      dispatch({ type: 'set-pitch-range', pitchRangeSemitones: 12 });
    },
  },
  {
    atMs: 8200,
    title: 'Free the guide track and offset it independently',
    run: (dispatch) => {
      dispatch({ type: 'select-player', playerId: 'guitar' });
      dispatch({ type: 'set-lock-state', playerId: 'guitar', isLocked: false });
      dispatch({ type: 'seek', playerId: 'guitar', positionSec: 14.8 });
      dispatch({ type: 'set-playing-state', playerId: 'guitar', isPlaying: true });
      dispatch({ type: 'set-opacity', playerId: 'guitar', opacity: 0.72 });
      dispatch({ type: 'set-layer-position', playerId: 'guitar', offsetX: 126, offsetY: 24 });
    },
  },
  {
    atMs: 11000,
    title: 'Switch the mix and preview planned stem changes',
    run: (dispatch) => {
      dispatch({ type: 'set-mix-mode', playerId: 'lead', mixMode: 'mixed' });
      dispatch({ type: 'set-mix-mode', playerId: 'harmony', mixMode: 'mixed' });
      dispatch({ type: 'set-mix-mode', playerId: 'guitar', mixMode: 'solo' });
      dispatch({ type: 'set-active-stem', playerId: 'lead', stemId: 'vocals' });
      dispatch({ type: 'set-active-stem', playerId: 'guitar', stemId: 'other' });
    },
  },
  {
    atMs: 13600,
    title: 'Relock the guide and drive the full sync group together',
    run: (dispatch) => {
      dispatch({ type: 'set-lock-state', playerId: 'guitar', isLocked: true });
      dispatch({ type: 'seek', playerId: 'lead', positionSec: 23.6 });
      dispatch({ type: 'set-layer-position', playerId: 'guitar', offsetX: 34, offsetY: 42 });
      dispatch({ type: 'set-opacity', playerId: 'guitar', opacity: 0.4 });
      dispatch({ type: 'set-mix-mode', playerId: 'lead', mixMode: 'solo' });
      dispatch({ type: 'set-mix-mode', playerId: 'guitar', mixMode: 'muted' });
      dispatch({ type: 'set-active-stem', playerId: 'lead', stemId: 'original' });
      dispatch({ type: 'set-active-stem', playerId: 'guitar', stemId: 'original' });
    },
  },
  {
    atMs: 16800,
    title: 'Widen the view again for final verification',
    run: (dispatch) => {
      dispatch({ type: 'select-player', playerId: 'lead' });
      dispatch({ type: 'set-time-scale', timeScaleSec: 10 });
      dispatch({ type: 'set-pitch-range', pitchRangeSemitones: 24 });
      dispatch({ type: 'set-opacity', playerId: 'harmony', opacity: 0.58 });
      dispatch({ type: 'set-layer-position', playerId: 'harmony', offsetX: 30, offsetY: 18 });
    },
  },
  {
    atMs: 19600,
    title: 'Hold the final state before the demo loops',
    run: (dispatch) => {
      dispatch({ type: 'set-playing-state', playerId: 'lead', isPlaying: false });
      dispatch({ type: 'set-playing-state', playerId: 'harmony', isPlaying: false });
      dispatch({ type: 'set-playing-state', playerId: 'guitar', isPlaying: false });
    },
  },
];

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [dragState, setDragState] = useState<{
    playerId: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoScene, setDemoScene] = useState('Demo idle');
  const [demoLoopCount, setDemoLoopCount] = useState(0);
  const [demoElapsedMs, setDemoElapsedMs] = useState(0);
  const [selectedStemModelId, setSelectedStemModelId] = useState(defaultStemModelId);
  const [importTargetPlayerIds, setImportTargetPlayerIds] = useState(initialState.players.map((player) => player.id));
  const [importSourcePath, setImportSourcePath] = useState('');
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [preprocessStatus, setPreprocessStatus] = useState<PreprocessStatus>({
    state: 'idle',
    phase: 'select',
    message: 'Desktop preprocessing idle',
  });
  const demoCycleStartRef = useRef<number | null>(null);
  const demoStepIndexRef = useRef(0);
  const analysisRequestsRef = useRef(new Set<string>());
  const selectedPlayer = state.players.find((player) => player.id === state.selectedPlayerId) ?? state.players[0];
  const selectedStemModel = stemModelProfiles.find((model) => model.id === selectedStemModelId) ?? stemModelProfiles[0];
  const preprocessPlan = buildPreprocessPlan(selectedStemModel);
  const masterPosition = getMasterPosition(state.players);
  const anyPlaying = state.players.some((player) => player.isPlaying);
  const selectedPitchStem = resolvePitchStem(selectedPlayer, state.pitchStemPreferenceId);
  const preprocessPhaseIndex = PREPROCESS_PHASES.indexOf(preprocessStatus.phase);
  const preprocessProgressPercent = preprocessStatus.state === 'idle' ? 0 : ((preprocessPhaseIndex + 1) / PREPROCESS_PHASES.length) * 100;

  const pushDebugLog = (level: DebugLogEntry['level'], message: string, data?: unknown) => {
    const detail = formatDebugData(data);
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      level,
      message: detail ? `${message} ${detail}` : message,
    };

    setDebugLogs((current) => [...current.slice(-39), entry]);
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    consoleMethod(`[PitchView] ${entry.timestamp} ${entry.message}`);
  };

  const handleTogglePlay = (playerId: string) => {
    const actor = state.players.find((player) => player.id === playerId) ?? state.players[0];
    if (!actor) {
      return;
    }

    const nextIsPlaying = !actor.isPlaying;
    const targetPlayerIds = getPlaybackTargetIds(state.players, playerId);
    pushDebugLog('info', nextIsPlaying ? 'Starting playback from transport control.' : 'Pausing playback from transport control.', {
      playerId,
      targetPlayerIds,
    });

    const hasSolo = state.players.some((entry) => entry.mixMode === 'solo');

    for (const targetPlayerId of targetPlayerIds) {
      const player = state.players.find((entry) => entry.id === targetPlayerId);
      if (!player) {
        continue;
      }

      const videoElement = videoRefs.current[targetPlayerId];
      const audioElement = audioRefs.current[targetPlayerId];
      const activeStem = player.availableStems.find((stem) => stem.id === player.activeStemId);
      const desiredAudioSourceUrl = activeStem?.sourceUrl ?? player.mediaSourceUrl;
      const shouldSuppress = hasSolo ? player.mixMode !== 'solo' : player.mixMode === 'muted';

      if (videoElement) {
        videoElement.muted = true;
        videoElement.defaultMuted = true;
      }

      if (audioElement) {
        if (audioElement.src !== desiredAudioSourceUrl) {
          audioElement.src = desiredAudioSourceUrl;
          audioElement.load();
        }

        audioElement.muted = shouldSuppress;
        audioElement.defaultMuted = shouldSuppress;
        audioElement.volume = shouldSuppress ? 0 : 1;
      }

      if (nextIsPlaying) {
        if (videoElement) {
          void videoElement.play().catch((error) => {
            pushDebugLog('error', 'Video playback failed to start.', {
              playerId: targetPlayerId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }

        if (audioElement && !shouldSuppress) {
          void audioElement.play().catch((error) => {
            pushDebugLog('error', 'Stem audio playback failed to start.', {
              playerId: targetPlayerId,
              sourceUrl: desiredAudioSourceUrl,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } else {
        videoElement?.pause();
        audioElement?.pause();
      }
    }

    dispatch({ type: 'toggle-play', playerId });
  };

  useEffect(() => {
    if (!anyPlaying) {
      return undefined;
    }

    let animationFrame = 0;

    const syncFromMediaClock = () => {
      const lockedPlayingPlayers = state.players.filter((player) => player.isLocked && player.isPlaying);
      const masterLockedPlayer = lockedPlayingPlayers[0];
      const masterElement = masterLockedPlayer ? videoRefs.current[masterLockedPlayer.id] : null;
      const masterPositionSec = masterElement ? masterElement.currentTime : null;
      const positions: Array<{ playerId: string; positionSec: number }> = [];

      for (const player of state.players) {
        if (!player.isPlaying) {
          continue;
        }

        if (player.isLocked && masterPositionSec !== null) {
          positions.push({ playerId: player.id, positionSec: masterPositionSec });
          continue;
        }

        const element = videoRefs.current[player.id];
        if (element) {
          positions.push({ playerId: player.id, positionSec: element.currentTime });
        }
      }

      if (positions.length > 0) {
        dispatch({ type: 'sync-media-positions', positions });
      }

      animationFrame = window.requestAnimationFrame(syncFromMediaClock);
    };

    animationFrame = window.requestAnimationFrame(syncFromMediaClock);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [anyPlaying, state.players]);

  useEffect(() => {
    const hasSolo = state.players.some((entry) => entry.mixMode === 'solo');

    for (const player of state.players) {
      const element = videoRefs.current[player.id];
      const audioElement = audioRefs.current[player.id];
      const activeStem = player.availableStems.find((stem) => stem.id === player.activeStemId);
      const desiredAudioSourceUrl = activeStem?.sourceUrl ?? player.mediaSourceUrl;
      if (!element) {
        continue;
      }

      const positionDelta = Math.abs(element.currentTime - player.positionSec);
      if (positionDelta > (player.isPlaying ? 0.2 : 0.05)) {
        element.currentTime = player.positionSec;
      }

      const shouldSuppress = hasSolo ? player.mixMode !== 'solo' : player.mixMode === 'muted';
      element.muted = true;
      element.defaultMuted = true;
      element.dataset.mixState = shouldSuppress ? 'suppressed' : player.mixMode;

      if (audioElement) {
        if (audioElement.src !== desiredAudioSourceUrl) {
          audioElement.src = desiredAudioSourceUrl;
          audioElement.load();
        }

        const audioPositionDelta = Math.abs(audioElement.currentTime - player.positionSec);
        if (audioPositionDelta > (player.isPlaying ? 0.2 : 0.05)) {
          audioElement.currentTime = player.positionSec;
        }

        audioElement.muted = shouldSuppress;
        audioElement.defaultMuted = shouldSuppress;
        audioElement.volume = shouldSuppress ? 0 : 1;

        if (player.isPlaying && audioElement.paused) {
          void audioElement.play().catch(() => undefined);
        }

        if (!player.isPlaying && !audioElement.paused) {
          audioElement.pause();
        }
      }

      if (player.isPlaying && element.paused) {
        void element.play().catch(() => undefined);
      }

      if (!player.isPlaying && !element.paused) {
        element.pause();
      }
    }
  }, [state.players]);

  useEffect(() => {
    const sourceGroups = new Map<string, string[]>();

    for (const player of state.players) {
      const pitchStem = resolvePitchStem(player, state.pitchStemPreferenceId);
      const pitchSourceUrl = pitchStem.sourceUrl ?? player.mediaSourceUrl;
      if (!pitchSourceUrl) {
        continue;
      }

      if (
        player.pitchSourceUrl === pitchSourceUrl &&
        (player.pitchStatus === 'loading' || (player.pitchStatus === 'ready' && !hasPitchCoverageGap(player, pitchSourceUrl)))
      ) {
        continue;
      }

      const existing = sourceGroups.get(pitchSourceUrl) ?? [];
      existing.push(player.id);
      sourceGroups.set(pitchSourceUrl, existing);
    }

    for (const [pitchSourceUrl, playerIds] of sourceGroups) {
      if (analysisRequestsRef.current.has(pitchSourceUrl)) {
        continue;
      }

      analysisRequestsRef.current.add(pitchSourceUrl);
      for (const playerId of playerIds) {
        dispatch({ type: 'set-pitch-status', playerId, pitchStatus: 'loading', pitchSourceUrl });
      }

      void analyzePitchFromMediaSource(pitchSourceUrl)
        .then((pitchPoints) => {
          for (const playerId of playerIds) {
            dispatch({ type: 'set-pitch-points', playerId, pitchPoints, pitchSourceUrl });
          }
        })
        .catch(() => {
          for (const playerId of playerIds) {
            dispatch({ type: 'set-pitch-status', playerId, pitchStatus: 'error', pitchSourceUrl });
          }
        })
        .finally(() => {
          analysisRequestsRef.current.delete(pitchSourceUrl);
        });
    }
  }, [state.pitchStemPreferenceId, state.players]);

  useEffect(() => {
    if (!demoRunning) {
      return undefined;
    }

    let animationFrame = 0;

    const tickDemo = (timestamp: number) => {
      if (demoCycleStartRef.current === null) {
        demoCycleStartRef.current = timestamp;
        demoStepIndexRef.current = 0;
        setDemoScene(DEMO_STEPS[0].title);
        DEMO_STEPS[0].run(dispatch);
      }

      const elapsed = timestamp - demoCycleStartRef.current;
      setDemoElapsedMs(Math.min(elapsed, DEMO_DURATION_MS));

      while (
        demoStepIndexRef.current + 1 < DEMO_STEPS.length &&
        elapsed >= DEMO_STEPS[demoStepIndexRef.current + 1].atMs
      ) {
        demoStepIndexRef.current += 1;
        const step = DEMO_STEPS[demoStepIndexRef.current];
        setDemoScene(step.title);
        step.run(dispatch);
      }

      if (elapsed >= DEMO_DURATION_MS) {
        demoCycleStartRef.current = timestamp;
        demoStepIndexRef.current = 0;
        setDemoElapsedMs(0);
        setDemoLoopCount((count) => count + 1);
        setDemoScene(DEMO_STEPS[0].title);
        DEMO_STEPS[0].run(dispatch);
      }

      animationFrame = window.requestAnimationFrame(tickDemo);
    };

    animationFrame = window.requestAnimationFrame(tickDemo);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [demoRunning, dispatch]);

  const stackedPlayers = [...state.players].sort((left, right) => left.zIndex - right.zIndex);

  const restartDemo = () => {
    demoCycleStartRef.current = performance.now();
    demoStepIndexRef.current = 0;
    setDemoLoopCount(1);
    setDemoElapsedMs(0);
    setDemoScene(DEMO_STEPS[0].title);
    DEMO_STEPS[0].run(dispatch);
    setDemoRunning(true);
  };

  const toggleDemoPlayback = () => {
    if (demoRunning) {
      setDemoRunning(false);
      return;
    }

    if (demoLoopCount === 0 && demoElapsedMs === 0) {
      restartDemo();
      return;
    }

    demoCycleStartRef.current = performance.now() - demoElapsedMs;
    setDemoRunning(true);
  };

  const toggleImportTarget = (playerId: string) => {
    setImportTargetPlayerIds((current) => {
      if (current.includes(playerId)) {
        return current.filter((entry) => entry !== playerId);
      }

      return [...current, playerId];
    });
  };

  const selectAllImportTargets = () => {
    setImportTargetPlayerIds(state.players.map((player) => player.id));
  };

  const setPhase = (phase: PreprocessPhaseId, message: string, stateValue: PreprocessStatus['state'] = 'running') => {
    setPreprocessStatus({ state: stateValue, phase, message });
  };

  const importPlayersFromPath = async (sourcePath: string) => {
    const targetPlayerIds = importTargetPlayerIds.length > 0 ? importTargetPlayerIds : state.players.map((player) => player.id);
    const mediaKind = inferMediaKindFromPath(sourcePath);
    const extension = extensionOf(sourcePath);
    const mediaSourceUrl = await convertLocalFileToAssetUrl(sourcePath);

    pushDebugLog('info', 'Importing native source path into players.', {
      sourcePath,
      targetPlayerIds,
      mediaKind,
      extension,
    });

    dispatch({
      type: 'replace-media-for-players',
      playerIds: targetPlayerIds,
      sourceLabel: basename(sourcePath),
      mediaSourceUrl,
      mediaSourcePath: sourcePath,
      mediaKind,
      audioCodec: mediaKind === 'audio' ? extension : 'unknown-audio',
      videoCodec: mediaKind === 'video' ? extension : undefined,
    });

    setDemoRunning(false);
    setDemoScene(`Imported ${basename(sourcePath)}`);
    setImportSourcePath(sourcePath);
    return targetPlayerIds;
  };

  const handleBrowseImport = async () => {
    pushDebugLog('info', 'Opening native file picker.');
    try {
      const selection = await pickMediaFile();
      if (selection) {
        setImportSourcePath(selection);
        pushDebugLog('info', 'Native file picker returned selection.', { selection });
        setPhase('import', `Importing ${basename(selection)}...`);
        await importPlayersFromPath(selection);
        setPreprocessStatus({ state: 'done', phase: 'import', message: `Imported ${basename(selection)}` });
        return;
      }

      pushDebugLog('info', 'Native file picker was canceled.');
    } catch (error) {
      pushDebugLog('error', 'Native import failed.', error instanceof Error ? error.message : error);
      setPreprocessStatus({
        state: 'error',
        phase: 'select',
        message: error instanceof Error ? error.message : 'Failed to open the native file picker',
      });
    }
  };

  const handleBrowserImportButtonClick = () => {
    pushDebugLog('info', 'Opening browser file picker.');
    importInputRef.current?.click();
  };

  const handlePathImport = async () => {
    if (!importSourcePath.trim()) {
      pushDebugLog('warn', 'Import Path clicked without a path.');
      setPreprocessStatus({ state: 'error', phase: 'select', message: 'Enter a local media path first.' });
      return;
    }

    try {
      pushDebugLog('info', 'Importing from path field.', { sourcePath: importSourcePath.trim() });
      setPhase('import', `Importing ${basename(importSourcePath.trim())}...`);
      await importPlayersFromPath(importSourcePath.trim());
      setPreprocessStatus({ state: 'done', phase: 'import', message: `Imported ${basename(importSourcePath.trim())}` });
    } catch (error) {
      pushDebugLog('error', 'Path import failed.', error instanceof Error ? error.message : error);
      setPreprocessStatus({
        state: 'error',
        phase: 'import',
        message: error instanceof Error ? error.message : 'Failed to import source path',
      });
    }
  };

  const handleImportAndPreprocess = async () => {
    const targetPlayerIds = importTargetPlayerIds.length > 0 ? importTargetPlayerIds : state.players.map((player) => player.id);
    const sourcePath = resolvePreprocessSourcePath(state.players, targetPlayerIds, importSourcePath);
    pushDebugLog('info', 'Resolving preprocess source path.', {
      importSourcePath,
      targetPlayerIds,
      resolvedSourcePath: sourcePath,
      selectedPlayerSourcePaths: state.players
        .filter((player) => targetPlayerIds.includes(player.id))
        .map((player) => ({ playerId: player.id, mediaSourcePath: player.mediaSourcePath })),
    });
    if (!sourcePath) {
      pushDebugLog('warn', 'No usable native source path was available for preprocess.');
      setPreprocessStatus({
        state: 'error',
        phase: 'select',
        message:
          'Stem generation needs a real native file path. Use Browse Native, or import a single native source into the selected players before generating stems.',
      });
      return;
    }

    setPhase('import', `Importing ${basename(sourcePath)}...`);

    try {
      const importedTargetPlayerIds = await importPlayersFromPath(sourcePath);
      const outputDir = buildImportOutputDir(sourcePath);
      const backends = await detectPreprocessBackends();
      pushDebugLog('info', 'Backend detection returned.', backends);
      const selectedBackendReady =
        preprocessPlan.backend === 'audio_separator'
          ? backends.audio_separator && backends.onnxruntime
          : preprocessPlan.backend === 'demucs'
            ? backends.demucs
            : preprocessPlan.backend === 'spleeter'
              ? backends.spleeter
              : backends.openunmix;

      if (!selectedBackendReady) {
        pushDebugLog('error', 'Selected backend is not ready for preprocess.', {
          backend: preprocessPlan.backend,
          backends,
        });
        setPreprocessStatus({
          state: 'error',
          phase: 'separate',
          message:
            preprocessPlan.backend === 'audio_separator' && backends.audio_separator && !backends.onnxruntime
              ? 'The current Tauri session found audio_separator but is missing onnxruntime. Relaunch with launch-tauri.bat so the app uses the fully provisioned venv.'
              : 'The current Tauri session is using a Python interpreter without the selected stem backend. Relaunch with PITCHVIEW_PYTHON set to the working venv or use launch-tauri.bat.',
        });
        return;
      }

      setPhase('separate', `Running ${selectedStemModel.label} on ${basename(sourcePath)}...`);
      const result = await runPreprocessJob({
        source: sourcePath,
        outputDir,
        modelId: selectedStemModel.id,
      });
      pushDebugLog('info', 'Worker returned preprocess result.', result);

      const outputFiles = Array.isArray(result.outputFiles) ? result.outputFiles.filter((value): value is string => typeof value === 'string') : [];
      setPhase('attach', `Attaching generated stems for ${basename(sourcePath)}...`);
      const generatedStems = await mapOutputFilesToStems(outputFiles);
      pushDebugLog('info', 'Mapped generated stems from output files.', { outputFiles, generatedStems });

      if (generatedStems.length > 0) {
        dispatch({ type: 'set-generated-stems', playerIds: importedTargetPlayerIds, stems: generatedStems });
      }

      setPreprocessStatus({
        state: result.result === 'completed' ? 'done' : 'error',
        phase: result.result === 'completed' ? 'done' : 'separate',
        message:
          result.result === 'completed'
            ? `Generated ${generatedStems.map((stem) => stem.label).join(', ') || 'no stems'} for ${basename(sourcePath)}`
            : describeWorkerFailure(result),
      });
    } catch (error) {
      pushDebugLog('error', 'Preprocess threw an exception.', error instanceof Error ? error.message : error);
      setPreprocessStatus({
        state: 'error',
        phase: 'separate',
        message: error instanceof Error ? error.message : 'Preprocess failed',
      });
    }
  };

  const handleLayerPointerDown = (playerId: string, clientX: number, clientY: number, pointerId: number) => {
    const player = state.players.find((entry) => entry.id === playerId);
    if (!player) {
      return;
    }

    dispatch({ type: 'select-player', playerId });
    setDragState({
      playerId,
      pointerId,
      startX: clientX,
      startY: clientY,
      originX: player.offsetX,
      originY: player.offsetY,
    });
  };

  const handleLayerPointerMove = (clientX: number, clientY: number, pointerId: number) => {
    if (!dragState || dragState.pointerId !== pointerId) {
      return;
    }

    dispatch({
      type: 'set-layer-position',
      playerId: dragState.playerId,
      offsetX: dragState.originX + (clientX - dragState.startX),
      offsetY: dragState.originY + (clientY - dragState.startY),
    });
  };

  const handleLayerPointerUp = (pointerId: number) => {
    if (!dragState || dragState.pointerId !== pointerId) {
      return;
    }

    setDragState(null);
  };

  const handleImportButtonClick = () => {
    void handleBrowseImport();
  };

  const handleImportMediaChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const extension = file.name.split('.').pop()?.toLowerCase() ?? 'unknown';
    const mediaKind = file.type.startsWith('audio/') ? 'audio' : 'video';
    const targetPlayerIds = importTargetPlayerIds.length > 0 ? importTargetPlayerIds : state.players.map((player) => player.id);
    const browserSelectedPath = resolveBrowserSelectedPath(file, importSourcePath);

    pushDebugLog('info', 'Browser file picker returned selection.', {
      name: file.name,
      type: file.type,
      browserSelectedPath: browserSelectedPath || null,
      targetPlayerIds,
    });

    dispatch({
      type: 'replace-media-for-players',
      playerIds: targetPlayerIds,
      sourceLabel: file.name,
      mediaSourceUrl: objectUrl,
      mediaSourcePath: null,
      mediaKind,
      audioCodec: mediaKind === 'audio' ? extension : 'unknown-audio',
      videoCodec: mediaKind === 'video' ? extension : undefined,
    });

    setDemoRunning(false);
    setDemoScene(`Imported ${file.name}`);
    setImportSourcePath(browserSelectedPath);
    setPreprocessStatus({
      state: 'done',
      phase: 'import',
      message: browserSelectedPath
        ? `Imported ${file.name} from browser picker.`
        : `Imported ${file.name} from browser picker. Use Browse Native for stem generation.`,
    });
    event.currentTarget.value = '';
  };

  return (
    <main className="app-shell">
      <section className="hero panel">
        <div>
          <p className="eyebrow">PitchView MVP Slice</p>
          <h1>Audio-only and transparent-video players with per-player pitch overlays</h1>
          <p className="hero__lede">
            Each player can now represent either an audio-only source or a video source. Transparent video layers can be
            stacked and dragged for comparison, while audio-only sources still render their own pitch overlay and take
            part in the same sync and mix workflow.
          </p>
        </div>

        <div className="hero__metrics">
          <div>
            <span>Master Time</span>
            <strong>{formatClock(masterPosition)}</strong>
          </div>
          <div>
            <span>Visible Window</span>
            <strong>{state.timeScaleSec.toFixed(1)}s</strong>
          </div>
          <div>
            <span>Pitch Span</span>
            <strong>{state.pitchRangeSemitones} st</strong>
          </div>
          <div>
            <span>Pitch Source</span>
            <strong>{selectedPitchStem.label}</strong>
          </div>
          <div>
            <span>Pitch Center</span>
            <strong>{state.pitchCenterMode}</strong>
          </div>
        </div>
      </section>

      <section className="panel demo-panel">
        <div>
          <p className="eyebrow">Autoplay Demo</p>
          <h2>{demoScene}</h2>
          <p className="demo-panel__lede">
            This scripted loop drives the real transport, sync, mix, opacity, zoom, and stacking state so the demo can
            be started when needed and reused as a verification pass. The current build leaves autoplay off so manual
            work starts in a stable state.
          </p>
        </div>
        <div className="demo-panel__meta">
          <span>Loop {demoLoopCount}</span>
          <span>{(demoElapsedMs / 1000).toFixed(1)}s / {(DEMO_DURATION_MS / 1000).toFixed(0)}s</span>
          <span>{demoRunning ? 'running' : demoLoopCount > 0 ? 'paused' : 'idle'}</span>
          <span>sample-backed playback</span>
        </div>
        <div className="demo-panel__actions">
          <button className="chip chip--active" onClick={toggleDemoPlayback}>
            {demoRunning ? 'Pause Demo' : demoLoopCount > 0 ? 'Resume Demo' : 'Start Demo'}
          </button>
          <button className="chip" onClick={restartDemo}>Restart Demo</button>
          <button className="chip" onClick={handleBrowserImportButtonClick}>Browse Media</button>
          <input ref={importInputRef} className="visually-hidden" type="file" accept="audio/*,video/*" onChange={handleImportMediaChange} />
        </div>
        <div className="demo-panel__target-grid">
          <span className="demo-panel__target-label">Import Targets</span>
          <button className={importTargetPlayerIds.length === state.players.length ? 'chip chip--active' : 'chip'} onClick={selectAllImportTargets}>
            All Players
          </button>
          {state.players.map((player) => (
            <button
              key={player.id}
              className={importTargetPlayerIds.includes(player.id) ? 'chip chip--active' : 'chip'}
              onClick={() => toggleImportTarget(player.id)}
            >
              {player.name}
            </button>
          ))}
        </div>
        <div className="demo-panel__path-row">
          <label className="controls-panel__select demo-panel__path-input">
            <span>Desktop source path</span>
            <input value={importSourcePath} onChange={(event) => setImportSourcePath(event.currentTarget.value)} placeholder="C:\\media\\take01.mov" />
          </label>
          <button className="chip" onClick={handleImportButtonClick}>Browse Native</button>
          <button className="chip" onClick={() => void handlePathImport()}>Import Path</button>
          <button className="chip" onClick={() => void handleImportAndPreprocess()} disabled={preprocessStatus.state === 'running'}>
            {preprocessStatus.state === 'running' ? 'Generating…' : 'Import + Generate Stems'}
          </button>
        </div>
        <div className="demo-panel__meta demo-panel__meta--status">
          <span>{preprocessStatus.state}</span>
          <span>{preprocessStatus.phase}</span>
          <span>{preprocessStatus.message}</span>
        </div>
        <div className="demo-panel__progress demo-panel__progress--preprocess">
          <div style={{ width: `${preprocessProgressPercent}%` }} />
        </div>
        <div className="demo-panel__log" aria-live="polite">
          {debugLogs.length === 0 ? <div className="demo-panel__log-line">No debug events yet.</div> : null}
          {debugLogs.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className={`demo-panel__log-line demo-panel__log-line--${entry.level}`}>
              <strong>{entry.timestamp}</strong> {entry.message}
            </div>
          ))}
        </div>
        <div className="demo-panel__phase-strip" role="list" aria-label="Preprocess phases">
          {PREPROCESS_PHASES.map((phase, index) => {
            const isComplete = index < preprocessPhaseIndex || preprocessStatus.state === 'done';
            const isActive = phase === preprocessStatus.phase && preprocessStatus.state === 'running';
            const isError = phase === preprocessStatus.phase && preprocessStatus.state === 'error';
            return (
              <span
                key={phase}
                role="listitem"
                className={`demo-panel__phase ${isComplete ? 'is-complete' : ''} ${isActive ? 'is-active' : ''} ${isError ? 'is-error' : ''}`.trim()}
              >
                {phase}
              </span>
            );
          })}
        </div>
        <div className="demo-panel__progress">
          <div style={{ width: `${(demoElapsedMs / DEMO_DURATION_MS) * 100}%` }} />
        </div>
      </section>

      <section className="panel model-panel">
        <div>
          <p className="eyebrow">Stem Models</p>
          <h2>{selectedStemModel.label}</h2>
          <p className="demo-panel__lede">
            Stem separation is driven by a selected AI model. FFmpeg is only used for media decode, normalization, and
              container handling around that model pipeline. In the desktop shell, a local file path can now import and
              run the worker directly for the selected players.
          </p>
        </div>
        <div className="model-panel__controls">
          <label>
            <span>Preprocess Model</span>
            <select value={selectedStemModelId} onChange={(event) => setSelectedStemModelId(event.currentTarget.value)}>
              {stemModelProfiles.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · {model.quality}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="model-panel__grid">
          <div>
            <span>Family</span>
            <strong>{selectedStemModel.family}</strong>
          </div>
          <div>
            <span>Quality</span>
            <strong>{selectedStemModel.quality}</strong>
          </div>
          <div>
            <span>Strengths</span>
            <strong>{selectedStemModel.strengths}</strong>
          </div>
          <div>
            <span>Constraints</span>
            <strong>{selectedStemModel.constraints}</strong>
          </div>
          <div>
            <span>Output Plan</span>
            <strong>{selectedStemModel.output}</strong>
          </div>
          <div>
            <span>Execution Backend</span>
            <strong>{preprocessPlan.backend}</strong>
          </div>
          <div>
            <span>Install Hint</span>
            <strong>{preprocessPlan.installHint}</strong>
          </div>
          <div>
            <span>Expected Outputs</span>
            <strong>{preprocessPlan.expectedOutputs.join(', ')}</strong>
          </div>
          <div>
            <span>Command Preview</span>
            <strong>{preprocessPlan.commandPreview}</strong>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <section className="panel stage-panel workspace-grid__full">
          <div className="stage-panel__header">
            <div>
              <p className="eyebrow">Layer Stack</p>
              <h2>Stack transparent video or audio-first players and compare pitch alignment</h2>
            </div>
            <p className="stage-panel__note">
                The stage now keeps metadata out of the graph area. Pitch overlays follow the preferred stem setting,
                defaulting to vocals when that stem is available.
            </p>
          </div>

          <div className="video-stage">
            {stackedPlayers.map((player) => {
              const { audible, emphasis } = getAudibleState(state.players, player.id);
              const focusTimeSec = player.isLocked ? masterPosition : player.positionSec;
              const pitchStem = resolvePitchStem(player, state.pitchStemPreferenceId);
              const midiCenter = state.pitchCenterMode === 'adaptive' ? getAdaptiveMidiCenter(player, focusTimeSec, state.timeScaleSec) : 60;
              return (
                <div
                  key={player.id}
                  className={`video-layer ${selectedPlayer.id === player.id ? 'video-layer--selected' : ''}`}
                  onPointerDown={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest('[data-layer-control="true"]')) {
                      return;
                    }

                    event.currentTarget.setPointerCapture(event.pointerId);
                    handleLayerPointerDown(player.id, event.clientX, event.clientY, event.pointerId);
                  }}
                  onPointerMove={(event) => handleLayerPointerMove(event.clientX, event.clientY, event.pointerId)}
                  onPointerUp={(event) => handleLayerPointerUp(event.pointerId)}
                  onPointerCancel={(event) => handleLayerPointerUp(event.pointerId)}
                  style={{
                    zIndex: player.zIndex,
                    opacity: player.opacity,
                    width: player.width,
                    height: player.height,
                    borderColor: player.lineColor,
                    boxShadow: `0 0 0 1px ${player.lineColor}33, 0 32px 80px ${player.lineColor}25`,
                    transform: `translate(${player.offsetX}px, ${player.offsetY}px)`,
                  }}
                >
                  <video
                    ref={(element) => {
                      videoRefs.current[player.id] = element;
                    }}
                    className="video-layer__media"
                    src={player.mediaSourceUrl}
                    preload="auto"
                    playsInline
                    muted
                    onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration;
                      if (Number.isFinite(duration) && duration > 0) {
                        dispatch({ type: 'set-duration', playerId: player.id, durationSec: duration });
                      }
                    }}
                  />
                  <audio
                    ref={(element) => {
                      audioRefs.current[player.id] = element;
                    }}
                    preload="auto"
                    hidden
                  />
                  <div className="video-layer__badge">Layer {player.zIndex}</div>
                  <div className="video-layer__hud" data-layer-control="true">
                    <button
                      className="video-layer__tag video-layer__tag--button"
                      onClick={() => dispatch({ type: 'select-player', playerId: player.id })}
                    >
                      {player.name}
                    </button>
                    <span className="video-layer__tag">Pitch: {pitchStem.label}</span>
                    <span className="video-layer__tag">{getPitchStatusLabel(player.pitchStatus)}</span>
                    <span className="video-layer__tag">{audible ? player.mixMode : 'suppressed'}</span>
                    <details className="video-layer__menu" data-layer-control="true">
                      <summary className="video-layer__tag video-layer__tag--button">Controls</summary>
                      <div className="video-layer__menu-panel">
                        <label>
                          <span>Stem</span>
                          <select
                            value={player.activeStemId}
                            onChange={(event) =>
                              dispatch({ type: 'set-active-stem', playerId: player.id, stemId: event.currentTarget.value })
                            }
                          >
                            {player.availableStems.map((stem) => (
                              <option key={stem.id} value={stem.id}>
                                {stem.label}
                                {stem.status === 'planned' ? ' (planned)' : stem.status === 'generated' ? ' (ready)' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Mix</span>
                          <select
                            value={player.mixMode}
                            onChange={(event) =>
                              dispatch({
                                type: 'set-mix-mode',
                                playerId: player.id,
                                mixMode: event.currentTarget.value as PlayerState['mixMode'],
                              })
                            }
                          >
                            {mixModeOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Opacity</span>
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={player.opacity}
                            onChange={(event) =>
                              dispatch({ type: 'set-opacity', playerId: player.id, opacity: Number(event.currentTarget.value) })
                            }
                          />
                        </label>
                        <label>
                          <span>Line Width</span>
                          <input
                            type="range"
                            min={0.5}
                            max={1.5}
                            step={0.05}
                            value={player.lineWidth}
                            onChange={(event) =>
                              dispatch({ type: 'set-line-width', playerId: player.id, lineWidth: Number(event.currentTarget.value) })
                            }
                          />
                        </label>
                        <label>
                          <span>Line Color</span>
                          <input
                            type="color"
                            value={player.lineColor}
                            onChange={(event) =>
                              dispatch({ type: 'set-line-color', playerId: player.id, lineColor: event.currentTarget.value })
                            }
                          />
                        </label>
                        <div className="video-layer__menu-actions">
                          <button onClick={() => dispatch({ type: 'toggle-lock', playerId: player.id })}>
                            {player.isLocked ? 'Unlock Layer' : 'Lock To Group'}
                          </button>
                          <button
                            onClick={() =>
                              dispatch({ type: 'set-layer-size', playerId: player.id, width: 1120, height: 680 })
                            }
                          >
                            Reset Size
                          </button>
                        </div>
                      </div>
                    </details>
                  </div>
                  <div className="video-layer__overlay-shell">
                    <PitchGraph
                      player={player}
                      focusTimeSec={focusTimeSec}
                      timeScaleSec={state.timeScaleSec}
                      pitchRangeSemitones={state.pitchRangeSemitones}
                      midiCenter={midiCenter}
                      emphasis={emphasis}
                    />
                  </div>
                  <div className="video-layer__transport" data-layer-control="true">
                    <button onClick={() => dispatch({ type: 'stop', playerId: player.id })}>Stop</button>
                    <button onClick={() => dispatch({ type: 'skip', playerId: player.id, deltaSec: -1 })}>-1s</button>
                    <button onClick={() => handleTogglePlay(player.id)}>{player.isPlaying ? 'Pause' : 'Play'}</button>
                    <button onClick={() => dispatch({ type: 'skip', playerId: player.id, deltaSec: 1 })}>+1s</button>
                    <span className="video-layer__transport-time">{formatClock(player.positionSec)}</span>
                    <input
                      className="video-layer__scrub"
                      type="range"
                      min={0}
                      max={player.durationSec}
                      step={0.01}
                      value={player.positionSec}
                      onChange={(event) =>
                        dispatch({ type: 'seek', playerId: player.id, positionSec: Number(event.currentTarget.value) })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </section>

      <section className="panel controls-panel">
        <div className="controls-panel__block">
          <p className="eyebrow">Time Scale</p>
          <div className="chip-row">
            {timeScaleOptions.map((option) => (
              <button
                key={option}
                className={state.timeScaleSec === option ? 'chip chip--active' : 'chip'}
                onClick={() => dispatch({ type: 'set-time-scale', timeScaleSec: option })}
              >
                {option.toFixed(option < 1 ? 1 : 0)}s
              </button>
            ))}
          </div>
        </div>

        <div className="controls-panel__block">
          <p className="eyebrow">Pitch Span</p>
          <div className="chip-row">
            {pitchRangeOptions.map((option) => (
              <button
                key={option}
                className={state.pitchRangeSemitones === option ? 'chip chip--active' : 'chip'}
                onClick={() => dispatch({ type: 'set-pitch-range', pitchRangeSemitones: option })}
              >
                {option} st
              </button>
            ))}
          </div>
        </div>

        <div className="controls-panel__block">
          <p className="eyebrow">Pitch Stem</p>
          <label className="controls-panel__select">
            <span>Graph source</span>
            <select
              value={state.pitchStemPreferenceId}
              onChange={(event) => dispatch({ type: 'set-pitch-stem-preference', stemId: event.currentTarget.value })}
            >
              <option value="vocals">Separated vocals</option>
              <option value="original">Original mix</option>
              <option value="other">Other stem</option>
            </select>
          </label>
        </div>

        <div className="controls-panel__block">
          <p className="eyebrow">Pitch Center</p>
          <label className="controls-panel__select">
            <span>Vertical focus</span>
            <select
              value={state.pitchCenterMode}
              onChange={(event) =>
                dispatch({ type: 'set-pitch-center-mode', pitchCenterMode: event.currentTarget.value as 'fixed' | 'adaptive' })
              }
            >
              <option value="adaptive">Adaptive to visible singer range</option>
              <option value="fixed">Fixed around C4</option>
            </select>
          </label>
        </div>
      </section>

      <section className="transport-grid">
        {state.players.map((player) => (
          <TransportPanel
            key={player.id}
            player={player}
            players={state.players}
            dispatch={dispatch}
            selected={selectedPlayer.id === player.id}
            onTogglePlay={handleTogglePlay}
          />
        ))}
      </section>
    </main>
  );
}