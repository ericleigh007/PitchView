import type { PitchAnalysisSourceKind, PlayerLayer, WorkspaceProject } from "./types";

const PROJECT_STORAGE_KEY = "pitchview.workspace.v2";
const DEFAULT_STAGE_WIDTH = 1280;
const DEFAULT_STAGE_HEIGHT = 920;

export type ImportTarget = "selected" | "synced" | "all";

export type ImportedMedia = {
  label: string;
  originalInputPath?: string | null;
  sourceUrl: string;
  sourcePath?: string | null;
  duration?: number;
  displaySourceUrl?: string | null;
  displaySourcePath?: string | null;
  recentFilePath?: string | null;
  analysisCachePath?: string | null;
  availableSources?: PlayerLayer["availableSources"];
  mediaKind: PlayerLayer["mediaKind"];
  amplitudeEnvelope: number[];
  pitchContour: number[];
  pitchConfidence: number[];
  analysisSourceKind?: PitchAnalysisSourceKind;
  analysisState: PlayerLayer["analysisState"];
  analysisNote: string;
};

export function createDefaultProject(): WorkspaceProject {
  const layers = tileLayers(createDefaultLayers(), DEFAULT_STAGE_WIDTH, DEFAULT_STAGE_HEIGHT);

  return {
    selectedLayerId: layers[0].id,
    masterTime: 0,
    recentFiles: [],
    stemSeparatorModel: "HTDemucs FT",
    pitchDetectorModel: "yin",
    pitchAnalysisSource: "vocals",
    processingDevice: "auto",
    bypassPreprocessingCache: false,
    layers
  };
}

export function createDefaultLayers(count = 4): PlayerLayer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `layer-${index + 1}`,
    name: `Player ${index + 1}`,
    mediaLabel: "No media loaded",
    originalInputPath: null,
    mediaSourceUrl: null,
    sourcePath: null,
    displaySourceUrl: null,
    displaySourcePath: null,
    analysisCachePath: null,
    availableSources: [{
      kind: "original",
      label: "Original",
      path: null,
      url: null
    }],
    mediaKind: "none",
    x: 40 + index * 32,
    y: 40 + index * 24,
    width: 360,
    height: 520,
    opacity: 0.9,
    zIndex: index + 1,
    syncLocked: true,
    visible: true,
    mixMode: "blend",
    playbackPosition: 0,
    duration: 0,
    isPlaying: false,
    stemTarget: "original",
    preferredPitchSource: "vocals",
    analysisSourceKind: "original",
    pitchSpan: 24,
    pitchContourColor: "#7fe6ff",
    pitchContourWidth: 0.35,
    pitchContourIntensity: 0.85,
    pitchCenterMode: "adaptive",
    pitchCenterOffset: 0,
    pitchKey: "C",
    pitchScaleMode: "chromatic",
    amplitudeEnvelope: [],
    pitchContour: [],
    pitchConfidence: [],
    analysisState: "idle",
    analysisNote: "Import media to generate amplitude and pitch analysis."
  }));
}

export function tileLayers(layers: PlayerLayer[], stageWidth: number, stageHeight: number): PlayerLayer[] {
  const columns = Math.max(1, layers.length);
  const rows = 1;
  const gap = 16;
  const width = Math.floor((stageWidth - gap * (columns + 1)) / columns);
  const height = Math.floor((stageHeight - gap * (rows + 1)) / rows);

  return layers.map((layer, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);

    return {
      ...layer,
      x: gap + column * (width + gap),
      y: gap + row * (height + gap),
      width,
      height,
      zIndex: index + 1
    };
  });
}

export function selectLayer(project: WorkspaceProject, layerId: string): WorkspaceProject {
  return {
    ...project,
    selectedLayerId: layerId
  };
}

export function updateLayer(project: WorkspaceProject, layerId: string, patch: Partial<PlayerLayer>): WorkspaceProject {
  return {
    ...project,
    layers: project.layers.map((layer) => layer.id === layerId ? { ...layer, ...patch } : layer)
  };
}

export function getImportTargetLayerIds(project: WorkspaceProject, target: ImportTarget): string[] {
  if (target === "selected") {
    return [project.selectedLayerId];
  }

  if (target === "synced") {
    return project.layers.filter((layer) => layer.syncLocked).map((layer) => layer.id);
  }

  return project.layers.map((layer) => layer.id);
}

