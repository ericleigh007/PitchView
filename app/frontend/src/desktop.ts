import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { LayerSource, MediaKind, PitchAnalysisSourceKind, ProcessingDeviceMode, WorkspaceProject } from "./types";

export type DesktopAnalysisPayload = {
  input: string;
  cache_status?: string;
  media_kind?: MediaKind;
  analysis_source?: {
    kind: PitchAnalysisSourceKind;
    path: string;
  };
  playback_audio?: string;
  display_video?: string | null;
  duration_seconds?: number;
  normalized_audio: string;
  analysis_json: string;
  sources: Array<Pick<LayerSource, "kind" | "label" | "path">>;
  amplitudes: number[];
  pitch_hz: number[];
  confidence: number[];
  pitch_model_requested?: string;
  pitch_model_used?: string;
  note: string;
};

export type DesktopAnalyzeOptions = {
  separateStems?: boolean;
  stemModel?: string;
  pitchModel?: string;
  pitchSourceKind?: PitchAnalysisSourceKind;
  processingDevice?: ProcessingDeviceMode;
  bypassCache?: boolean;
};

function readStringField(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Desktop preprocessing returned an invalid ${fieldName} field.`);
  }

  return value;
}

function readNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "number" ? entry : Number(entry)))
    .filter((entry) => Number.isFinite(entry));
}

function readDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function readMediaKind(value: unknown): MediaKind | undefined {
  if (value === "audio" || value === "video") {
    return value;
  }

  return undefined;
}

function probeHasVideoStream(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const streams = (value as Record<string, unknown>).streams;
  if (!Array.isArray(streams)) {
    return false;
  }

  return streams.some((stream) => stream && typeof stream === "object" && (stream as Record<string, unknown>).codec_type === "video");
}

function readSources(value: unknown): DesktopAnalysisPayload["sources"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      kind: readStringField(entry.kind, "source.kind") as LayerSource["kind"],
      label: readStringField(entry.label, "source.label"),
      path: readStringField(entry.path, "source.path")
    }));
}

function normalizeDesktopAnalysisPayload(value: unknown): DesktopAnalysisPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Desktop preprocessing returned an invalid payload.");
  }

  const payload = value as Record<string, unknown>;

  return {
    input: readStringField(payload.input, "input"),
    cache_status: typeof payload.cache_status === "string" ? payload.cache_status : undefined,
    media_kind: readMediaKind(payload.media_kind) ?? (probeHasVideoStream(payload.probe) || typeof payload.display_video === "string" ? "video" : "audio"),
    analysis_source: payload.analysis_source && typeof payload.analysis_source === "object"
      ? {
        kind: readStringField((payload.analysis_source as Record<string, unknown>).kind, "analysis_source.kind") as PitchAnalysisSourceKind,
        path: readStringField((payload.analysis_source as Record<string, unknown>).path, "analysis_source.path")
      }
      : undefined,
    playback_audio: typeof payload.playback_audio === "string" ? payload.playback_audio : undefined,
    display_video: typeof payload.display_video === "string" ? payload.display_video : null,
    duration_seconds: readDurationSeconds((payload.probe as Record<string, unknown> | undefined)?.format && ((payload.probe as Record<string, unknown>).format as Record<string, unknown>).duration),
    normalized_audio: readStringField(payload.normalized_audio, "normalized_audio"),
    analysis_json: readStringField(payload.analysis_json, "analysis_json"),
    sources: readSources(payload.sources),
    amplitudes: readNumberArray(payload.amplitudes),
    pitch_hz: readNumberArray(payload.pitch_hz),
    confidence: readNumberArray(payload.confidence),
    pitch_model_requested: typeof payload.pitch_model_requested === "string" ? payload.pitch_model_requested : undefined,
    pitch_model_used: typeof payload.pitch_model_used === "string" ? payload.pitch_model_used : undefined,
    note: typeof payload.note === "string" ? payload.note : "Desktop preprocessing completed."
  };
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: object;
};

export function isDesktopHost(): boolean {
  return typeof window !== "undefined" && Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

export function toDesktopMediaUrl(path: string): string {
  return convertFileSrc(path);
}

export async function pickDesktopMediaFiles(): Promise<string[]> {
  return invoke<string[]>("pick_media_files");
}

export async function analyzeDesktopMediaFilesWithOptions(paths: string[], options: DesktopAnalyzeOptions = {}): Promise<DesktopAnalysisPayload[]> {
  const payload = await invoke<unknown[]>("analyze_media_files", {
    paths,
    separateStems: options.separateStems,
    stemModel: options.stemModel,
    pitchModel: options.pitchModel,
    pitchSourceKind: options.pitchSourceKind,
    processingDevice: options.processingDevice,
    bypassCache: options.bypassCache
  });
  return payload.map(normalizeDesktopAnalysisPayload);
}

export async function analyzeDesktopMediaFiles(paths: string[], bypassCache = false): Promise<DesktopAnalysisPayload[]> {
  return analyzeDesktopMediaFilesWithOptions(paths, { bypassCache });
}

export async function analyzeDesktopMediaFilesWithStems(paths: string[], stemModel: string, bypassCache = false): Promise<DesktopAnalysisPayload[]> {
  return analyzeDesktopMediaFilesWithOptions(paths, {
    separateStems: true,
    stemModel,
    bypassCache,
    pitchSourceKind: "vocals"
  });
}

export async function appendDesktopDiagnosticsEntry(message: string): Promise<void> {
  await invoke("append_diagnostics_entry", { message });
}

export async function readDesktopDiagnosticsLog(maxLines = 200): Promise<string[]> {
  return invoke<string[]>("read_diagnostics_log", { maxLines });
}

export async function clearDesktopDiagnosticsLog(): Promise<void> {
  await invoke("clear_diagnostics_log");
}

export async function saveDesktopProject(project: WorkspaceProject): Promise<void> {
  await invoke("save_project_state", {
    payload: {
      project_json: JSON.stringify(project)
    }
  });
}

export async function loadDesktopProject(): Promise<WorkspaceProject | null> {
  const payload = await invoke<string | null>("load_project_state");
  return payload ? JSON.parse(payload) as WorkspaceProject : null;
}
