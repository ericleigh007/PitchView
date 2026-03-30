import { type CSSProperties, type ChangeEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent, type UIEvent as ReactUIEvent, useEffect, useRef, useState } from "react";
import "./index.css";
import { analyzeAudioFile } from "./analysis";
import { createDemoProject } from "./demo";
import {
  analyzeDesktopMediaFiles,
  analyzeDesktopMediaFilesWithOptions,
  analyzeDesktopMediaFilesWithStems,
  appendDesktopDiagnosticsEntry,
  clearDesktopDiagnosticsLog,
  isDesktopHost,
  loadDesktopProject,
  pickDesktopMediaFiles,
  readDesktopDiagnosticsLog,
  saveDesktopProject,
  toDesktopMediaUrl,
  type DesktopAnalysisPayload
} from "./desktop";
import type { MusicalKey, PitchAnalysisSourceKind, PitchScaleMode, PlayerLayer, ProcessingDeviceMode } from "./types";
import {
  addLayer,
  assignImportedMedia,
  assignImportedMediaToLayerIds,
  bringLayerToFront,
  getImportTargetLayerIds,
  getPlaybackTargetLayerIds,
  hydrateProject,
  loadProject,
  moveLayer,
  removeLayer,
  removeSelectedLayer,
  saveProject,
  seekLayers,
  selectLayerSource,
  selectLayer,
  setLayersPlaying,
  tileLayers,
  updateLayer,
  updateLayerTime,
  type ImportTarget
} from "./workspace";

const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 920;
const PLAYBACK_POLL_INTERVAL_MS = 80;
const LAYER_MENU_WIDTH_PX = 288;
const LAYER_MENU_DOCK_GAP_PX = 12;
const PLAYER_TIMELINE_WINDOW_SECONDS = 8;
const PITCH_PLOT_HEIGHT = 84;
const MIN_LAYER_WIDTH = 240;
const MIN_LAYER_HEIGHT = 320;

const STEM_MODEL_OUTPUT_COUNTS: Record<string, number> = {
  "Vocals Mel-Band Roformer": 2,
  "HTDemucs FT": 2,
  "HTDemucs 6 Stem": 6,
  MDX23C: 2,
  "UVR MDX Karaoke": 2,
  "Spleeter 2 Stem": 2,
  "Open-Unmix": 2
};

function inferMediaKind(path: string): PlayerLayer["mediaKind"] {
  const normalized = path.toLowerCase();
  return /\.(mp4|mov|mkv|webm|avi)$/i.test(normalized) ? "video" : "audio";
}

function rebuildDesktopProjectUrls(project: ReturnType<typeof hydrateProject>) {
  return {
    ...project,
    layers: project.layers.map((layer) => ({
      ...layer,
      mediaSourceUrl: layer.sourcePath ? toDesktopMediaUrl(layer.sourcePath) : layer.mediaSourceUrl,
      displaySourceUrl: layer.displaySourcePath ? toDesktopMediaUrl(layer.displaySourcePath) : layer.displaySourceUrl,
      availableSources: layer.availableSources.map((source) => ({
        ...source,
        url: source.path ? toDesktopMediaUrl(source.path) : source.url
      }))
    }))
  };
}

function desktopAnalysisToImportPayload(payload: DesktopAnalysisPayload) {
  const mediaKind = payload.media_kind ?? inferMediaKind(payload.input);
  const playbackPath = payload.playback_audio ?? payload.sources.find((source) => source.kind === "original")?.path ?? payload.input;
  const displayPath = payload.display_video ?? payload.input;

  return {
    label: payload.input.split(/[/\\]/).at(-1) ?? payload.input,
    originalInputPath: payload.input,
    sourceUrl: toDesktopMediaUrl(playbackPath),
    sourcePath: playbackPath,
    duration: payload.duration_seconds,
    displaySourceUrl: mediaKind === "video" ? toDesktopMediaUrl(displayPath) : toDesktopMediaUrl(playbackPath),
    displaySourcePath: mediaKind === "video" ? displayPath : playbackPath,
    recentFilePath: payload.input,
    analysisCachePath: payload.analysis_json,
    availableSources: payload.sources.map((source) => ({
      kind: source.kind,
      label: source.label,
      path: source.path,
      url: source.path ? toDesktopMediaUrl(source.path) : null
    })),
    mediaKind,
    amplitudeEnvelope: payload.amplitudes,
    pitchContour: payload.pitch_hz,
    pitchConfidence: payload.confidence,
    analysisSourceKind: payload.analysis_source?.kind ?? "original",
    analysisState: payload.pitch_hz.length ? "ready" as const : "error" as const,
    analysisNote: payload.note
  };
}

function desktopAnalysisToLayerAnalysisPatch(payload: DesktopAnalysisPayload) {
  return {
    availableSources: payload.sources.map((source) => ({
      kind: source.kind,
      label: source.label,
      path: source.path,
      url: source.path ? toDesktopMediaUrl(source.path) : null
    })),
    analysisCachePath: payload.analysis_json,
    amplitudeEnvelope: payload.amplitudes,
    pitchContour: payload.pitch_hz,
    pitchConfidence: payload.confidence,
    analysisSourceKind: payload.analysis_source?.kind ?? "original",
    preferredPitchSource: payload.analysis_source?.kind ?? "original",
    analysisState: payload.pitch_hz.length ? "ready" as const : "error" as const,
    analysisNote: payload.note
  };
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatAnalysisState(state: PlayerLayer["analysisState"]): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function toPitchAnalysisSourceKind(sourceKind: PlayerLayer["availableSources"][number]["kind"]): PitchAnalysisSourceKind {
  if (sourceKind === "vocals") {
    return "vocals";
  }

  if (sourceKind === "other") {
    return "other";
  }

  return "original";
}

function getStemModelOutputCount(modelName: string): number {
  return STEM_MODEL_OUTPUT_COUNTS[modelName] ?? 2;
}

function formatPitchSourceLabel(sourceKind: PitchAnalysisSourceKind): string {
  switch (sourceKind) {
    case "vocals":
      return "vocals stem";
    case "other":
      return "other stem";
    default:
      return "original audio";
  }
}

function formatProcessingDeviceLabel(device: ProcessingDeviceMode): string {
  switch (device) {
    case "gpu":
      return "GPU";
    case "cpu":
      return "CPU";
    default:
      return "Auto (prefer GPU)";
  }
}

const SHARP_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NOTE_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const CIRCLE_OF_FIFTHS_KEYS: MusicalKey[] = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];
const FLAT_KEYS = new Set<MusicalKey>(["F", "Bb", "Eb", "Ab", "Db"]);
const KEY_TO_SEMITONE: Record<MusicalKey, number> = {
  C: 0,
  G: 7,
  D: 2,
  A: 9,
  E: 4,
  B: 11,
  "F#": 6,
  Db: 1,
  Ab: 8,
  Eb: 3,
  Bb: 10,
  F: 5
};
const MAJOR_SCALE_INTERVALS = new Set([0, 2, 4, 5, 7, 9, 11]);
const MINOR_SCALE_INTERVALS = new Set([0, 2, 3, 5, 7, 8, 10]);

