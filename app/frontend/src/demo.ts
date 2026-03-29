import type { WorkspaceProject } from "./types";
import { createDefaultProject, tileLayers } from "./workspace";

export function createDemoProject(stageWidth: number, stageHeight: number): WorkspaceProject {
  const project = createDefaultProject();
  const demoLayers = tileLayers(project.layers, stageWidth, stageHeight).map((layer, index) => ({
    ...layer,
    mediaLabel: `Demo Take ${index + 1}`,
    duration: 18 + index * 4,
    playbackPosition: index * 0.75,
    amplitudeEnvelope: Array.from({ length: 64 }, (_, point) => Number((0.2 + Math.abs(Math.sin((point + index * 6) / 7)) * 0.8).toFixed(4))),
    pitchContour: Array.from({ length: 48 }, (_, point) => Number((220 * Math.pow(2, (Math.sin((point + index * 4) / 8) * 3 + index) / 12)).toFixed(3))),
    pitchConfidence: Array.from({ length: 48 }, () => 0.97),
    analysisState: "ready" as const,
    analysisNote: "Demo contour with stable, deglitched pitch display for synchronization verification.",
    sourcePath: `demo/take-${index + 1}.wav`,
    analysisCachePath: `demo/take-${index + 1}.json`,
    availableSources: [
      {
        kind: "original" as const,
        label: `Demo Take ${index + 1}`,
        path: `demo/take-${index + 1}.wav`,
        url: null
      },
      {
        kind: "vocals" as const,
        label: `Demo Vocals ${index + 1}`,
        path: `demo/take-${index + 1}-vocals.wav`,
        url: null
      }
    ]
  }));

  return {
    ...project,
    masterTime: 6.25,
    recentFiles: demoLayers.map((layer) => layer.sourcePath!).slice(0, 4),
    layers: demoLayers
  };
}