export function assignImportedMedia(
  project: WorkspaceProject,
  target: ImportTarget,
  mediaItems: ImportedMedia[]
): WorkspaceProject {
  const targetIds = getImportTargetLayerIds(project, target);

  return assignImportedMediaToLayerIds(project, targetIds, mediaItems);
}

export function assignImportedMediaToLayerIds(
  project: WorkspaceProject,
  targetIds: string[],
  mediaItems: ImportedMedia[]
): WorkspaceProject {
  const validTargetIds = targetIds.filter((layerId, index, ids) => ids.indexOf(layerId) === index);

  if (!validTargetIds.length || !mediaItems.length) {
    return project;
  }

  const assignments = new Map<string, ImportedMedia>();

  validTargetIds.forEach((layerId, index) => {
    const mediaItem = mediaItems[index] ?? mediaItems[0];
    assignments.set(layerId, mediaItem);
  });

  return {
    ...project,
    recentFiles: [
      ...new Set([
        ...mediaItems.map((item) => item.recentFilePath ?? item.sourcePath).filter((value): value is string => Boolean(value)),
        ...project.recentFiles
      ])
    ].slice(0, 12),
    layers: project.layers.map((layer) => {
      const media = assignments.get(layer.id);

      if (!media) {
        return layer;
      }

      return {
        ...layer,
        mediaLabel: media.label,
        originalInputPath: media.originalInputPath ?? media.recentFilePath ?? media.sourcePath ?? null,
        mediaSourceUrl: media.sourceUrl,
        sourcePath: media.sourcePath ?? null,
        displaySourceUrl: media.displaySourceUrl ?? media.sourceUrl,
        displaySourcePath: media.displaySourcePath ?? media.sourcePath ?? null,
        analysisCachePath: media.analysisCachePath ?? null,
        availableSources: media.availableSources ?? [{
          kind: "original",
          label: media.label,
          path: media.sourcePath ?? null,
          url: media.sourceUrl
        }],
        mediaKind: media.mediaKind,
        playbackPosition: 0,
        duration: media.duration ?? 0,
        isPlaying: false,
        preferredPitchSource: media.analysisSourceKind ?? layer.preferredPitchSource,
        analysisSourceKind: media.analysisSourceKind ?? layer.analysisSourceKind,
        amplitudeEnvelope: media.amplitudeEnvelope,
        pitchContour: media.pitchContour,
        pitchConfidence: media.pitchConfidence,
        analysisState: media.analysisState,
        analysisNote: media.analysisNote
      };
    })
  };
}

export function getPlaybackTargetLayerIds(project: WorkspaceProject, layerId: string): string[] {
  const sourceLayer = project.layers.find((layer) => layer.id === layerId);

  if (!sourceLayer) {
    return [];
  }

  if (!sourceLayer.syncLocked) {
    return [layerId];
  }

  return project.layers.filter((layer) => layer.syncLocked).map((layer) => layer.id);
}

export function setLayersPlaying(project: WorkspaceProject, layerIds: string[], isPlaying: boolean): WorkspaceProject {
  const idSet = new Set(layerIds);

  return {
    ...project,
    layers: project.layers.map((layer) => idSet.has(layer.id) ? { ...layer, isPlaying } : layer)
  };
}

export function seekLayers(project: WorkspaceProject, layerIds: string[], playbackPosition: number): WorkspaceProject {
  const idSet = new Set(layerIds);

  return {
    ...project,
    masterTime: playbackPosition,
    layers: project.layers.map((layer) => idSet.has(layer.id)
      ? { ...layer, playbackPosition, isPlaying: false }
      : layer)
  };
}

export function updateLayerTime(
  project: WorkspaceProject,
  layerId: string,
  playbackPosition: number,
  duration?: number
): WorkspaceProject {
  const sourceLayer = project.layers.find((layer) => layer.id === layerId);

  if (!sourceLayer) {
    return project;
  }

  return {
    ...project,
    masterTime: sourceLayer.syncLocked ? playbackPosition : project.masterTime,
    layers: project.layers.map((layer) => layer.id === layerId
      ? {
        ...layer,
        playbackPosition,
        duration: duration ?? layer.duration
      }
      : layer)
  };
}