function buildEnvelopePath(values: number[], width: number, height: number, totalDuration: number, startTime = 0, endTime = totalDuration): string {
  if (!values.length) {
    return "";
  }

  const centerY = height / 2;
  const halfHeight = height * 0.42;
  const samples = values
    .map((value, index) => {
      const time = totalDuration > 0 ? (totalDuration * index) / Math.max(values.length - 1, 1) : index;
      return { value, time };
    })
    .filter((sample) => sample.time >= startTime && sample.time <= endTime);

  if (!samples.length) {
    return "";
  }

  const topPath = samples
    .map((sample, index) => {
      const x = getPitchPlotXForTime(width, startTime, endTime, sample.time);
      const y = centerY - sample.value * halfHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const bottomPath = samples
    .map((_, index) => {
      const reverseIndex = samples.length - 1 - index;
      const sample = samples[reverseIndex];
      const x = getPitchPlotXForTime(width, startTime, endTime, sample.time);
      const y = centerY + sample.value * halfHeight;
      return `L${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return `${topPath} ${bottomPath} Z`;
}

function getPitchPlotMetrics(layer: PlayerLayer, height: number) {
  const centerPitch = getLayerCenterPitch(layer);
  const halfSpan = Math.max(layer.pitchSpan / 2, 1);
  const verticalPadding = Math.max(4, height * 0.04);
  const usableHeight = Math.max(height - verticalPadding * 2, 1);

  return {
    centerPitch,
    halfSpan,
    verticalPadding,
    usableHeight
  };
}

function getPitchPlotYForFrequency(layer: PlayerLayer, height: number, frequency: number): number | null {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return null;
  }

  const { centerPitch, halfSpan, verticalPadding, usableHeight } = getPitchPlotMetrics(layer, height);
  const semitoneOffset = 12 * Math.log2(frequency / centerPitch);
  const clampedOffset = Math.max(-halfSpan, Math.min(halfSpan, semitoneOffset));
  const normalized = (clampedOffset + halfSpan) / (halfSpan * 2);
  return verticalPadding + (1 - normalized) * usableHeight;
}

function getPitchPlotLeftInset(width: number): number {
  return Math.min(46, Math.max(14, width * 0.1));
}

function getPitchPlotUsableWidth(width: number): number {
  return Math.max(width - getPitchPlotLeftInset(width), 1);
}

function getPitchPlotXForTime(width: number, startTime: number, endTime: number, time: number): number {
  const leftInset = getPitchPlotLeftInset(width);
  const usableWidth = getPitchPlotUsableWidth(width);
  const visibleDuration = Math.max(endTime - startTime, 0.001);
  const clampedTime = clamp(time, startTime, endTime);
  return leftInset + ((clampedTime - startTime) / visibleDuration) * usableWidth;
}

function getPitchPlotLeftPercent(width: number, startTime: number, endTime: number, time: number): number {
  if (width <= 0) {
    return 0;
  }

  return (getPitchPlotXForTime(width, startTime, endTime, time) / width) * 100;
}

function getLayerMenuClassName(layer: PlayerLayer): string {
  const spaceRight = STAGE_WIDTH - (layer.x + layer.width);
  const spaceLeft = layer.x;

  if (spaceRight >= LAYER_MENU_WIDTH_PX + LAYER_MENU_DOCK_GAP_PX) {
    return "layer-menu layer-menu-dock-right";
  }

  if (spaceLeft >= LAYER_MENU_WIDTH_PX + LAYER_MENU_DOCK_GAP_PX) {
    return "layer-menu layer-menu-dock-left";
  }

  return spaceRight >= spaceLeft ? "layer-menu layer-menu-overlay-right" : "layer-menu layer-menu-overlay-left";
}

function getReliablePitchContour(layer: PlayerLayer): number[] {
  if (!layer.pitchContour.length) {
    return [];
  }

  const getEnvelopeAtPitchIndex = (index: number): number => {
    if (!layer.amplitudeEnvelope.length) {
      return 1;
    }

    if (layer.amplitudeEnvelope.length === 1 || layer.pitchContour.length <= 1) {
      return layer.amplitudeEnvelope[0] ?? 1;
    }

    const envelopeIndex = Math.round((index / Math.max(layer.pitchContour.length - 1, 1)) * Math.max(layer.amplitudeEnvelope.length - 1, 0));
    return layer.amplitudeEnvelope[envelopeIndex] ?? 0;
  };

  if (layer.pitchConfidence.length !== layer.pitchContour.length) {
    return layer.pitchContour.map((value, index) => value > 0 && getEnvelopeAtPitchIndex(index) > 0.04 ? value : 0);
  }

  const maxConfidence = Math.max(...layer.pitchConfidence, 0);

  if (maxConfidence <= 0) {
    return layer.pitchContour.map((value) => value > 0 ? value : 0);
  }

  return layer.pitchContour.map((value, index, contour) => {
    if (value <= 0) {
      return 0;
    }

    const confidence = layer.pitchConfidence[index] ?? 0;
    const normalizedConfidence = maxConfidence > 0 ? confidence / maxConfidence : 0;
    const localEnvelope = getEnvelopeAtPitchIndex(index);

    if (localEnvelope <= 0.04) {
      return 0;
    }

    if (localEnvelope <= 0.08 && normalizedConfidence < 0.85) {
      return 0;
    }

    if (normalizedConfidence >= 0.22) {
      return value;
    }

    const previous = contour[index - 1] ?? 0;
    const next = contour[index + 1] ?? 0;
    const previousConfidence = maxConfidence > 0 ? (layer.pitchConfidence[index - 1] ?? 0) / maxConfidence : 0;
    const nextConfidence = maxConfidence > 0 ? (layer.pitchConfidence[index + 1] ?? 0) / maxConfidence : 0;

    if (previous > 0 && next > 0) {
      const jumpFromPrevious = Math.abs(12 * Math.log2(value / previous));
      const jumpToNext = Math.abs(12 * Math.log2(value / next));
      const surroundingJump = Math.abs(12 * Math.log2(next / previous));

      if (surroundingJump <= 3 && (jumpFromPrevious <= 5 || jumpToNext <= 5)) {
        return value;
      }
    }

    if (previous > 0 && previousConfidence >= 0.34) {
      const jumpFromPrevious = Math.abs(12 * Math.log2(value / previous));
      if (jumpFromPrevious <= 2.5) {
        return value;
      }
    }

    if (next > 0 && nextConfidence >= 0.34) {
      const jumpToNext = Math.abs(12 * Math.log2(value / next));
      if (jumpToNext <= 2.5) {
        return value;
      }
    }

    return 0;
  });
}

function buildPitchPath(layer: PlayerLayer, width: number, height: number, startTime = 0, endTime = layer.duration, visibleUntilTime = endTime): string {
  const reliableContour = getReliablePitchContour(layer);
  const contour = reliableContour.filter((value) => value > 0);

  if (!contour.length) {
    return "";
  }

  const { centerPitch, halfSpan, verticalPadding, usableHeight } = getPitchPlotMetrics(layer, height);
  const totalDuration = Number.isFinite(layer.duration) && layer.duration > 0 ? layer.duration : Math.max(reliableContour.length - 1, 1);
  const clampedStartTime = Math.max(0, startTime);
  const clampedEndTime = Math.max(clampedStartTime, Number.isFinite(endTime) && endTime > 0 ? Math.min(endTime, totalDuration) : totalDuration);
  const clampedVisibleUntilTime = Math.max(clampedStartTime, Math.min(visibleUntilTime, clampedEndTime));

  let hasActiveSegment = false;

  return reliableContour.flatMap((value, index) => {
    const time = totalDuration > 0 ? (totalDuration * index) / Math.max(reliableContour.length - 1, 1) : index;

    if (time < clampedStartTime || time > clampedVisibleUntilTime) {
      return [];
    }

    const x = getPitchPlotXForTime(width, clampedStartTime, clampedEndTime, time);

    if (value <= 0) {
      hasActiveSegment = false;
      return [];
    }

    const semitoneOffset = 12 * Math.log2(value / centerPitch);
    const clampedOffset = Math.max(-halfSpan, Math.min(halfSpan, semitoneOffset));
    const normalized = (clampedOffset + halfSpan) / (halfSpan * 2);
    const y = verticalPadding + (1 - normalized) * usableHeight;
    const command = hasActiveSegment ? "L" : "M";
    hasActiveSegment = true;
    return [`${command}${x.toFixed(2)},${y.toFixed(2)}`];
  }).join(" ");
}

type PitchPoint = {
  index: number;
  x: number;
  y: number;
  frequency: number;
  noteLabel: string;
  timeSeconds: number;
  semitoneOffset: number;
};

function buildPitchPoints(layer: PlayerLayer, width: number, height: number, startTime = 0, endTime = layer.duration): PitchPoint[] {
  const reliableContour = getReliablePitchContour(layer);
  const contour = reliableContour.filter((value) => value > 0);

  if (!contour.length) {
    return [];
  }

  const { centerPitch, halfSpan, verticalPadding, usableHeight } = getPitchPlotMetrics(layer, height);
  const totalDuration = Number.isFinite(layer.duration) && layer.duration > 0 ? layer.duration : Math.max(reliableContour.length - 1, 1);
  const clampedStartTime = Math.max(0, startTime);
  const clampedEndTime = Math.max(clampedStartTime, Number.isFinite(endTime) && endTime > 0 ? Math.min(endTime, totalDuration) : totalDuration);

  return reliableContour.flatMap((value, index) => {
    if (value <= 0) {
      return [];
    }

    const timeSeconds = totalDuration > 0 ? (totalDuration * index) / Math.max(reliableContour.length - 1, 1) : index;

    if (timeSeconds < clampedStartTime || timeSeconds > clampedEndTime) {
      return [];
    }

    const x = getPitchPlotXForTime(width, clampedStartTime, clampedEndTime, timeSeconds);
    const semitoneOffset = 12 * Math.log2(value / centerPitch);
    const clampedOffset = Math.max(-halfSpan, Math.min(halfSpan, semitoneOffset));
    const normalized = (clampedOffset + halfSpan) / (halfSpan * 2);
    const y = verticalPadding + (1 - normalized) * usableHeight;

    return [{
      index,
      x,
      y,
      frequency: value,
      noteLabel: formatNoteLabel(value, layer.pitchKey),
      timeSeconds,
      semitoneOffset
    }];
  });
}

function getLayerCenterPitch(layer: PlayerLayer): number {
  const contour = getReliablePitchContour(layer).filter((value) => value > 0);

  if (layer.pitchCenterMode === "adaptive" && contour.length) {
    return contour.reduce((sum, value) => sum + value, 0) / contour.length;
  }

  return 220 * Math.pow(2, layer.pitchCenterOffset / 12);
}

function keyUsesFlats(key: MusicalKey): boolean {
  return FLAT_KEYS.has(key);
}

function getNoteNameForMidi(midi: number, key: MusicalKey): string {
  const noteNames = keyUsesFlats(key) ? FLAT_NOTE_NAMES : SHARP_NOTE_NAMES;
  return noteNames[((midi % 12) + 12) % 12];
}

function formatMidiNoteLabel(midi: number, key: MusicalKey): string {
  const noteName = getNoteNameForMidi(midi, key);
  const octave = Math.floor(midi / 12) - 1;
  return `${noteName}${octave}`;
}

function formatNoteLabel(frequency: number, key: MusicalKey): string {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return "--";
  }

  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return formatMidiNoteLabel(midi, key);
}

function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function getPitchGridStep(pitchSpan: number): number {
  if (pitchSpan <= 14) {
    return 1;
  }

  if (pitchSpan <= 24) {
    return 2;
  }

  if (pitchSpan <= 36) {
    return 3;
  }

  return 4;
}

function isMidiInSelectedScale(midi: number, key: MusicalKey, scaleMode: PitchScaleMode): boolean {
  if (scaleMode === "chromatic") {
    return true;
  }

  const tonic = KEY_TO_SEMITONE[key];
  const normalized = (((midi % 12) - tonic) % 12 + 12) % 12;
  return scaleMode === "major"
    ? MAJOR_SCALE_INTERVALS.has(normalized)
    : MINOR_SCALE_INTERVALS.has(normalized);
}

function getPitchScaleLabels(layer: PlayerLayer): Array<{
  noteLabel: string;
  positionPercent: number;
  frequency: number;
  isPrimary: boolean;
  isCenter: boolean;
  isInScale: boolean;
}> {
  const centerPitch = getLayerCenterPitch(layer);
  const centerMidi = Math.round(69 + 12 * Math.log2(centerPitch / 440));
  const halfSpan = Math.max(Math.round(layer.pitchSpan / 2), 1);
  const gridStep = getPitchGridStep(layer.pitchSpan);

  return Array.from({ length: halfSpan * 2 + 1 }, (_, index) => {
    const semitoneOffset = halfSpan - index;
    const midi = centerMidi + semitoneOffset;
    const frequency = midiToFrequency(midi);
    const distanceFromCenter = Math.abs(semitoneOffset);
    const isCenter = semitoneOffset === 0;
    const isInScale = isMidiInSelectedScale(midi, layer.pitchKey, layer.pitchScaleMode);
    const isPrimary = isCenter || semitoneOffset % gridStep === 0 || (layer.pitchScaleMode !== "chromatic" && isInScale);
    const y = getPitchPlotYForFrequency(layer, PITCH_PLOT_HEIGHT, frequency) ?? 0;
    const positionPercent = (y / PITCH_PLOT_HEIGHT) * 100;

    return {
      noteLabel: formatMidiNoteLabel(midi, layer.pitchKey),
      positionPercent,
      frequency,
      isPrimary,
      isCenter: distanceFromCenter === 0,
      isInScale
    };
  });
}

function buildTimelineTicks(startTime: number, endTime: number): number[] {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    return Array.from({ length: 5 }, (_, index) => (PLAYER_TIMELINE_WINDOW_SECONDS / 4) * index);
  }

  const tickCount = 5;
  const visibleDuration = endTime - startTime;
  return Array.from({ length: tickCount }, (_, index) => startTime + (visibleDuration / (tickCount - 1)) * index);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hexToRgba(color: string, alpha: number): string {
  const normalized = color.trim();
  const clampedAlpha = clamp(alpha, 0, 1);
  const shortHexMatch = normalized.match(/^#([\da-f]{3})$/i);
  const longHexMatch = normalized.match(/^#([\da-f]{6})$/i);

  if (shortHexMatch) {
    const [red, green, blue] = shortHexMatch[1].split("").map((value) => Number.parseInt(`${value}${value}`, 16));
    return `rgba(${red}, ${green}, ${blue}, ${clampedAlpha})`;
  }

  if (longHexMatch) {
    const hex = longHexMatch[1];
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${clampedAlpha})`;
  }

  return color;
}

type LayerMediaRefs = {
  visual: HTMLMediaElement | null;
  audio: HTMLMediaElement | null;
};

type PendingSourceSync = {
  playbackPosition: number;
  wasPlaying: boolean;
  mediaSourceUrl: string | null;
};

type StageInteraction = {
  mode: "drag" | "resize";
  layerId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

const DIAGNOSTICS_SCROLL_THRESHOLD = 24;

function shouldStickDiagnosticsToBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= DIAGNOSTICS_SCROLL_THRESHOLD;
}

function formatLogTimestamp(value: Date): string {
  return value.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false
  });
}

function buildUiLogLine(message: string): string {
  return `[ui ${formatLogTimestamp(new Date())}] ${message}`;
}

function formatTooltipSeconds(value: number): string {
  return `${value.toFixed(2)} s`;
}

function formatTooltipFrequency(value: number): string {
  return `${value.toFixed(2)} Hz`;
}

function formatSemitoneOffset(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} st`;
}

function getLayerTimeViewport(layer: PlayerLayer) {
  const totalDuration = Number.isFinite(layer.duration) && layer.duration > 0 ? layer.duration : PLAYER_TIMELINE_WINDOW_SECONDS;
  const visibleDuration = Math.min(totalDuration, PLAYER_TIMELINE_WINDOW_SECONDS);
  const halfWindow = visibleDuration / 2;
  const maxStart = Math.max(totalDuration - visibleDuration, 0);
  const startTime = clamp(layer.playbackPosition - halfWindow, 0, maxStart);
  const endTime = startTime + visibleDuration;
  const playheadTime = clamp(layer.playbackPosition, startTime, endTime);
  const playheadPercent = visibleDuration > 0 ? ((playheadTime - startTime) / visibleDuration) * 100 : 0;

  return {
    startTime,
    endTime,
    visibleDuration,
    playheadTime,
    playheadPercent
  };
}

type PreprocessingProgress = {
  title: string;
  status: string;
  value: number;
};

type ProcessingContext = {
  targetLayerIds: string[];
  stemModel: string;
  pitchModel: string;
  pitchSourceKind: PitchAnalysisSourceKind;
  processingDevice: ProcessingDeviceMode;
};

type HoveredPitchPoint = PitchPoint & {
  layerId: string;
  leftPercent: number;
  topPercent: number;
};

function buildPreprocessingProgress(title: string, status: string, value: number): PreprocessingProgress {
  return {
    title,
    status,
    value: Math.max(0, Math.min(100, Math.round(value)))
  };
}

function derivePendingPreprocessingProgress(statusMessage: string): PreprocessingProgress | null {
  if (/^running desktop import preprocessing/i.test(statusMessage)) {
    return buildPreprocessingProgress("Pitch detection preprocessing", "Preparing desktop preprocessing", 8);
  }

  if (/^reopening .* through desktop preprocessing/i.test(statusMessage)) {
    return buildPreprocessingProgress("Pitch detection preprocessing", "Preparing desktop preprocessing", 8);
  }

  if (/^re-running pitch detection for /i.test(statusMessage)) {
    return buildPreprocessingProgress("Pitch detection preprocessing", "Preparing pitch preprocessing", 8);
  }

  if (/^importing media and generating amplitude and pitch preview data/i.test(statusMessage)) {
    return buildPreprocessingProgress("Pitch detection preprocessing", "Analyzing imported media", 10);
  }

  if (/^generating stems for /i.test(statusMessage)) {
    return buildPreprocessingProgress("Stem separation", "Preparing stem separation", 5);
  }

  return null;
}

function derivePreprocessingProgress(entries: string[], statusMessage: string): PreprocessingProgress {
  const pendingProgress = derivePendingPreprocessingProgress(statusMessage);
  if (pendingProgress) {
    return pendingProgress;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entries[index];
    const normalized = line.toLowerCase();
    const progressMatch = normalized.match(/progress:\s*(stem-separating|pitch-caching)\s+(\d{1,3})\s*(.*)$/);

    if (progressMatch) {
      const [, stage, percentText, detailText] = progressMatch;
      const title = stage === "stem-separating" ? "Stem separation" : "Pitch detection preprocessing";
      const fallbackStatus = stage === "stem-separating" ? "Separating stems" : "Preparing pitch contours";
      const status = detailText.trim() || fallbackStatus;
      return buildPreprocessingProgress(title, status.charAt(0).toUpperCase() + status.slice(1), Number(percentText));
    }

    if (normalized.includes("phase: stem-separating started")) {
      return buildPreprocessingProgress("Stem separation", "Preparing stem separation", 5);
    }

    if (normalized.includes("phase: pitch-caching started")) {
      return buildPreprocessingProgress("Pitch detection preprocessing", "Preparing pitch preprocessing", 8);
    }

    if (normalized.includes("phase: stem-separating cached")) {
      return buildPreprocessingProgress("Stem separation", "Used cached stem separation", 100);
    }

    if (normalized.includes("phase: pitch-caching cached")) {
      return buildPreprocessingProgress("Pitch detection preprocessing", "Used cached pitch preprocessing", 100);
    }

    if (normalized.includes("phase: stem-separating completed")) {
      return buildPreprocessingProgress("Stem separation", "Stem separation complete", 100);
    }

    if (normalized.includes("phase: pitch-caching completed")) {
      return buildPreprocessingProgress("Pitch detection preprocessing", "Pitch preprocessing complete", 100);
    }
  }

  return buildPreprocessingProgress("No preprocessing active", "Waiting for desktop import or stem generation", 0);
}

function describeMediaError(code: number | undefined): string {
  switch (code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "media load aborted";
    case MediaError.MEDIA_ERR_NETWORK:
      return "network error while loading media";
    case MediaError.MEDIA_ERR_DECODE:
      return "media decode error";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "source format is not supported";
    default:
      return "unknown media error";
  }
}

function getActiveSourceKind(layer: PlayerLayer): PlayerLayer["availableSources"][number]["kind"] {
  const byPath = layer.availableSources.find((source) => source.path && source.path === layer.sourcePath);
  if (byPath) {
    return byPath.kind;
  }

  const byUrl = layer.availableSources.find((source) => source.url && source.url === layer.mediaSourceUrl);
  return byUrl?.kind ?? "original";
}

function getSelectedStemLabel(layer: PlayerLayer): string {
  const activeSourceKind = getActiveSourceKind(layer);
  const source = layer.availableSources.find((entry) => entry.kind === activeSourceKind);

  if (source) {
    return source.label;
  }

  switch (layer.stemTarget) {
    case "vocals":
      return "Vocals";
    case "other":
      return "Other";
    default:
      return "Original";
  }
}

type IconName =
  | "menu"
  | "close"
  | "import"
  | "stems"
  | "tile"
  | "add"
  | "remove"
  | "play"
  | "pause"
  | "stop"
  | "seekBack"
  | "seekForward"
  | "demo"
  | "forward"
  | "backward";

function AppIcon({ name }: { name: IconName }) {
  switch (name) {
    case "menu":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 7h12" />
          <path d="M6 12h12" />
          <path d="M6 17h12" />
        </svg>
      );
    case "close":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 7l10 10" />
          <path d="M17 7L7 17" />
        </svg>
      );
    case "import":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v10" />
          <path d="M8 8l4-4 4 4" />
          <path d="M5 15v4h14v-4" />
        </svg>
      );
    case "stems":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 14c2.5 0 2.5-4 5-4s2.5 8 5 8 2.5-12 5-12" />
          <path d="M4 18h16" />
        </svg>
      );
    case "tile":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="4" width="7" height="7" rx="1.5" />
          <rect x="13" y="4" width="7" height="7" rx="1.5" />
          <rect x="4" y="13" width="7" height="7" rx="1.5" />
          <rect x="13" y="13" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "add":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "remove":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      );
    case "play":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 6l10 6-10 6z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "pause":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
          <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "stop":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "seekBack":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 7l-6 5 6 5z" fill="currentColor" stroke="none" />
          <path d="M19 7l-6 5 6 5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "seekForward":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13 7l6 5-6 5z" fill="currentColor" stroke="none" />
          <path d="M5 7l6 5-6 5z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "demo":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4l1.8 4.2L18 10l-4.2 1.8L12 16l-1.8-4.2L6 10l4.2-1.8z" />
        </svg>
      );
    case "forward":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 18V6" />
          <path d="M8 10l4-4 4 4" />
        </svg>
      );
    case "backward":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 6v12" />
          <path d="M8 14l4 4 4-4" />
        </svg>
      );
  }
}

type IconButtonProps = {
  icon: IconName;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
};

function IconButton({ icon, label, onClick, className }: IconButtonProps) {
  return (
    <button
      type="button"
      className={className ? `icon-button ${className}` : "icon-button"}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <AppIcon name={icon} />
      <span className="sr-only">{label}</span>
    </button>
  );
}

function App() {
  const [project, setProject] = useState(() => loadProject());
  const [isHydrated, setIsHydrated] = useState(!isDesktopHost());
  const [importTarget, setImportTarget] = useState<ImportTarget>("selected");
  const [desktopImportTargetLayerIds, setDesktopImportTargetLayerIds] = useState<string[]>([]);
  const [processingContext, setProcessingContext] = useState<ProcessingContext | null>(null);
  const [statusMessage, setStatusMessage] = useState("Browser and Tauri share the same workspace UI. Import uses the native system picker.");
  const [openMenuLayerId, setOpenMenuLayerId] = useState<string | null>(null);
  const [hoveredPitchPoint, setHoveredPitchPoint] = useState<HoveredPitchPoint | null>(null);
  const [stageInteraction, setStageInteraction] = useState<StageInteraction | null>(null);
  const mediaRefs = useRef<Record<string, LayerMediaRefs>>({});
  const diagnosticsLogRef = useRef<HTMLPreElement | null>(null);
  const diagnosticsAutoScrollRef = useRef(true);
  const playbackRetryTimeoutsRef = useRef<number[]>([]);
  const pendingSourceSyncRef = useRef<Record<string, PendingSourceSync>>({});
  const [diagnosticsEntries, setDiagnosticsEntries] = useState<string[]>([]);
  const selectedLayer = project.layers.find((layer) => layer.id === project.selectedLayerId) ?? project.layers[0];
  const preprocessingProgress = derivePreprocessingProgress(diagnosticsEntries, statusMessage);
  const availableLayerIds = project.layers.map((layer) => layer.id);
  const effectiveDesktopImportTargetLayerIds = desktopImportTargetLayerIds.filter((layerId) => availableLayerIds.includes(layerId));
  const effectiveProcessingContext = processingContext ?? {
    targetLayerIds: effectiveDesktopImportTargetLayerIds,
    stemModel: project.stemSeparatorModel,
    pitchModel: project.pitchDetectorModel,
    pitchSourceKind: project.pitchAnalysisSource,
    processingDevice: project.processingDevice
  };

  const desktopImportTargetNames = effectiveDesktopImportTargetLayerIds
    .map((layerId) => project.layers.find((layer) => layer.id === layerId)?.name)
    .filter((name): name is string => Boolean(name));

  const desktopImportSummary = desktopImportTargetNames.length
    ? `Targets: ${desktopImportTargetNames.join(", ")}. Stem separation uses ${project.stemSeparatorModel} (${getStemModelOutputCount(project.stemSeparatorModel)} stems). Pitch detection uses ${project.pitchDetectorModel} on ${formatPitchSourceLabel(project.pitchAnalysisSource)}. Processing device is ${formatProcessingDeviceLabel(project.processingDevice)}.`
    : `Choose at least one player, then import with ${project.stemSeparatorModel} (${getStemModelOutputCount(project.stemSeparatorModel)} stems) and ${project.pitchDetectorModel} on ${formatPitchSourceLabel(project.pitchAnalysisSource)} using ${formatProcessingDeviceLabel(project.processingDevice)}.`;

  useEffect(() => () => {
    playbackRetryTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    playbackRetryTimeoutsRef.current = [];
  }, []);

  useEffect(() => {
    const diagnosticsElement = diagnosticsLogRef.current;
    if (!diagnosticsElement) {
      return;
    }

    if (!diagnosticsAutoScrollRef.current) {
      return;
    }

    if (typeof diagnosticsElement.scrollTo === "function") {
      diagnosticsElement.scrollTo({ top: diagnosticsElement.scrollHeight });
      return;
    }

    diagnosticsElement.scrollTop = diagnosticsElement.scrollHeight;
  }, [diagnosticsEntries]);

  useEffect(() => {
    const playingLayers = project.layers.filter((layer) => layer.isPlaying);
    if (!playingLayers.length) {
      return;
    }

    const interval = window.setInterval(() => {
      setProject((current) => {
        let nextProject = current;

        for (const layer of current.layers) {
          if (!layer.isPlaying) {
            continue;
          }

          const refs = mediaRefs.current[layer.id];
          const audioElement = refs?.audio ?? null;
          const visualElement = refs?.visual ?? null;
          const preferredElement = audioElement ?? visualElement ?? null;
          if (!preferredElement) {
            continue;
          }

          const currentTime = preferredElement.currentTime;
          const duration = Number.isFinite(preferredElement.duration) ? preferredElement.duration : layer.duration;
          if (!Number.isFinite(currentTime)) {
            continue;
          }

          if (layer.mediaKind === "video" && audioElement && visualElement) {
            const visualTime = visualElement.currentTime;
            if (Number.isFinite(visualTime) && Math.abs(visualTime - currentTime) > 0.05) {
              visualElement.currentTime = currentTime;
            }

            if (audioElement.paused === false && visualElement.paused) {
              void visualElement.play().catch(() => {
                // The visual element is best-effort only; keep the audio clock authoritative.
              });
            }
          }

          const timeDelta = Math.abs(currentTime - layer.playbackPosition);
          if (timeDelta < 0.05 && duration === layer.duration) {
            continue;
          }

          nextProject = updateLayerTime(nextProject, layer.id, currentTime, duration);
        }

        return nextProject;
      });
    }, PLAYBACK_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [project.layers]);

  useEffect(() => {
    if (!isDesktopHost()) {
      return;
    }

    let cancelled = false;

    const syncLog = async () => {
      try {
        const entries = await readDesktopDiagnosticsLog(250);
        if (!cancelled) {
          setDiagnosticsEntries(entries);
        }
      } catch {
        if (!cancelled) {
          setDiagnosticsEntries((current) => current.length ? current : [buildUiLogLine("Desktop diagnostics log could not be loaded.")]);
        }
      }
    };

    void syncLog();
    const interval = window.setInterval(() => {
      void syncLog();
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    setDesktopImportTargetLayerIds((current) => {
      const filtered = current.filter((layerId) => availableLayerIds.includes(layerId));
      if (filtered.length) {
        return filtered;
      }

      return project.selectedLayerId ? [project.selectedLayerId] : availableLayerIds.slice(0, 1);
    });
  }, [availableLayerIds.join("|"), project.selectedLayerId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        void handleClearDiagnosticsLog();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function appendDiagnosticsLog(message: string, persistToDesktop = true) {
    const line = buildUiLogLine(message);
    setDiagnosticsEntries((current) => [...current.slice(-248), line]);

    if (persistToDesktop && isDesktopHost()) {
      void appendDesktopDiagnosticsEntry(message);
    }
  }

  function setStatusAndLog(message: string, persistToDesktop = true) {
    setStatusMessage(message);
    appendDiagnosticsLog(message, persistToDesktop);
  }

  function toggleDesktopImportTarget(layerId: string) {
    setDesktopImportTargetLayerIds((current) => current.includes(layerId)
      ? current.filter((entry) => entry !== layerId)
      : [...current, layerId]);
  }

  function handleDiagnosticsScroll(event: ReactUIEvent<HTMLPreElement>) {
    diagnosticsAutoScrollRef.current = shouldStickDiagnosticsToBottom(event.currentTarget);
  }

  function schedulePlaybackRetry(layerId: string) {
    const timeoutId = window.setTimeout(() => {
      playbackRetryTimeoutsRef.current = playbackRetryTimeoutsRef.current.filter((entry) => entry !== timeoutId);
      handlePlay(layerId, false);
    }, 80);

    playbackRetryTimeoutsRef.current.push(timeoutId);
  }

  async function handleCopyDiagnosticsLog() {
    const content = diagnosticsEntries.join("\n");
    if (!content) {
      setStatusAndLog("Diagnostics log is empty.");
      return;
    }

    try {
      await navigator.clipboard.writeText(content);
      setStatusAndLog(`Copied ${diagnosticsEntries.length} diagnostics line(s) to the clipboard.`);
    } catch {
      setStatusAndLog("Clipboard copy failed for the diagnostics log.");
    }
  }

  async function handleClearDiagnosticsLog() {
    setDiagnosticsEntries([]);

    if (isDesktopHost()) {
      try {
        await clearDesktopDiagnosticsLog();
        const entries = await readDesktopDiagnosticsLog(250);
        setDiagnosticsEntries(entries);
        setStatusAndLog("Cleared the diagnostics log.", false);
        return;
      } catch {
        setStatusAndLog("Diagnostics log could not be cleared.");
        return;
      }
    }

    setStatusAndLog("Cleared the diagnostics log.", false);
  }

  useEffect(() => {
    if (!isDesktopHost()) {
      return;
    }

    void loadDesktopProject()
      .then((desktopProject) => {
        if (!desktopProject) {
          setIsHydrated(true);
          return;
        }

        setProject(rebuildDesktopProjectUrls(hydrateProject(desktopProject)));
        setStatusAndLog("Loaded desktop project state from the app data directory.");
        setIsHydrated(true);
      })
      .catch(() => {
        setStatusAndLog("Desktop project state could not be loaded. Using in-browser fallback state.");
        setIsHydrated(true);
      });
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    saveProject(project);

    if (isDesktopHost()) {
      void saveDesktopProject(project).catch((error) => {
        const message = error instanceof Error ? error.message : "Desktop project state could not be saved.";
        setStatusAndLog(`Desktop project state could not be saved: ${message}`);
      });
    }
  }, [isHydrated, project]);

  useEffect(() => {
    const hasSolo = project.layers.some((layer) => layer.mixMode === "solo");

    project.layers.forEach((layer) => {
      getPlaybackElements(layer.id).forEach((element, index) => {
        const isVisualVideo = layer.mediaKind === "video" && index === 0;
        element.muted = isVisualVideo || layer.mixMode === "mute" || (hasSolo && layer.mixMode !== "solo");
        element.volume = layer.mixMode === "mute" || isVisualVideo ? 0 : 1;
      });
    });
  }, [project.layers]);

  useEffect(() => {
    if (!stageInteraction) {
      return;
    }

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = stageInteraction.mode === "drag" ? "grabbing" : "nwse-resize";

    const handlePointerMove = (event: PointerEvent) => {
      setProject((current) => {
        const layer = current.layers.find((entry) => entry.id === stageInteraction.layerId);
        if (!layer) {
          return current;
        }

        const deltaX = event.clientX - stageInteraction.startClientX;
        const deltaY = event.clientY - stageInteraction.startClientY;

        if (stageInteraction.mode === "drag") {
          const nextX = clamp(stageInteraction.startX + deltaX, 0, Math.max(0, STAGE_WIDTH - stageInteraction.startWidth));
          const nextY = clamp(stageInteraction.startY + deltaY, 0, Math.max(0, STAGE_HEIGHT - stageInteraction.startHeight));

          if (nextX === layer.x && nextY === layer.y) {
            return current;
          }

          return updateLayer(current, layer.id, { x: nextX, y: nextY });
        }

        const nextWidth = clamp(stageInteraction.startWidth + deltaX, MIN_LAYER_WIDTH, Math.max(MIN_LAYER_WIDTH, STAGE_WIDTH - stageInteraction.startX));
        const nextHeight = clamp(stageInteraction.startHeight + deltaY, MIN_LAYER_HEIGHT, Math.max(MIN_LAYER_HEIGHT, STAGE_HEIGHT - stageInteraction.startY));

        if (nextWidth === layer.width && nextHeight === layer.height) {
          return current;
        }

        return updateLayer(current, layer.id, { width: nextWidth, height: nextHeight });
      });
    };

    const handlePointerStop = () => {
      setStageInteraction(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerStop);
    window.addEventListener("pointercancel", handlePointerStop);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerStop);
      window.removeEventListener("pointercancel", handlePointerStop);
    };
  }, [stageInteraction]);

  function patchLayer(layerId: string, patch: Partial<PlayerLayer>) {
    setProject((current) => updateLayer(current, layerId, patch));
  }

  function focusLayer(layerId: string, shouldBringToFront = false) {
    setProject((current) => {
      const selectedProject = selectLayer(current, layerId);
      return shouldBringToFront ? bringLayerToFront(selectedProject, layerId) : selectedProject;
    });
  }

  function handleLayerDragStart(event: ReactPointerEvent<HTMLDivElement>, layer: PlayerLayer) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setHoveredPitchPoint((current) => current?.layerId === layer.id ? null : current);
    focusLayer(layer.id, true);
    setStageInteraction({
      mode: "drag",
      layerId: layer.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: layer.x,
      startY: layer.y,
      startWidth: layer.width,
      startHeight: layer.height
    });
  }

  function handleLayerResizeStart(event: ReactPointerEvent<HTMLButtonElement>, layer: PlayerLayer) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setHoveredPitchPoint((current) => current?.layerId === layer.id ? null : current);
    focusLayer(layer.id, true);
    setStageInteraction({
      mode: "resize",
      layerId: layer.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: layer.x,
      startY: layer.y,
      startWidth: layer.width,
      startHeight: layer.height
    });
  }

  function setMediaElement(layerId: string, channel: keyof LayerMediaRefs, element: HTMLMediaElement | null) {
    mediaRefs.current[layerId] = {
      visual: mediaRefs.current[layerId]?.visual ?? null,
      audio: mediaRefs.current[layerId]?.audio ?? null,
      [channel]: element
    };
  }

  function getPlaybackElements(layerId: string): HTMLMediaElement[] {
    const refs = mediaRefs.current[layerId];
    if (!refs) {
      return [];
    }

    return [refs.visual, refs.audio].filter((element): element is HTMLMediaElement => Boolean(element));
  }

  function restorePendingSourceSync(layerId: string) {
    const pendingSync = pendingSourceSyncRef.current[layerId];
    if (!pendingSync) {
      return;
    }

    getPlaybackElements(layerId).forEach((element) => {
      if (element.readyState < 1) {
        return;
      }

      const clampedTime = Number.isFinite(element.duration)
        ? Math.min(pendingSync.playbackPosition, element.duration || pendingSync.playbackPosition)
        : pendingSync.playbackPosition;

      element.currentTime = Math.max(0, clampedTime);

      if (pendingSync.wasPlaying) {
        void element.play().catch(() => {
          // Source restoration best-effort only; regular playback diagnostics handle failures.
        });
      }
    });

    delete pendingSourceSyncRef.current[layerId];
  }

  function handleMediaLoadedMetadata(layer: PlayerLayer) {
    return (event: SyntheticEvent<HTMLMediaElement>) => {
      const { duration } = event.currentTarget;
      setProject((current) => updateLayerTime(current, layer.id, layer.playbackPosition, duration));

      const pendingSync = pendingSourceSyncRef.current[layer.id];
      if (pendingSync && pendingSync.mediaSourceUrl === layer.mediaSourceUrl) {
        restorePendingSourceSync(layer.id);
      }
    };
  }

  function handleVideoLoadedData(layer: PlayerLayer) {
    return (event: SyntheticEvent<HTMLVideoElement>) => {
      const element = event.currentTarget;
      if (!Number.isFinite(element.duration) || element.duration <= 0) {
        return;
      }

      const pendingSync = pendingSourceSyncRef.current[layer.id];
      if (pendingSync) {
        return;
      }

      if (element.currentTime > 0) {
        return;
      }

      const targetTime = layer.playbackPosition > 0
        ? layer.playbackPosition
        : Math.min(0.001, Math.max(element.duration - 0.001, 0));

      if (targetTime > 0) {
        element.currentTime = targetTime;
      }
    };
  }

  function handleLayerSourceChange(layer: PlayerLayer, sourceKind: PlayerLayer["availableSources"][number]["kind"]) {
    const nextSource = layer.availableSources.find((entry) => entry.kind === sourceKind);
    if (!nextSource) {
      return;
    }

    setHoveredPitchPoint((current) => current?.layerId === layer.id ? null : current);

    pendingSourceSyncRef.current[layer.id] = {
      playbackPosition: layer.playbackPosition,
      wasPlaying: layer.isPlaying,
      mediaSourceUrl: nextSource.url
    };

    const pitchSourceKind = toPitchAnalysisSourceKind(sourceKind);

    setProject((current) => updateLayer(selectLayerSource(current, layer.id, sourceKind), layer.id, {
      preferredPitchSource: pitchSourceKind
    }));
  }

  function logMediaElementError(layer: PlayerLayer, channel: "video" | "audio", element: HTMLMediaElement) {
    const message = `${layer.name} ${channel} failed to load: ${describeMediaError(element.error?.code)}.`;
    setStatusAndLog(message);
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    if (!files.length) {
      return;
    }

    setStatusAndLog("Importing media and generating amplitude and pitch preview data...");
    const importedMedia = await Promise.all(files.map(async (file) => {
      const mediaKind: PlayerLayer["mediaKind"] = file.type.startsWith("video") ? "video" : "audio";
      const analysis = await analyzeAudioFile(file);

      return {
        label: file.name,
        sourceUrl: URL.createObjectURL(file),
        sourcePath: null,
        analysisCachePath: null,
        mediaKind,
        amplitudeEnvelope: analysis.amplitudeEnvelope,
        pitchContour: analysis.pitchContour,
        pitchConfidence: analysis.pitchConfidence,
        analysisState: analysis.pitchContour.length ? "ready" as const : "error" as const,
        analysisNote: analysis.analysisNote
      };
    }));

    const targetIds = getImportTargetLayerIds(project, importTarget);
    setProject((current) => assignImportedMedia(current, importTarget, importedMedia));
    setStatusAndLog(`Imported ${files.length} file(s) into ${targetIds.length} layer(s). Pitch preview input is leveled and isolated glitches are suppressed.`);
    if (importedMedia[0]?.analysisNote) {
      appendDiagnosticsLog(`Pitch analysis: ${importedMedia[0].analysisNote}`);
    }
    event.target.value = "";
  }

  async function handleDesktopImport() {
    try {
      if (!effectiveDesktopImportTargetLayerIds.length) {
        setStatusAndLog("Choose at least one player window before importing.", false);
        return;
      }

      setProcessingContext({
        targetLayerIds: effectiveDesktopImportTargetLayerIds,
        stemModel: project.stemSeparatorModel,
        pitchModel: project.pitchDetectorModel,
        pitchSourceKind: project.pitchAnalysisSource,
        processingDevice: project.processingDevice
      });

      const paths = await pickDesktopMediaFiles();

      if (!paths.length) {
        return;
      }

      setStatusAndLog(`Running desktop import preprocessing for ${effectiveDesktopImportTargetLayerIds.length} player(s) with ${project.stemSeparatorModel} and ${project.pitchDetectorModel} on ${formatPitchSourceLabel(project.pitchAnalysisSource)} using ${formatProcessingDeviceLabel(project.processingDevice)}${project.bypassPreprocessingCache ? " with cache bypass enabled" : ""}...`);
      const analysisPayload = await analyzeDesktopMediaFilesWithOptions(paths, {
        separateStems: true,
        stemModel: project.stemSeparatorModel,
        pitchModel: project.pitchDetectorModel,
        pitchSourceKind: project.pitchAnalysisSource,
        processingDevice: project.processingDevice,
        bypassCache: project.bypassPreprocessingCache
      });
      const importedMedia = analysisPayload.map(desktopAnalysisToImportPayload);
      setProject((current) => assignImportedMediaToLayerIds(current, effectiveDesktopImportTargetLayerIds, importedMedia));
      const cacheHits = analysisPayload.filter((payload) => payload.cache_status === "hit").length;
      const cacheSummary = cacheHits
        ? ` ${cacheHits}/${analysisPayload.length} import(s) reused cached preprocessing.`
        : "";
      setStatusAndLog(`Desktop import completed for ${analysisPayload.length} file(s) and applied to ${effectiveDesktopImportTargetLayerIds.length} layer(s).${cacheSummary}`);
      if (analysisPayload[0]?.note) {
        appendDiagnosticsLog(`Pitch analysis: ${analysisPayload[0].note}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Desktop preprocessing failed.";
      setStatusAndLog(message);
    }
  }

  async function handleGenerateStems(layerId = project.selectedLayerId) {
    if (!isDesktopHost()) {
      setStatusAndLog("Stem generation is available in the desktop host only.");
      return;
    }

    const layer = project.layers.find((entry) => entry.id === layerId) ?? selectedLayer;
    const inputPath = layer.originalInputPath ?? layer.displaySourcePath ?? layer.sourcePath;
    if (!inputPath) {
      setStatusAndLog("Select a media layer with a source file before generating stems.");
      return;
    }

    try {
      setProcessingContext({
        targetLayerIds: [layerId],
        stemModel: project.stemSeparatorModel,
        pitchModel: project.pitchDetectorModel,
        pitchSourceKind: project.pitchAnalysisSource,
        processingDevice: project.processingDevice
      });
      setStatusAndLog(`Generating stems for ${layer.name} using ${project.stemSeparatorModel} on ${formatProcessingDeviceLabel(project.processingDevice)}${project.bypassPreprocessingCache ? " with cache bypass enabled" : ""}...`);
      const [payload] = await analyzeDesktopMediaFilesWithOptions([inputPath], {
        separateStems: true,
        stemModel: project.stemSeparatorModel,
        pitchModel: project.pitchDetectorModel,
        pitchSourceKind: project.pitchAnalysisSource,
        processingDevice: project.processingDevice,
        bypassCache: project.bypassPreprocessingCache
      });
      if (!payload) {
        return;
      }

      setProject((current) => assignImportedMedia(selectLayer(current, layerId), "selected", [desktopAnalysisToImportPayload(payload)]));
      setStatusAndLog(`Generated stem mappings for ${layer.name}. ${payload.cache_status === "hit" ? "Used cached preprocessing where available." : "Fresh stem separation and pitch caching completed."}`);
      appendDiagnosticsLog(`Pitch analysis: ${payload.note}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stem generation failed.";
      setStatusAndLog(message);
    }
  }

  async function handleRecentFileReopen(path: string) {
    if (!isDesktopHost()) {
      setStatusAndLog("Recent file reopen is available in the desktop host only.");
      return;
    }

    try {
      setProcessingContext({
        targetLayerIds: [project.selectedLayerId],
        stemModel: project.stemSeparatorModel,
        pitchModel: project.pitchDetectorModel,
        pitchSourceKind: project.pitchAnalysisSource,
        processingDevice: project.processingDevice
      });
      setStatusAndLog(`Reopening ${path.split(/[/\\]/).at(-1) ?? path} through desktop preprocessing on ${formatProcessingDeviceLabel(project.processingDevice)}${project.bypassPreprocessingCache ? " with cache bypass enabled" : ""}...`);
      const [payload] = await analyzeDesktopMediaFilesWithOptions([path], {
        separateStems: true,
        stemModel: project.stemSeparatorModel,
        pitchModel: project.pitchDetectorModel,
        pitchSourceKind: project.pitchAnalysisSource,
        processingDevice: project.processingDevice,
        bypassCache: project.bypassPreprocessingCache
      });
      if (!payload) {
        return;
      }

      setProject((current) => assignImportedMedia(current, "selected", [desktopAnalysisToImportPayload(payload)]));
      setStatusAndLog(`Reopened ${path.split(/[/\\]/).at(-1) ?? path} into the selected layer.`);
      appendDiagnosticsLog(`Pitch analysis: ${payload.note}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reopen failed.";
      setStatusAndLog(message);
    }
  }

  function handleLoadDemo() {
    setProject(createDemoProject(STAGE_WIDTH, STAGE_HEIGHT));
    setStatusAndLog("Loaded scripted demo workspace for overlay and synchronization verification.");
  }

  function performOnTargets(layerId: string, action: (element: HTMLMediaElement) => void, playing: boolean) {
    const targetIds = getPlaybackTargetLayerIds(project, layerId);

    targetIds.forEach((targetId) => {
      for (const element of getPlaybackElements(targetId)) {
        action(element);
      }
    });

    setProject((current) => setLayersPlaying(current, targetIds, playing));
  }

  function handlePlay(layerId = project.selectedLayerId, allowFallback = true) {
    const targetIds = getPlaybackTargetLayerIds(project, layerId);
    let startedAnyPlayback = false;

    targetIds.forEach((targetId) => {
      const layer = project.layers.find((entry) => entry.id === targetId);
      if (!layer) {
        return;
      }

      getPlaybackElements(targetId).forEach((element, index) => {
        const channel = layer.mediaKind === "video" && index === 0 ? "video" : "audio";
        const source = element.currentSrc || element.getAttribute("src") || "";

        if (!source) {
          setStatusAndLog(`${layer.name} ${channel} has no playable source loaded.`);
          return;
        }

        const playback = element.play();
        if (!playback) {
          startedAnyPlayback = true;
          return;
        }

        startedAnyPlayback = true;

        void playback
          .catch((error) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const canFallbackToNormalized = allowFallback
              && channel === "audio"
              && layer.mediaKind === "video"
              && getActiveSourceKind(layer) === "original"
              && layer.availableSources.some((sourceEntry) => sourceEntry.kind === "normalized");

            if (canFallbackToNormalized) {
              handleLayerSourceChange(layer, "normalized");
              setStatusAndLog(`${layer.name} original container audio could not play. Switched playback to normalized audio and retrying.`);
              schedulePlaybackRetry(targetId);
              return;
            }

            setStatusAndLog(`${layer.name} ${channel} playback failed: ${errorMessage}`);
          });
      });
    });

    if (targetIds.length && startedAnyPlayback) {
      setProject((current) => setLayersPlaying(current, targetIds, true));
    }
  }

  function handlePause(layerId = project.selectedLayerId) {
    performOnTargets(layerId, (element) => {
      element.pause();
    }, false);
  }

  function handleStop(layerId = project.selectedLayerId) {
    const targetIds = getPlaybackTargetLayerIds(project, layerId);

    targetIds.forEach((targetId) => {
      for (const element of getPlaybackElements(targetId)) {
        element.pause();
        element.currentTime = 0;
      }
    });

    setProject((current) => seekLayers(setLayersPlaying(current, targetIds, false), targetIds, 0));
  }

  function handleSeek(deltaSeconds: number, layerId = project.selectedLayerId) {
    const sourceLayer = project.layers.find((layer) => layer.id === layerId) ?? selectedLayer;
    const targetIds = getPlaybackTargetLayerIds(project, layerId);
    const nextTime = Math.max(0, Math.min(sourceLayer.duration || Number.MAX_SAFE_INTEGER, sourceLayer.playbackPosition + deltaSeconds));

    targetIds.forEach((targetId) => {
      for (const element of getPlaybackElements(targetId)) {
        element.pause();
        element.currentTime = nextTime;
      }
    });

    setProject((current) => seekLayers(current, targetIds, nextTime));
  }

  function handleScrub(layerId: string, playbackPosition: number) {
    const targetIds = getPlaybackTargetLayerIds(project, layerId);

    targetIds.forEach((targetId) => {
      for (const element of getPlaybackElements(targetId)) {
        element.currentTime = playbackPosition;
      }
    });

    setProject((current) => seekLayers(current, targetIds, playbackPosition));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PitchView</p>
          <h1>Desktop-first vocal comparison workspace</h1>
          <p className="status-copy">{statusMessage}</p>
          <div className="preprocess-progress-card" aria-live="polite">
            <div className="preprocess-progress-header">
              <span className="preprocess-progress-title">{preprocessingProgress.title}</span>
              <span className="preprocess-progress-value">{preprocessingProgress.value}%</span>
            </div>
            <div
              className="preprocess-progress-track"
              role="progressbar"
              aria-label={`${preprocessingProgress.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={preprocessingProgress.value}
              aria-valuetext={`${preprocessingProgress.title}: ${preprocessingProgress.status}`}
            >
              <span className="preprocess-progress-fill" style={{ width: `${preprocessingProgress.value}%` }} />
            </div>
            <p className="preprocess-progress-status">{preprocessingProgress.status}</p>
            <div className="preprocess-progress-meta">
              <span>Targets: {effectiveProcessingContext.targetLayerIds.length || 0}</span>
              <span>Stem model: {effectiveProcessingContext.stemModel} ({getStemModelOutputCount(effectiveProcessingContext.stemModel)} stems)</span>
              <span>Pitch model: {effectiveProcessingContext.pitchModel} on {formatPitchSourceLabel(effectiveProcessingContext.pitchSourceKind)}</span>
              <span>Device: {formatProcessingDeviceLabel(effectiveProcessingContext.processingDevice)}</span>
            </div>
          </div>
        </div>
        <div className="toolbar-actions wrap-actions">
          {!isDesktopHost() ? (
            <label className="file-picker-button icon-button" title="Import media" aria-label="Import media">
              <AppIcon name="import" />
              <span className="sr-only">Import media</span>
              <input type="file" accept="audio/*,video/*" multiple onChange={handleImport} />
            </label>
          ) : null}
          {!isDesktopHost() ? (
            <select
              className="toolbar-select"
              value={importTarget}
              title="Choose import target"
              aria-label="Choose import target"
              onChange={(event) => setImportTarget(event.target.value as ImportTarget)}
            >
              <option value="selected">Import to selected</option>
              <option value="synced">Import to synced</option>
              <option value="all">Import to all</option>
            </select>
          ) : null}
          <label className="toggle-row toolbar-toggle" title="Bypass cached stem separation and pitch preprocessing on the next desktop operations">
            <span>Bypass cache</span>
            <input
              type="checkbox"
              aria-label="Bypass preprocessing cache"
              checked={project.bypassPreprocessingCache}
              onChange={(event) => {
                const bypassPreprocessingCache = event.target.checked;
                setProject((current) => ({ ...current, bypassPreprocessingCache }));
              }}
            />
          </label>
          <IconButton icon="tile" label="Tile layers" onClick={() => setProject((current) => ({ ...current, layers: tileLayers(current.layers, STAGE_WIDTH, STAGE_HEIGHT) }))} />
          <IconButton icon="add" label="Add layer" onClick={() => setProject((current) => addLayer(current))} />
          <IconButton icon="play" label="Play" onClick={() => handlePlay()} />
          <IconButton icon="pause" label="Pause" onClick={() => handlePause()} />
          <IconButton icon="stop" label="Stop" onClick={() => handleStop()} />
          <IconButton icon="seekBack" label="Seek backward 2 seconds" onClick={() => handleSeek(-2)} />
          <IconButton icon="seekForward" label="Seek forward 2 seconds" onClick={() => handleSeek(2)} />
          <IconButton icon="demo" label="Load demo" onClick={() => handleLoadDemo()} />
        </div>
      </header>

      {isDesktopHost() ? (
        <section className="desktop-import-panel">
          <div className="panel-header">
            <h2>Desktop Import</h2>
            <span>{effectiveDesktopImportTargetLayerIds.length} target player(s)</span>
          </div>
          <div className="desktop-import-grid">
            <div className="desktop-import-field desktop-import-targets">
              <span className="desktop-import-field-label">Target players</span>
              <div className="desktop-import-target-list">
                {project.layers.map((layer) => {
                  const checked = effectiveDesktopImportTargetLayerIds.includes(layer.id);
                  return (
                    <label key={`desktop-target-${layer.id}`} className={checked ? "desktop-import-target desktop-import-target-active" : "desktop-import-target"}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDesktopImportTarget(layer.id)}
                      />
                      <span>{layer.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="desktop-import-field">
              <span className="desktop-import-field-label">Stem model</span>
              <select
                value={project.stemSeparatorModel}
                onChange={(event) => {
                  const stemSeparatorModel = event.target.value;
                  setProject((current) => ({ ...current, stemSeparatorModel }));
                }}
              >
                <option value="Vocals Mel-Band Roformer">Vocals Mel-Band Roformer</option>
                <option value="HTDemucs FT">HTDemucs FT</option>
                <option value="HTDemucs 6 Stem">HTDemucs 6 Stem</option>
                <option value="MDX23C">MDX23C</option>
                <option value="UVR MDX Karaoke">UVR MDX Karaoke</option>
                <option value="Spleeter 2 Stem">Spleeter 2 Stem</option>
                <option value="Open-Unmix">Open-Unmix</option>
              </select>
            </label>

            <label className="desktop-import-field">
              <span className="desktop-import-field-label">Pitch stem</span>
              <select
                value={project.pitchAnalysisSource}
                onChange={(event) => {
                  const pitchAnalysisSource = event.target.value as PitchAnalysisSourceKind;
                  setProject((current) => ({ ...current, pitchAnalysisSource }));
                }}
              >
                <option value="vocals">Vocals stem</option>
                <option value="other">Other stem</option>
                <option value="original">Original audio</option>
              </select>
            </label>

            <label className="desktop-import-field">
              <span className="desktop-import-field-label">Pitch model</span>
              <select
                value={project.pitchDetectorModel}
                onChange={(event) => {
                  const pitchDetectorModel = event.target.value;
                  setProject((current) => ({ ...current, pitchDetectorModel }));
                }}
              >
                <option value="yin">YIN</option>
                <option value="torch-cuda">TorchCrepe CUDA</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label className="desktop-import-field">
              <span className="desktop-import-field-label">Processing device</span>
              <select
                aria-label="Processing device"
                value={project.processingDevice}
                onChange={(event) => {
                  const processingDevice = event.target.value as ProcessingDeviceMode;
                  setProject((current) => ({ ...current, processingDevice }));
                }}
              >
                <option value="auto">Auto (prefer GPU)</option>
                <option value="gpu">GPU only when available</option>
                <option value="cpu">CPU only</option>
              </select>
            </label>
          </div>
          <p className="desktop-import-summary">{desktopImportSummary}</p>
          <div className="desktop-import-actions">
            <button type="button" onClick={() => void handleDesktopImport()}>Choose File And Import</button>
          </div>
        </section>
      ) : null}

      {project.recentFiles.length ? (
        <section className="recent-files-panel">
          <div className="panel-header">
            <h2>Recent Files</h2>
            <span>{project.recentFiles.length}</span>
          </div>
          <div className="recent-files-list">
            {project.recentFiles.map((path) => (
              <button key={path} className="recent-file-button" onClick={() => void handleRecentFileReopen(path)}>
                {path.split(/[/\\]/).at(-1) ?? path}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <main className="layout-grid">
        <section className="stage-panel">
          <div className="panel-header">
            <h2>Stage</h2>
            <span>{project.layers.length} portrait-leaning players</span>
          </div>
          <div className="stage" style={{ width: STAGE_WIDTH, height: STAGE_HEIGHT }}>
            {project.layers
              .slice()
              .sort((left, right) => left.zIndex - right.zIndex)
              .map((layer) => {
                const topLayerZIndex = project.layers.reduce((highest, entry) => Math.max(highest, entry.zIndex), 0) + 100;
                const viewportWidth = Math.max(layer.width - 28, 1);
                const pitchPlotLeftInset = getPitchPlotLeftInset(viewportWidth);
                const timeViewport = getLayerTimeViewport(layer);
                const amplitudePath = buildEnvelopePath(layer.amplitudeEnvelope, viewportWidth, 44, layer.duration, timeViewport.startTime, timeViewport.endTime);
                const pitchPath = buildPitchPath(layer, viewportWidth, 84, timeViewport.startTime, timeViewport.endTime, timeViewport.endTime);
                const progressPitchPath = buildPitchPath(layer, viewportWidth, 84, timeViewport.startTime, timeViewport.endTime, timeViewport.playheadTime);
                const pitchPoints = buildPitchPoints(layer, viewportWidth, 84, timeViewport.startTime, timeViewport.endTime);
                const playheadPercent = getPitchPlotLeftPercent(viewportWidth, timeViewport.startTime, timeViewport.endTime, timeViewport.playheadTime);
                const timelineTicks = buildTimelineTicks(timeViewport.startTime, timeViewport.endTime);
                const contourLineOpacity = clamp(0.16 + layer.pitchContourIntensity * 0.56, 0.16, 1);
                const contourProgressOpacity = clamp(0.24 + layer.pitchContourIntensity * 0.68, 0.24, 1);
                const contourWidth = clamp(layer.pitchContourWidth, 0.15, 1.8);
                const contourProgressWidth = clamp(layer.pitchContourWidth + 0.12, 0.2, 2);
                const contourStrokeColor = hexToRgba(layer.pitchContourColor, contourLineOpacity);
                const contourProgressColor = hexToRgba(layer.pitchContourColor, contourProgressOpacity);
                const amplitudeFillColor = hexToRgba(layer.pitchContourColor, clamp(0.08 + layer.pitchContourIntensity * 0.32, 0.08, 0.92));
                const amplitudeStrokeColor = hexToRgba(layer.pitchContourColor, clamp(0.42 + layer.pitchContourIntensity * 0.42, 0.42, 1));
                const contourViewportWidth = viewportWidth;
                const pitchScaleLabels = getPitchScaleLabels(layer);
                const selectedStemLabel = getSelectedStemLabel(layer);
                const effectiveZIndex = openMenuLayerId === layer.id ? topLayerZIndex : layer.zIndex;
                const activePitchTooltip = hoveredPitchPoint?.layerId === layer.id ? hoveredPitchPoint : null;
                const isDraggingLayer = stageInteraction?.layerId === layer.id && stageInteraction.mode === "drag";
                const isResizingLayer = stageInteraction?.layerId === layer.id && stageInteraction.mode === "resize";

                const layerCardStyle: CSSProperties & Record<"--layer-opacity", string> = {
                  left: layer.x,
                  top: layer.y,
                  width: layer.width,
                  height: layer.height,
                  zIndex: effectiveZIndex,
                  "--layer-opacity": layer.opacity.toString()
                };
                const mediaPlaneStyle: CSSProperties = {
                  opacity: layer.opacity,
                  background: `rgba(0, 0, 0, ${layer.opacity.toFixed(3)})`
                };

                return (
                  <div
                    key={layer.id}
                    data-testid={`layer-card-${layer.id}`}
                    className={[
                      "layer-card",
                      layer.id === project.selectedLayerId ? "layer-card-selected" : "",
                      isDraggingLayer ? "layer-card-dragging" : "",
                      isResizingLayer ? "layer-card-resizing" : ""
                    ].filter(Boolean).join(" ")}
                    style={layerCardStyle}
                    onClick={() => focusLayer(layer.id)}
                  >
                    <div
                      className="layer-card-header"
                      data-testid={`layer-header-${layer.id}`}
                      onPointerDown={(event) => handleLayerDragStart(event, layer)}
                    >
                      <div>
                        <strong>{layer.name}</strong>
                        <span className="layer-mode-copy">{layer.syncLocked ? "Synced" : "Free"}</span>
                      </div>
                      <div className="layer-header-actions">
                        {isDesktopHost() ? (
                          <IconButton
                            icon="stems"
                            label={`Generate stems for ${layer.name}`}
                            className="mini-icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setProject((current) => selectLayer(current, layer.id));
                              void handleGenerateStems(layer.id);
                            }}
                          />
                        ) : null}
                        <IconButton
                          icon="menu"
                          label={`Open menu for ${layer.name}`}
                          className="mini-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setProject((current) => selectLayer(current, layer.id));
                            setOpenMenuLayerId((current) => current === layer.id ? null : layer.id);
                          }}
                        />
                        <IconButton
                          icon="close"
                          label={`Remove ${layer.name}`}
                          className="layer-remove-button mini-icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setProject((current) => removeLayer(current, layer.id));
                          }}
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      className="layer-resize-handle"
                      data-testid={`layer-resize-${layer.id}`}
                      aria-label={`Resize ${layer.name}`}
                      title={`Resize ${layer.name}`}
                      onPointerDown={(event) => handleLayerResizeStart(event, layer)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="layer-resize-handle-lines" aria-hidden="true" />
                    </button>

                    {openMenuLayerId === layer.id ? (
                      <div
                        className={getLayerMenuClassName(layer)}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="layer-menu-header">
                          <div className="layer-menu-title-group">
                            <strong>{layer.name} settings</strong>
                            <span>{layer.mediaKind === "none" ? "No media" : layer.mediaKind}</span>
                          </div>
                          <IconButton
                            icon="close"
                            label={`Close menu for ${layer.name}`}
                            className="layer-menu-close mini-icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenMenuLayerId((current) => current === layer.id ? null : current);
                            }}
                          />
                        </div>

                        <div className="layer-menu-grid">
                          <label>
                            <span>Label</span>
                            <input
                              value={layer.mediaLabel}
                              onChange={(event) => patchLayer(layer.id, { mediaLabel: event.target.value })}
                            />
                          </label>

                          <label>
                            <span>Mix</span>
                            <select
                              value={layer.mixMode}
                              onChange={(event) => patchLayer(layer.id, { mixMode: event.target.value as PlayerLayer["mixMode"] })}
                            >
                              <option value="blend">Blend</option>
                              <option value="solo">Solo</option>
                              <option value="mute">Mute</option>
                            </select>
                          </label>

                          <label>
                            <span>Source</span>
                            <select
                              value={getActiveSourceKind(layer)}
                              onChange={(event) => {
                                const nextSourceKind = event.target.value as PlayerLayer["availableSources"][number]["kind"];
                                handleLayerSourceChange(layer, nextSourceKind);
                              }}
                            >
                              {layer.availableSources.map((source) => (
                                <option key={`${layer.id}-${source.kind}`} value={source.kind}>
                                  {source.label}
                                </option>
                              ))}
                            </select>
                          </label>

                          <div className="desktop-import-field layer-analysis-readout">
                            <span>Analysis source</span>
                            <strong>{formatPitchSourceLabel(layer.analysisSourceKind)}</strong>
                          </div>

                          <label>
                            <span>Contour color</span>
                            <input
                              type="color"
                              value={layer.pitchContourColor}
                              onChange={(event) => patchLayer(layer.id, { pitchContourColor: event.target.value })}
                            />
                          </label>

                          <label>
                            <span>Stem target</span>
                            <select
                              value={layer.stemTarget}
                              onChange={(event) => patchLayer(layer.id, { stemTarget: event.target.value as PlayerLayer["stemTarget"] })}
                            >
                              <option value="original">Original</option>
                              <option value="vocals">Vocals</option>
                              <option value="other">Other</option>
                            </select>
                          </label>

                          <label>
                            <span>Stem model</span>
                            <select
                              value={project.stemSeparatorModel}
                              onChange={(event) => {
                                const nextStemModel = event.target.value;
                                setProject((current) => ({ ...current, stemSeparatorModel: nextStemModel }));
                              }}
                            >
                              <option value="Vocals Mel-Band Roformer">Vocals Mel-Band Roformer</option>
                              <option value="HTDemucs FT">HTDemucs FT</option>
                              <option value="HTDemucs 6 Stem">HTDemucs 6 Stem</option>
                              <option value="MDX23C">MDX23C</option>
                              <option value="UVR MDX Karaoke">UVR MDX Karaoke</option>
                              <option value="Spleeter 2 Stem">Spleeter 2 Stem</option>
                              <option value="Open-Unmix">Open-Unmix</option>
                            </select>
                          </label>
                        </div>

                        <div className="layer-menu-grid sliders-grid">
                          <label>
                            <span>Opacity</span>
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.05"
                              value={layer.opacity}
                              onChange={(event) => patchLayer(layer.id, { opacity: Number(event.target.value) })}
                            />
                          </label>

                          <label>
                            <span>Pitch span</span>
                            <input
                              type="range"
                              min="12"
                              max="48"
                              step="1"
                              value={layer.pitchSpan}
                              onChange={(event) => patchLayer(layer.id, { pitchSpan: Number(event.target.value) })}
                            />
                          </label>

                          <label>
                            <span>Pitch center</span>
                            <input
                              type="range"
                              min="-24"
                              max="24"
                              step="1"
                              value={layer.pitchCenterOffset}
                              onChange={(event) => patchLayer(layer.id, { pitchCenterOffset: Number(event.target.value) })}
                            />
                          </label>

                          <label>
                            <span>Key</span>
                            <select
                              aria-label={`Key for ${layer.name}`}
                              value={layer.pitchKey}
                              onChange={(event) => patchLayer(layer.id, { pitchKey: event.target.value as MusicalKey })}
                            >
                              {CIRCLE_OF_FIFTHS_KEYS.map((key) => (
                                <option key={key} value={key}>{key}</option>
                              ))}
                            </select>
                          </label>

                          <label>
                            <span>Scale</span>
                            <select
                              aria-label={`Scale for ${layer.name}`}
                              value={layer.pitchScaleMode}
                              onChange={(event) => patchLayer(layer.id, { pitchScaleMode: event.target.value as PitchScaleMode })}
                            >
                              <option value="chromatic">Chromatic</option>
                              <option value="major">Major</option>
                              <option value="minor">Minor</option>
                            </select>
                          </label>

                          <label>
                            <span>Contour width</span>
                            <input
                              type="range"
                              min="0.15"
                              max="1.8"
                              step="0.025"
                              value={layer.pitchContourWidth}
                              onChange={(event) => patchLayer(layer.id, { pitchContourWidth: Number(event.target.value) })}
                            />
                          </label>

                          <label>
                            <span>Contour intensity</span>
                            <input
                              type="range"
                              min="0.15"
                              max="2.5"
                              step="0.05"
                              value={layer.pitchContourIntensity}
                              onChange={(event) => patchLayer(layer.id, { pitchContourIntensity: Number(event.target.value) })}
                            />
                          </label>
                        </div>

                        <div className="layer-menu-grid compact-grid">
                          <label>
                            <span>Center mode</span>
                            <select
                              value={layer.pitchCenterMode}
                              onChange={(event) => patchLayer(layer.id, { pitchCenterMode: event.target.value as PlayerLayer["pitchCenterMode"] })}
                            >
                              <option value="adaptive">Adaptive</option>
                              <option value="fixed">Fixed</option>
                            </select>
                          </label>

                          <label className="toggle-row menu-toggle-row">
                            <span>Sync lock</span>
                            <input
                              type="checkbox"
                              checked={layer.syncLocked}
                              onChange={(event) => patchLayer(layer.id, { syncLocked: event.target.checked })}
                            />
                          </label>
                        </div>

                        <div className="layer-menu-actions">
                          <IconButton
                            icon="forward"
                            label={`Bring ${layer.name} forward`}
                            onClick={() => setProject((current) => moveLayer(current, layer.id, "forward"))}
                          />
                          <IconButton
                            icon="backward"
                            label={`Send ${layer.name} backward`}
                            onClick={() => setProject((current) => moveLayer(current, layer.id, "backward"))}
                          />
                        </div>
                      </div>
                    ) : null}

                    <div className="layer-display" data-testid={`layer-display-${layer.id}`}>
                      <div className="media-shell">
                        <div className="media-main" style={{ width: contourViewportWidth }} data-testid={`media-main-${layer.id}`}>
                          <div className="layer-hover-meta" aria-hidden="true">
                            <span className="layer-hover-pill layer-hover-track">{layer.mediaLabel}</span>
                            <span className="layer-hover-pill layer-hover-stem">Stem: {selectedStemLabel}</span>
                          </div>

                          <div className="media-visual-stage">
                            <aside className="layer-note-scale" aria-hidden="true">
                              <span className="rail-label">Scale</span>
                              <div className="note-scale-list">
                                {pitchScaleLabels.map((entry) => (
                                  <span
                                    key={`${layer.id}-${entry.noteLabel}-${entry.frequency}`}
                                    className={entry.isPrimary
                                      ? `note-scale-mark${entry.isInScale ? " note-scale-mark-in-scale note-scale-mark-primary" : " note-scale-mark-primary"}`
                                      : `note-scale-mark${entry.isInScale ? " note-scale-mark-in-scale" : ""}`}
                                    style={{ top: `${entry.positionPercent}%` }}
                                  >
                                    <span className="note-scale-guide" />
                                    <span className={entry.isInScale ? "note-scale-note note-scale-note-in-scale" : "note-scale-note"}>{entry.noteLabel}</span>
                                  </span>
                                ))}
                              </div>
                            </aside>

                          {layer.mediaKind === "video" && layer.mediaSourceUrl ? (
                            <div className="media-content-plane" data-testid={`media-content-${layer.id}`} style={mediaPlaneStyle}>
                              <video
                                key={`visual-${layer.id}-${layer.displaySourceUrl ?? layer.mediaSourceUrl ?? "none"}`}
                                ref={(element) => setMediaElement(layer.id, "visual", element)}
                                className="media-preview"
                                src={layer.displaySourceUrl ?? layer.mediaSourceUrl}
                                preload="auto"
                                playsInline
                                muted
                                onError={(event) => logMediaElementError(layer, "video", event.currentTarget)}
                                onLoadedMetadata={handleMediaLoadedMetadata(layer)}
                                onLoadedData={handleVideoLoadedData(layer)}
                              />
                              <audio
                                key={`audio-${layer.id}-${layer.mediaSourceUrl ?? "none"}`}
                                ref={(element) => setMediaElement(layer.id, "audio", element)}
                                src={layer.mediaSourceUrl}
                                preload="metadata"
                                onError={(event) => logMediaElementError(layer, "audio", event.currentTarget)}
                                onLoadedMetadata={handleMediaLoadedMetadata(layer)}
                                onTimeUpdate={(event) => {
                                  const { currentTime, duration } = event.currentTarget;
                                  setProject((current) => updateLayerTime(current, layer.id, currentTime, duration));
                                }}
                                onPlay={() => setProject((current) => updateLayer(current, layer.id, { isPlaying: true }))}
                                onPause={() => setProject((current) => updateLayer(current, layer.id, { isPlaying: false }))}
                              />
                            </div>
                          ) : layer.mediaSourceUrl ? (
                            <div className="media-content-plane" data-testid={`media-content-${layer.id}`} style={mediaPlaneStyle}>
                              <audio
                                key={`audio-${layer.id}-${layer.mediaSourceUrl ?? "none"}`}
                                ref={(element) => setMediaElement(layer.id, "audio", element)}
                                src={layer.mediaSourceUrl}
                                preload="metadata"
                                muted={layer.mixMode === "mute"}
                                onError={(event) => logMediaElementError(layer, "audio", event.currentTarget)}
                                onLoadedMetadata={handleMediaLoadedMetadata(layer)}
                                onTimeUpdate={(event) => {
                                  const { currentTime, duration } = event.currentTarget;
                                  setProject((current) => updateLayerTime(current, layer.id, currentTime, duration));
                                }}
                                onPlay={() => setProject((current) => updateLayer(current, layer.id, { isPlaying: true }))}
                                onPause={() => setProject((current) => updateLayer(current, layer.id, { isPlaying: false }))}
                              />
                              <div className="audio-placeholder">Audio loaded</div>
                            </div>
                          ) : (
                            <div className="audio-placeholder">No media loaded</div>
                          )}

                          <div className="overlay-stack" style={{ "--pitch-plot-left-inset": `${pitchPlotLeftInset}px` } as CSSProperties}>
                              <div className="pitch-overlay-viewport">
                                <div className="pitch-overlay-content">
                                  <div className="pitch-grid" aria-hidden="true">
                                    {pitchScaleLabels.filter((entry) => entry.isPrimary).map((entry) => (
                                      <span
                                        key={`${layer.id}-grid-${entry.noteLabel}-${entry.frequency}`}
                                        className={[
                                          "pitch-grid-line",
                                          entry.isCenter ? "pitch-grid-line-center" : "",
                                          entry.isInScale ? "pitch-grid-line-in-scale" : ""
                                        ].filter(Boolean).join(" ")}
                                        style={{ top: `${entry.positionPercent}%` }}
                                      />
                                    ))}
                                  </div>
                                  <svg className="pitch-overlay" viewBox={`0 0 ${viewportWidth} 84`} preserveAspectRatio="none">
                                    {pitchPath ? (
                                      <path
                                        className="pitch-overlay-line"
                                        d={pitchPath}
                                        style={{ stroke: contourStrokeColor, strokeWidth: contourWidth }}
                                      />
                                    ) : null}
                                    {progressPitchPath && progressPitchPath !== pitchPath ? (
                                      <path
                                        className="pitch-overlay-progress"
                                        d={progressPitchPath}
                                        style={{ stroke: contourProgressColor, strokeWidth: contourProgressWidth }}
                                      />
                                    ) : null}
                                    {pitchPoints.map((point) => {
                                      const isActive = activePitchTooltip?.index === point.index;
                                      const tooltipLabel = `${point.noteLabel}, ${formatTooltipFrequency(point.frequency)}, ${formatSemitoneOffset(point.semitoneOffset)}, ${formatTooltipSeconds(point.timeSeconds)}`;

                                      return (
                                        <circle
                                          key={`${layer.id}-pitch-point-${point.index}`}
                                          className={isActive ? "pitch-point-marker pitch-point-marker-active" : "pitch-point-marker"}
                                          data-layer-id={layer.id}
                                          data-point-index={point.index}
                                          data-time-seconds={point.timeSeconds.toFixed(6)}
                                          data-frequency-hz={point.frequency.toFixed(6)}
                                          cx={point.x}
                                          cy={point.y}
                                          r={isActive ? 1.7 : 1.05}
                                          style={{ fill: contourProgressColor }}
                                          tabIndex={0}
                                          aria-label={`Pitch point ${tooltipLabel}`}
                                          onMouseEnter={() => setHoveredPitchPoint({
                                            ...point,
                                            layerId: layer.id,
                                            leftPercent: contourViewportWidth > 0 ? (point.x / contourViewportWidth) * 100 : 0,
                                            topPercent: (point.y / 84) * 100
                                          })}
                                          onMouseLeave={() => setHoveredPitchPoint((current) => (current?.layerId === layer.id && current.index === point.index ? null : current))}
                                          onFocus={() => setHoveredPitchPoint({
                                            ...point,
                                            layerId: layer.id,
                                            leftPercent: contourViewportWidth > 0 ? (point.x / contourViewportWidth) * 100 : 0,
                                            topPercent: (point.y / 84) * 100
                                          })}
                                          onBlur={() => setHoveredPitchPoint((current) => (current?.layerId === layer.id && current.index === point.index ? null : current))}
                                        />
                                      );
                                    })}
                                  </svg>
                                </div>
                              </div>
                              <div className="player-progress-shell" onClick={(event) => event.stopPropagation()}>
                                <span className="player-progress-time">{formatSeconds(layer.playbackPosition)}</span>
                                <div className="player-progress-center">
                                  <input
                                    type="range"
                                    className="player-progress-slider"
                                    aria-label={`Seek ${layer.name}`}
                                    min="0"
                                    max={Math.max(layer.duration, 1)}
                                    step="0.01"
                                    value={layer.playbackPosition}
                                    onChange={(event) => handleScrub(layer.id, Number(event.target.value))}
                                  />
                                  <div className="player-timeline-scale" aria-hidden="true">
                                    {timelineTicks.map((tick) => {
                                      const leftPercent = getPitchPlotLeftPercent(viewportWidth, timeViewport.startTime, timeViewport.endTime, tick);

                                      return (
                                        <span
                                          key={`${layer.id}-timeline-tick-${tick}`}
                                          className="player-timeline-tick"
                                          style={{ left: `${leftPercent}%` }}
                                        >
                                          <span className="player-timeline-label">{formatSeconds(tick)}</span>
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                                <span className="player-progress-time">{formatSeconds(layer.duration)}</span>
                              </div>
                              {activePitchTooltip ? (
                                <>
                                  <span
                                    className="pitch-guide-line pitch-guide-line-vertical"
                                    aria-hidden="true"
                                    style={{
                                      left: `${activePitchTooltip.leftPercent}%`,
                                      borderColor: contourProgressColor
                                    }}
                                  />
                                  <span
                                    className="pitch-guide-line pitch-guide-line-horizontal"
                                    aria-hidden="true"
                                    style={{
                                      top: `${activePitchTooltip.topPercent}%`,
                                      borderColor: contourProgressColor
                                    }}
                                  />
                                </>
                              ) : null}
                              {activePitchTooltip ? (
                                <div
                                  className="pitch-point-tooltip"
                                  role="tooltip"
                                  style={{
                                    left: `${activePitchTooltip.leftPercent}%`,
                                    top: `${activePitchTooltip.topPercent}%`
                                  }}
                                >
                                  <strong>{activePitchTooltip.noteLabel}</strong>
                                  <span>{formatTooltipFrequency(activePitchTooltip.frequency)}</span>
                                  <span>{formatSemitoneOffset(activePitchTooltip.semitoneOffset)}</span>
                                  <span>{formatTooltipSeconds(activePitchTooltip.timeSeconds)}</span>
                                </div>
                              ) : null}
                              <span className="timeline-playhead media-playhead" style={{ left: `${playheadPercent}%` }} />
                            </div>
                          </div>
                          <div className="player-footer-shell">
                            <div className="media-envelope-shell-row">
                              <div
                                className="media-envelope-shell"
                                data-testid={`media-envelope-shell-${layer.id}`}
                                style={{
                                  width: contourViewportWidth,
                                  borderColor: `rgba(239, 244, 239, ${(0.12 * layer.opacity).toFixed(3)})`
                                }}
                              >
                                <div className="media-envelope-plane" aria-hidden="true" style={mediaPlaneStyle} />
                                <svg className="amplitude-strip media-envelope-strip" viewBox={`0 0 ${viewportWidth} 44`} preserveAspectRatio="none">
                                  {amplitudePath ? <path d={amplitudePath} style={{ fill: amplitudeFillColor, stroke: amplitudeStrokeColor }} /> : null}
                                </svg>
                                <span className="timeline-playhead media-envelope-playhead" style={{ left: `${playheadPercent}%` }} />
                              </div>
                            </div>
                            <div className="player-transport-shell" onClick={(event) => event.stopPropagation()}>
                              <div className="layer-transport-actions player-transport-actions">
                              <IconButton
                                icon="seekBack"
                                label={`Seek ${layer.name} backward 2 seconds`}
                                className="mini-icon-button player-transport-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setProject((current) => selectLayer(current, layer.id));
                                  handleSeek(-2, layer.id);
                                }}
                              />
                              <IconButton
                                icon={layer.isPlaying ? "pause" : "play"}
                                label={`${layer.isPlaying ? "Pause" : "Play"} ${layer.name}`}
                                className="mini-icon-button player-transport-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setProject((current) => selectLayer(current, layer.id));
                                  if (layer.isPlaying) {
                                    handlePause(layer.id);
                                    return;
                                  }
                                  handlePlay(layer.id);
                                }}
                              />
                              <IconButton
                                icon="stop"
                                label={`Stop ${layer.name}`}
                                className="mini-icon-button player-transport-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setProject((current) => selectLayer(current, layer.id));
                                  handleStop(layer.id);
                                }}
                              />
                                <IconButton
                                  icon="seekForward"
                                  label={`Seek ${layer.name} forward 2 seconds`}
                                  className="mini-icon-button player-transport-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setProject((current) => selectLayer(current, layer.id));
                                    handleSeek(2, layer.id);
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>

          <section className="diagnostics-panel" aria-label="Diagnostics log">
            <div className="panel-header diagnostics-header">
              <div>
                <h2>Diagnostics Log</h2>
                <p className="status-copy">Scrolls under the stage, mirrors desktop preprocessing output, and clears with Ctrl+Shift+L.</p>
              </div>
              <div className="diagnostics-actions">
                <button type="button" className="diagnostics-button" onClick={() => void handleCopyDiagnosticsLog()}>
                  Copy Log
                </button>
                <button type="button" className="diagnostics-button diagnostics-button-muted" onClick={() => void handleClearDiagnosticsLog()}>
                  Clear Log
                </button>
              </div>
            </div>
            <pre ref={diagnosticsLogRef} className="diagnostics-log" tabIndex={0} onScroll={handleDiagnosticsScroll}>
              {diagnosticsEntries.length ? diagnosticsEntries.join("\n") : "Diagnostics log is empty."}
            </pre>
          </section>
        </section>
      </main>
    </div>
  );
}

export default App;
