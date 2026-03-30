import { describe, expect, test } from "vitest";
import {
  addLayer,
  assignImportedMedia,
  bringLayerToFront,
  createDefaultProject,
  getImportTargetLayerIds,
  moveLayer,
  seekLayers,
  selectLayerSource,
  selectLayer,
  tileLayers,
  updateLayer
} from "./workspace";

describe("workspace model", () => {
  test("creates four default layers and selects the first layer", () => {
    const project = createDefaultProject();

    expect(project.layers).toHaveLength(4);
    expect(project.selectedLayerId).toBe("layer-1");
  });

  test("tiles layers into evenly spaced horizontal columns across the stage", () => {
    const project = createDefaultProject();
    const tiledLayers = tileLayers(project.layers, 1280, 920);

    expect(tiledLayers[0].x).toBeLessThan(tiledLayers[1].x);
    expect(tiledLayers[0].y).toBe(tiledLayers[1].y);
    expect(tiledLayers[2].y).toBe(tiledLayers[0].y);
    expect(tiledLayers[3].x).toBeGreaterThan(tiledLayers[2].x);
    expect(tiledLayers[0].height).toBeGreaterThan(800);
  });

  test("updates the selected layer state", () => {
    const project = createDefaultProject();
    const selected = selectLayer(project, "layer-3");
    const updated = updateLayer(selected, "layer-3", { pitchSpan: 36, syncLocked: false });

    expect(updated.selectedLayerId).toBe("layer-3");
    expect(updated.layers.find((layer) => layer.id === "layer-3")).toMatchObject({
      pitchSpan: 36,
      syncLocked: false
    });
  });

  test("moves a layer forward in z-order", () => {
    const project = createDefaultProject();
    const moved = moveLayer(project, "layer-1", "forward");
    const ordered = moved.layers.slice().sort((left, right) => left.zIndex - right.zIndex);

    expect(ordered[1].id).toBe("layer-1");
  });

  test("brings a layer to the front while preserving relative order for the others", () => {
    const project = createDefaultProject();
    const reordered = bringLayerToFront(project, "layer-2");
    const ordered = reordered.layers.slice().sort((left, right) => left.zIndex - right.zIndex);

    expect(ordered.at(-1)?.id).toBe("layer-2");
    expect(ordered.slice(0, 3).map((layer) => layer.id)).toEqual(["layer-1", "layer-3", "layer-4"]);
  });

  test("targets synced or all layers during import", () => {
    const project = updateLayer(createDefaultProject(), "layer-2", { syncLocked: false });

    expect(getImportTargetLayerIds(project, "selected")).toEqual([project.selectedLayerId]);
    expect(getImportTargetLayerIds(project, "synced")).toEqual(["layer-1", "layer-3", "layer-4"]);
    expect(getImportTargetLayerIds(project, "all")).toHaveLength(4);
  });

  test("assigns imported media to the selected target layers", () => {
    const project = createDefaultProject();
    const updated = assignImportedMedia(project, "selected", [{
      label: "take-1.wav",
      originalInputPath: "C:/source/take-1.wav",
      sourceUrl: "blob://take-1",
      sourcePath: "C:/media/take-1.wav",
      recentFilePath: "C:/source/take-1.wav",
      analysisCachePath: "C:/cache/take-1.json",
      mediaKind: "audio",
      amplitudeEnvelope: [0.2, 0.4],
      pitchContour: [220, 221],
      pitchConfidence: [0.9, 0.9],
      analysisState: "ready",
      analysisNote: "leveled"
    }]);

    expect(updated.layers[0]).toMatchObject({
      mediaLabel: "take-1.wav",
      originalInputPath: "C:/source/take-1.wav",
      mediaSourceUrl: "blob://take-1",
      sourcePath: "C:/media/take-1.wav",
      analysisState: "ready"
    });
    expect(updated.recentFiles[0]).toBe("C:/source/take-1.wav");
  });

  test("uses explicit playback and display sources when desktop preprocessing provides them", () => {
    const project = createDefaultProject();
    const updated = assignImportedMedia(project, "selected", [{
      label: "clip.mp4",
      originalInputPath: "C:/media/clip.mp4",
      sourceUrl: "file://C:/cache/playback.wav",
      sourcePath: "C:/cache/playback.wav",
      displaySourceUrl: "file://C:/cache/display.mp4",
      displaySourcePath: "C:/cache/display.mp4",
      recentFilePath: "C:/media/clip.mp4",
      analysisCachePath: "C:/cache/clip.json",
      mediaKind: "video",
      amplitudeEnvelope: [0.2],
      pitchContour: [220],
      pitchConfidence: [0.9],
      analysisState: "ready",
      analysisNote: "ready"
    }]);

    expect(updated.layers[0]).toMatchObject({
      originalInputPath: "C:/media/clip.mp4",
      mediaSourceUrl: "file://C:/cache/playback.wav",
      sourcePath: "C:/cache/playback.wav",
      displaySourceUrl: "file://C:/cache/display.mp4",
      displaySourcePath: "C:/cache/display.mp4"
    });
    expect(updated.recentFiles[0]).toBe("C:/media/clip.mp4");
  });

  test("adds a layer and seeks the synced group together", () => {
    const project = addLayer(createDefaultProject());
    const sought = seekLayers(project, ["layer-1", "layer-2"], 12.5);

    expect(project.layers).toHaveLength(5);
    expect(sought.masterTime).toBe(12.5);
    expect(sought.layers[0].playbackPosition).toBe(12.5);
    expect(sought.layers[1].playbackPosition).toBe(12.5);
  });

  test("keeps the original video display source while switching playback to a stem", () => {
    const project = assignImportedMedia(createDefaultProject(), "selected", [{
      label: "clip.mp4",
      sourceUrl: "file://clip.mp4",
      sourcePath: "C:/media/clip.mp4",
      analysisCachePath: "C:/cache/clip.json",
      mediaKind: "video",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.mp4", url: "file://clip.mp4" },
        { kind: "vocals", label: "Vocals", path: "C:/cache/vocals.wav", url: "file://vocals.wav" }
      ],
      amplitudeEnvelope: [0.2],
      pitchContour: [220],
      pitchConfidence: [0.9],
      analysisState: "ready",
      analysisNote: "ready"
    }]);

    const updated = selectLayerSource(project, "layer-1", "vocals");

    expect(updated.layers[0].mediaSourceUrl).toBe("file://vocals.wav");
    expect(updated.layers[0].displaySourceUrl).toBe("file://clip.mp4");
    expect(updated.layers[0].stemTarget).toBe("vocals");
  });
});