export function selectLayerSource(
  project: WorkspaceProject,
  layerId: string,
  sourceKind: PlayerLayer["availableSources"][number]["kind"]
): WorkspaceProject {
  return {
    ...project,
    layers: project.layers.map((layer) => {
      if (layer.id !== layerId) {
        return layer;
      }

      const source = layer.availableSources.find((entry) => entry.kind === sourceKind);
      if (!source) {
        return layer;
      }

      return {
        ...layer,
        stemTarget: source.kind === "vocals" ? "vocals" : source.kind === "other" ? "other" : "original",
        mediaSourceUrl: source.url,
        sourcePath: source.path,
        displaySourceUrl: layer.mediaKind === "video" ? layer.displaySourceUrl : source.url,
        displaySourcePath: layer.mediaKind === "video" ? layer.displaySourcePath : source.path,
        mediaLabel: source.label
      };
    })
  };
}

export function addLayer(project: WorkspaceProject): WorkspaceProject {
  const nextIndex = project.layers.length + 1;
  const layer = createDefaultLayers(nextIndex).at(-1);

  if (!layer) {
    return project;
  }

  return {
    ...project,
    layers: [...project.layers, {
      ...layer,
      x: 48 + project.layers.length * 24,
      y: 48 + project.layers.length * 24,
      zIndex: nextIndex
    }]
  };
}

export function removeLayer(project: WorkspaceProject, layerId: string): WorkspaceProject {
  if (project.layers.length <= 1) {
    return project;
  }

  const layers = project.layers.filter((layer) => layer.id !== layerId);
  const nextSelectedLayerId = project.selectedLayerId === layerId ? layers[0].id : project.selectedLayerId;

  return {
    ...project,
    selectedLayerId: nextSelectedLayerId,
    layers: layers.map((layer, index) => ({
      ...layer,
      zIndex: index + 1
    }))
  };
}

export function removeSelectedLayer(project: WorkspaceProject): WorkspaceProject {
  return removeLayer(project, project.selectedLayerId);
}

export function bringLayerToFront(project: WorkspaceProject, layerId: string): WorkspaceProject {
  const layers = [...project.layers].sort((left, right) => left.zIndex - right.zIndex);
  const index = layers.findIndex((layer) => layer.id === layerId);

  if (index < 0 || index === layers.length - 1) {
    return project;
  }

  const [layer] = layers.splice(index, 1);
  layers.push(layer);

  return {
    ...project,
    layers: layers.map((entry, currentIndex) => ({
      ...entry,
      zIndex: currentIndex + 1
    }))
  };
}

export function moveLayer(project: WorkspaceProject, layerId: string, direction: "forward" | "backward"): WorkspaceProject {
  const layers = [...project.layers].sort((left, right) => left.zIndex - right.zIndex);
  const index = layers.findIndex((layer) => layer.id === layerId);

  if (index < 0) {
    return project;
  }

  const targetIndex = direction === "forward"
    ? Math.min(layers.length - 1, index + 1)
    : Math.max(0, index - 1);

  if (targetIndex === index) {
    return project;
  }

  const [layer] = layers.splice(index, 1);
  layers.splice(targetIndex, 0, layer);

  return {
    ...project,
    layers: layers.map((entry, currentIndex) => ({
      ...entry,
      zIndex: currentIndex + 1
    }))
  };
}

export function saveProject(project: WorkspaceProject): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
}

export function hydrateProject(project: WorkspaceProject): WorkspaceProject {
  const defaults = createDefaultProject();
  const layerDefaults = createDefaultLayers(project.layers.length || defaults.layers.length);

  return {
    ...defaults,
    ...project,
    recentFiles: project.recentFiles ?? [],
    layers: (project.layers?.length ? project.layers : defaults.layers).map((layer, index) => ({
      ...layerDefaults[index],
      ...layer
    }))
  };
}

export function loadProject(): WorkspaceProject {
  if (typeof window === "undefined") {
    return createDefaultProject();
  }

  const rawProject = window.localStorage.getItem(PROJECT_STORAGE_KEY);

  if (!rawProject) {
    return createDefaultProject();
  }

  try {
    const parsed = JSON.parse(rawProject) as WorkspaceProject;

    if (!parsed.layers?.length) {
      return createDefaultProject();
    }

    return hydrateProject(parsed);
  } catch {
    return createDefaultProject();
  }
}
