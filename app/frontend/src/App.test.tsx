import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App";
import { createDefaultProject } from "./workspace";
import type { DesktopAnalysisPayload } from "./desktop";
import type { WorkspaceProject } from "./types";

const desktopMocks = vi.hoisted(() => ({
  analyzeDesktopMediaFiles: vi.fn(),
  analyzeDesktopMediaFilesWithOptions: vi.fn(),
  analyzeDesktopMediaFilesWithStems: vi.fn(),
  appendDesktopDiagnosticsEntry: vi.fn(),
  clearDesktopDiagnosticsLog: vi.fn(),
  isDesktopHost: vi.fn(),
  loadDesktopProject: vi.fn(),
  pickDesktopMediaFiles: vi.fn(),
  readDesktopDiagnosticsLog: vi.fn(),
  saveDesktopProject: vi.fn(),
  toDesktopMediaUrl: vi.fn()
}));

vi.mock("./desktop", () => ({
  analyzeDesktopMediaFiles: desktopMocks.analyzeDesktopMediaFiles,
  analyzeDesktopMediaFilesWithOptions: desktopMocks.analyzeDesktopMediaFilesWithOptions,
  analyzeDesktopMediaFilesWithStems: desktopMocks.analyzeDesktopMediaFilesWithStems,
  appendDesktopDiagnosticsEntry: desktopMocks.appendDesktopDiagnosticsEntry,
  clearDesktopDiagnosticsLog: desktopMocks.clearDesktopDiagnosticsLog,
  isDesktopHost: desktopMocks.isDesktopHost,
  loadDesktopProject: desktopMocks.loadDesktopProject,
  pickDesktopMediaFiles: desktopMocks.pickDesktopMediaFiles,
  readDesktopDiagnosticsLog: desktopMocks.readDesktopDiagnosticsLog,
  saveDesktopProject: desktopMocks.saveDesktopProject,
  toDesktopMediaUrl: desktopMocks.toDesktopMediaUrl
}));

function createSingleLayerProject(): WorkspaceProject {
  const project = createDefaultProject();
  return {
    ...project,
    selectedLayerId: project.layers[0].id,
    recentFiles: [],
    layers: [project.layers[0]]
  };
}

function createDesktopPayload(input: string, overrides: Partial<DesktopAnalysisPayload> = {}): DesktopAnalysisPayload {
  return {
    input,
    cache_status: "miss",
    playback_audio: "C:/cache/playback.wav",
    display_video: input.toLowerCase().endsWith(".mp4") ? "C:/cache/display.mp4" : null,
    duration_seconds: 12,
    normalized_audio: "C:/cache/normalized.wav",
    analysis_json: "C:/cache/analysis.json",
    sources: [
      { kind: "original", label: "Original", path: "C:/cache/playback.wav" },
      { kind: "normalized", label: "Normalized audio", path: "C:/cache/normalized.wav" }
    ],
    amplitudes: [0.2, 0.4],
    pitch_hz: [220, 221],
    confidence: [0.9, 0.9],
    analysis_source: { kind: "original", path: input },
    note: "ready",
    ...overrides
  };
}

function getPathStartX(pathData: string | null | undefined): number | null {
  if (!pathData) {
    return null;
  }

  const match = pathData.match(/^M([\d.]+),/);
  return match ? Number(match[1]) : null;
}

describe("App desktop regressions", () => {
  beforeEach(() => {
    window.localStorage.clear();

    desktopMocks.isDesktopHost.mockReturnValue(true);
    desktopMocks.loadDesktopProject.mockResolvedValue(createSingleLayerProject());
    desktopMocks.saveDesktopProject.mockResolvedValue(undefined);
    desktopMocks.readDesktopDiagnosticsLog.mockResolvedValue([]);
    desktopMocks.clearDesktopDiagnosticsLog.mockResolvedValue(undefined);
    desktopMocks.appendDesktopDiagnosticsEntry.mockResolvedValue(undefined);
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue([]);
    desktopMocks.analyzeDesktopMediaFiles.mockResolvedValue([]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions.mockResolvedValue([]);
    desktopMocks.analyzeDesktopMediaFilesWithStems.mockResolvedValue([]);
    desktopMocks.toDesktopMediaUrl.mockImplementation((path: string) => `file://${path.replace(/\\/g, "/")}`);

    Object.defineProperty(HTMLMediaElement.prototype, "pause", {
      configurable: true,
      value: vi.fn()
    });

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(undefined)
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("shows a titled preprocessing progress bar from diagnostics entries", async () => {
    desktopMocks.readDesktopDiagnosticsLog.mockResolvedValue([
      "[12:34:56.789] progress: stem-separating 35 prepared audio for separation"
    ]);

    render(<App />);

    const progressBar = await screen.findByRole("progressbar", { name: "Stem separation progress" });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("35");
    expect(await screen.findByText("Stem separation")).toBeTruthy();
    expect(await screen.findByText("Prepared audio for separation")).toBeTruthy();
  });

  test("resets preprocessing progress when a new desktop import starts", async () => {
    desktopMocks.readDesktopDiagnosticsLog.mockResolvedValue([
      "[12:34:56.789] phase: pitch-caching completed"
    ]);
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue(["C:/media/clip.mp4"]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions.mockImplementation(() => new Promise(() => {}));

    render(<App />);

    const completedProgressBar = await screen.findByRole("progressbar", { name: "Pitch detection preprocessing progress" });
    expect(completedProgressBar.getAttribute("aria-valuenow")).toBe("100");
    expect(await screen.findByText("Pitch preprocessing complete")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose File And Import" }));

    await waitFor(() => {
      const progressBar = screen.getByRole("progressbar", { name: "Pitch detection preprocessing progress" });
      expect(progressBar.getAttribute("aria-valuenow")).toBe("8");
      expect(screen.getByText("Preparing desktop preprocessing")).toBeTruthy();
    });
  });

  test("does not force diagnostics log back to bottom after manual scroll up", async () => {
    vi.useFakeTimers();

    const scrollToMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock
    });

    desktopMocks.readDesktopDiagnosticsLog
      .mockResolvedValueOnce(["[12:34:56.100] first line"])
      .mockResolvedValueOnce(["[12:34:56.100] first line", "[12:34:56.200] second line"]);

    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });

    const diagnosticsLog = screen.getByText(/first line/);
    const preElement = diagnosticsLog.closest("pre") as HTMLPreElement | null;
    expect(preElement).toBeTruthy();

    Object.defineProperty(preElement as HTMLPreElement, "scrollHeight", {
      configurable: true,
      value: 500
    });
    Object.defineProperty(preElement as HTMLPreElement, "clientHeight", {
      configurable: true,
      value: 200
    });
    Object.defineProperty(preElement as HTMLPreElement, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0
    });

    scrollToMock.mockClear();
    fireEvent.scroll(preElement as HTMLPreElement);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/second line/)).toBeTruthy();
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  test("reopens a recent desktop file without crashing", async () => {
    const project = createSingleLayerProject();
    project.recentFiles = ["C:/media/smile.mp4"];
    desktopMocks.loadDesktopProject.mockResolvedValue(project);
    desktopMocks.analyzeDesktopMediaFilesWithOptions.mockResolvedValue([createDesktopPayload("C:/media/smile.mp4")]);

    render(<App />);

    const reopenButton = await screen.findByRole("button", { name: "smile.mp4" });
    fireEvent.click(reopenButton);

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenCalledWith(["C:/media/smile.mp4"], {
        separateStems: true,
        stemModel: "HTDemucs FT",
        pitchModel: "yin",
        pitchSourceKind: "vocals",
        processingDevice: "auto",
        bypassCache: false
      });
    });

    await waitFor(() => {
      const statusCopy = document.querySelector(".status-copy");
      expect(statusCopy?.textContent).toMatch(/Reopened smile\.mp4 into the selected layer\./);
    });
  });

  test("removes a player from the upper-right close button on the card", async () => {
    desktopMocks.loadDesktopProject.mockResolvedValue(createDefaultProject());

    render(<App />);

    expect(await screen.findByText("4 portrait-leaning players")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play Player 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop Player 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open menu for Player 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Player 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Player 1" }));

    await waitFor(() => {
      expect(screen.getByText("3 portrait-leaning players")).toBeTruthy();
    });

    expect(screen.queryByRole("button", { name: "Remove Player 1" })).toBeNull();
  });

  test("plays a layer from the compact transport controls on the player card", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaLabel: "clip.wav",
      originalInputPath: "C:/media/clip.wav",
      sourcePath: "C:/media/clip.wav",
      mediaSourceUrl: "file://C:/media/clip.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.wav", url: "file://C:/media/clip.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Play Player 1" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pause Player 1" })).toBeTruthy();
    });
  });

  test("keeps the menu trigger as a menu button and closes from the menu header", async () => {
    desktopMocks.loadDesktopProject.mockResolvedValue(createDefaultProject());

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open menu for Player 1" }));

    expect(await screen.findByText("Player 1 settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open menu for Player 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close menu for Player 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close menu for Player 1" }));

    await waitFor(() => {
      expect(screen.queryByText("Player 1 settings")).toBeNull();
    });
  });

  test("keeps the menu visible for a single wide player by overlaying it inside the card", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      x: 16,
      y: 16,
      width: 1248,
      height: 872
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open menu for Player 1" }));

    const menu = await waitFor(() => {
      const element = container.querySelector(".layer-menu") as HTMLDivElement | null;
      expect(element).toBeTruthy();
      return element as HTMLDivElement;
    });

    expect(menu.className).toContain("layer-menu-overlay-right");
    expect(await screen.findByText("Player 1 settings")).toBeTruthy();
  });

  test("falls back to normalized audio when original video audio playback is unsupported", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "video",
      mediaLabel: "clip.mp4",
      originalInputPath: "C:/media/clip.mp4",
      sourcePath: "C:/media/clip.mp4",
      displaySourcePath: "C:/media/clip.mp4",
      mediaSourceUrl: "file://C:/media/clip.mp4",
      displaySourceUrl: "file://C:/media/clip.mp4",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.mp4", url: "file://C:/media/clip.mp4" },
        { kind: "normalized", label: "Normalized audio", path: "C:/cache/normalized.wav", url: "file://C:/cache/normalized.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLMediaElement) {
        const src = this.getAttribute("src") ?? "";
        if (this.tagName.toLowerCase() === "audio" && src.includes("clip.mp4")) {
          return Promise.reject(new Error("The element has no supported sources."));
        }

        return Promise.resolve();
      })
    });

    render(<App />);

    const playButton = await screen.findByRole("button", { name: "Play" });
    await act(async () => {
      fireEvent.click(playButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      const statusCopy = document.querySelector(".status-copy");
      expect(statusCopy?.textContent).toMatch(/original container audio could not play/i);
    });
  });

  test("updates layer time from media events without crashing", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaLabel: "clip.wav",
      originalInputPath: "C:/media/clip.wav",
      sourcePath: "C:/media/clip.wav",
      mediaSourceUrl: "file://C:/media/clip.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.wav", url: "file://C:/media/clip.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const audioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element).toBeTruthy();
      return element as HTMLAudioElement;
    });

    Object.defineProperty(audioElement, "duration", {
      configurable: true,
      value: 180
    });
    Object.defineProperty(audioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 12.5
    });

    fireEvent.loadedMetadata(audioElement);
    fireEvent.timeUpdate(audioElement);

    await waitFor(() => {
      const timeLabels = Array.from(document.querySelectorAll(".player-progress-time"), (element) => element.textContent);
      expect(timeLabels).toContain("0:12");
    });
  });

  test("updates layer time while playing even when media timeupdate events do not fire", async () => {
    vi.useFakeTimers();

    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaLabel: "clip.wav",
      originalInputPath: "C:/media/clip.wav",
      sourcePath: "C:/media/clip.wav",
      mediaSourceUrl: "file://C:/media/clip.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.wav", url: "file://C:/media/clip.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const audioElement = container.querySelector("audio") as HTMLAudioElement | null;
    expect(audioElement).toBeTruthy();

    Object.defineProperty(audioElement as HTMLAudioElement, "duration", {
      configurable: true,
      value: 180
    });
    Object.defineProperty(audioElement as HTMLAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });

    fireEvent.loadedMetadata(audioElement as HTMLAudioElement);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      await Promise.resolve();
    });

    (audioElement as HTMLAudioElement).currentTime = 5.25;

    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
      await Promise.resolve();
    });

    const timeLabels = Array.from(document.querySelectorAll(".player-progress-time"), (element) => element.textContent);
    expect(timeLabels).toContain("0:05");
  });

  test("keeps the visual video element synchronized to the audio playback clock", async () => {
    vi.useFakeTimers();

    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "video",
      mediaLabel: "clip.mp4",
      originalInputPath: "C:/media/clip.mp4",
      sourcePath: "C:/cache/playback.wav",
      displaySourcePath: "C:/cache/display.mp4",
      mediaSourceUrl: "file://C:/cache/playback.wav",
      displaySourceUrl: "file://C:/cache/display.mp4",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/cache/playback.wav", url: "file://C:/cache/playback.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const videoElement = container.querySelector("video") as HTMLVideoElement | null;
    const audioElement = container.querySelector("audio") as HTMLAudioElement | null;
    expect(videoElement).toBeTruthy();
    expect(audioElement).toBeTruthy();

    Object.defineProperty(audioElement as HTMLAudioElement, "duration", {
      configurable: true,
      value: 180
    });
    Object.defineProperty(audioElement as HTMLAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(audioElement as HTMLAudioElement, "paused", {
      configurable: true,
      get: () => false
    });
    Object.defineProperty(videoElement as HTMLVideoElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(videoElement as HTMLVideoElement, "paused", {
      configurable: true,
      get: () => true
    });

    fireEvent.loadedMetadata(audioElement as HTMLAudioElement);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      await Promise.resolve();
    });

    (audioElement as HTMLAudioElement).currentTime = 5.25;

    await act(async () => {
      vi.advanceTimersByTime(160);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((videoElement as HTMLVideoElement).currentTime).toBe(5.25);
  });

  test("keeps the player frame fixed while the pitch and envelope scroll through a moving time window", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaSourceUrl: "file://C:/media/clip.wav",
      sourcePath: "C:/media/clip.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.wav", url: "file://C:/media/clip.wav" }
      ],
      width: 360,
      duration: 40,
      amplitudeEnvelope: Array.from({ length: 21 }, (_, index) => 0.2 + (index % 5) * 0.08),
      pitchContour: Array.from({ length: 21 }, (_, index) => 220 + index * 3),
      pitchConfidence: Array.from({ length: 21 }, () => 0.95),
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const mediaMain = await screen.findByTestId("media-main-layer-1");
    const seekSlider = screen.getByRole("slider", { name: "Seek Player 1" }) as HTMLInputElement;
    const audioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element).toBeTruthy();
      return element as HTMLAudioElement;
    });
    const contourViewport = document.querySelector(".pitch-overlay-viewport") as HTMLDivElement | null;
    const contourOverlay = document.querySelector(".pitch-overlay") as SVGElement | null;
    const envelopeStrip = document.querySelector(".media-envelope-strip") as SVGElement | null;
    const playhead = document.querySelector(".media-playhead") as HTMLSpanElement | null;
    const initialPitchPath = container.querySelector(".pitch-overlay-line")?.getAttribute("d");
    const initialEnvelopePath = container.querySelector(".amplitude-strip path")?.getAttribute("d");
    const initialTickLabels = Array.from(document.querySelectorAll(".player-timeline-label"), (element) => element.textContent);

    expect(mediaMain.style.width).toBe("332px");
    expect(seekSlider.value).toBe("0");
    expect(contourViewport?.style.overflow).toBe("");
    expect(contourOverlay?.getAttribute("viewBox")).toBe("0 0 332 84");
    expect(envelopeStrip?.getAttribute("viewBox")).toBe("0 0 332 44");
    expect(Number.parseFloat(playhead?.style.left ?? "0")).toBeCloseTo(10, 6);
    expect(initialTickLabels).toEqual(["0:00", "0:02", "0:04", "0:06", "0:08"]);

    Object.defineProperty(audioElement, "duration", {
      configurable: true,
      value: 40
    });
    Object.defineProperty(audioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 20
    });

    fireEvent.loadedMetadata(audioElement);
    fireEvent.timeUpdate(audioElement);

    await waitFor(() => {
      const updatedTickLabels = Array.from(document.querySelectorAll(".player-timeline-label"), (element) => element.textContent);
      const updatedPitchPath = container.querySelector(".pitch-overlay-line")?.getAttribute("d");
      const updatedEnvelopePath = container.querySelector(".amplitude-strip path")?.getAttribute("d");
      const updatedPlayhead = document.querySelector(".media-playhead") as HTMLSpanElement | null;

      expect(Number.parseFloat(updatedPlayhead?.style.left ?? "0")).toBeCloseTo(55, 6);
      expect(updatedTickLabels).toEqual(["0:16", "0:18", "0:20", "0:22", "0:24"]);
      expect(updatedPitchPath).toBeTruthy();
      expect(updatedPitchPath).not.toBe(initialPitchPath);
      expect(updatedEnvelopePath).toBeTruthy();
      expect(updatedEnvelopePath).not.toBe(initialEnvelopePath);
    });
  });

  test("keeps the envelope fixed inside the media card and does not show pan or analysis footer UI", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      width: 360,
      duration: 40,
      pitchContour: [220, 460, 0, 225, 470, 0, 223, 468],
      pitchConfidence: [0.95, 0.18, 0.1, 0.93, 0.22, 0.1, 0.94, 0.2],
      analysisState: "ready",
      analysisNote: "Desktop analysis generated from original audio with FFmpeg-normalized, leveled pitch input and short-dropout repair."
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const contourViewport = container.querySelector(".pitch-overlay-viewport") as HTMLDivElement | null;
    const envelopeShell = container.querySelector(".media-envelope-shell") as HTMLDivElement | null;
    const envelopeStrip = container.querySelector(".media-envelope-strip") as SVGElement | null;
    const mediaMain = await screen.findByTestId("media-main-layer-1");
    const envelopeViewBox = envelopeStrip?.getAttribute("viewBox")?.split(" ") ?? [];
    const envelopeWidth = Number(envelopeViewBox[2] ?? "0");
    expect(contourViewport).toBeTruthy();
    expect(envelopeShell).toBeTruthy();
    expect(envelopeWidth).toBeGreaterThan(0);
    expect(envelopeWidth).toBeLessThanOrEqual(Number.parseInt(mediaMain.style.width, 10));
    expect(screen.queryByLabelText("Contour pan")).toBeNull();
    expect(screen.queryByLabelText("Envelope pan")).toBeNull();
    expect(screen.queryByText(/Desktop analysis generated from original audio/i)).toBeNull();
  });

  test("keeps the current playback position when switching stems", async () => {
    const playMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: playMock
    });

    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaLabel: "Original",
      mediaSourceUrl: "file://C:/media/original.wav",
      sourcePath: "C:/media/original.wav",
      playbackPosition: 17,
      duration: 120,
      isPlaying: true,
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/original.wav", url: "file://C:/media/original.wav" },
        { kind: "vocals", label: "Vocals stem", path: "C:/media/vocals.wav", url: "file://C:/media/vocals.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const audioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element).toBeTruthy();
      return element as HTMLAudioElement;
    });

    Object.defineProperty(audioElement, "duration", {
      configurable: true,
      value: 120
    });
    Object.defineProperty(audioElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(audioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 17
    });

    fireEvent.click(screen.getByRole("button", { name: "Open menu for Player 1" }));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "vocals" } });

    const switchedAudioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element?.getAttribute("src")).toContain("vocals.wav");
      return element as HTMLAudioElement;
    });

    Object.defineProperty(switchedAudioElement, "duration", {
      configurable: true,
      value: 120
    });
    Object.defineProperty(switchedAudioElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(switchedAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });

    fireEvent.loadedMetadata(switchedAudioElement);

    await waitFor(() => {
      expect(switchedAudioElement.currentTime).toBe(17);
      expect(playMock).toHaveBeenCalled();
    });
  });

  test("keeps video playback position stable across repeated source switches", async () => {
    const playMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      writable: true,
      value: playMock
    });

    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "video",
      mediaLabel: "clip.mp4",
      mediaSourceUrl: "file://C:/cache/original.wav",
      displaySourceUrl: "file://C:/cache/display.mp4",
      sourcePath: "C:/cache/original.wav",
      displaySourcePath: "C:/cache/display.mp4",
      playbackPosition: 11.5,
      duration: 90,
      isPlaying: true,
      availableSources: [
        { kind: "original", label: "Original", path: "C:/cache/original.wav", url: "file://C:/cache/original.wav" },
        { kind: "vocals", label: "Vocals stem", path: "C:/cache/vocals.wav", url: "file://C:/cache/vocals.wav" },
        { kind: "other", label: "Other stem", path: "C:/cache/other.wav", url: "file://C:/cache/other.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const initialVideoElement = await waitFor(() => {
      const element = container.querySelector("video");
      expect(element).toBeTruthy();
      return element as HTMLVideoElement;
    });
    const initialAudioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element).toBeTruthy();
      return element as HTMLAudioElement;
    });

    Object.defineProperty(initialVideoElement, "duration", {
      configurable: true,
      value: 90
    });
    Object.defineProperty(initialVideoElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(initialVideoElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 11.5
    });
    Object.defineProperty(initialAudioElement, "duration", {
      configurable: true,
      value: 90
    });
    Object.defineProperty(initialAudioElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(initialAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 11.5
    });

    fireEvent.click(screen.getByRole("button", { name: "Open menu for Player 1" }));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "vocals" } });

    const vocalsAudioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element?.getAttribute("src")).toContain("vocals.wav");
      return element as HTMLAudioElement;
    });
    Object.defineProperty(vocalsAudioElement, "duration", {
      configurable: true,
      value: 90
    });
    Object.defineProperty(vocalsAudioElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(vocalsAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });
    fireEvent.loadedMetadata(vocalsAudioElement);

    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "other" } });

    const otherAudioElement = await waitFor(() => {
      const element = container.querySelector("audio");
      expect(element?.getAttribute("src")).toContain("other.wav");
      return element as HTMLAudioElement;
    });
    const currentVideoElement = container.querySelector("video") as HTMLVideoElement;

    Object.defineProperty(otherAudioElement, "duration", {
      configurable: true,
      value: 90
    });
    Object.defineProperty(otherAudioElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(otherAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(currentVideoElement, "duration", {
      configurable: true,
      value: 90
    });
    Object.defineProperty(currentVideoElement, "readyState", {
      configurable: true,
      get: () => 1
    });
    Object.defineProperty(currentVideoElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });

    fireEvent.loadedMetadata(otherAudioElement);

    await waitFor(() => {
      expect(otherAudioElement.currentTime).toBe(11.5);
      expect(currentVideoElement.currentTime).toBe(11.5);
      expect(playMock).toHaveBeenCalled();
    });
  });

  test("keeps the cached contour fixed when switching playback source", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaSourceUrl: "file://C:/media/original.wav",
      sourcePath: "C:/media/original.wav",
      originalInputPath: "C:/media/original.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/original.wav", url: "file://C:/media/original.wav" },
        { kind: "vocals", label: "Vocals stem", path: "C:/media/vocals.wav", url: "file://C:/media/vocals.wav" }
      ],
      duration: 12,
      pitchContour: [220, 222, 224, 226],
      pitchConfidence: [0.95, 0.95, 0.95, 0.95],
      amplitudeEnvelope: [0.2, 0.3, 0.25, 0.22],
      analysisState: "ready",
      analysisSourceKind: "original"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const initialPitchPath = await waitFor(() => {
      const path = container.querySelector(".pitch-overlay-line")?.getAttribute("d");
      expect(path).toBeTruthy();
      return path;
    });

    fireEvent.click(screen.getByRole("button", { name: "Open menu for Player 1" }));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "vocals" } });

    await waitFor(() => {
      expect(container.querySelector(".pitch-overlay-line")?.getAttribute("d")).toBe(initialPitchPath);
      expect(screen.getByText("original audio")).toBeTruthy();
    });

    expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).not.toHaveBeenCalled();
  });

  test("keeps the pitch overlay visible when video opacity is reduced", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "video",
      mediaLabel: "clip.mp4",
      mediaSourceUrl: "file://C:/cache/playback.wav",
      displaySourceUrl: "file://C:/cache/display.mp4",
      sourcePath: "C:/cache/playback.wav",
      displaySourcePath: "C:/cache/display.mp4",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/cache/playback.wav", url: "file://C:/cache/playback.wav" }
      ],
      opacity: 0.2,
      duration: 10,
      pitchContour: [220, 222, 224, 226],
      pitchConfidence: [0.95, 0.95, 0.95, 0.95],
      amplitudeEnvelope: [0.2, 0.35, 0.28, 0.18],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const videoElement = await waitFor(() => {
      const element = container.querySelector("video") as HTMLVideoElement | null;
      expect(element).toBeTruthy();
      return element as HTMLVideoElement;
    });

    await waitFor(() => {
      const pitchPath = container.querySelector(".pitch-overlay-line") as SVGPathElement | null;
      expect(pitchPath?.getAttribute("d")).toBeTruthy();
      expect(videoElement.style.opacity).toBe("0.2");
      expect(pitchPath?.style.opacity).toBe("");
    });
  });

  test("aligns primary note lines to the rendered pitch contour", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaSourceUrl: "file://C:/media/tone.wav",
      sourcePath: "C:/media/tone.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/tone.wav", url: "file://C:/media/tone.wav" }
      ],
      duration: 6,
      pitchContour: Array.from({ length: 24 }, () => 440),
      pitchConfidence: Array.from({ length: 24 }, () => 0.98),
      amplitudeEnvelope: Array.from({ length: 24 }, () => 0.3),
      pitchSpan: 12,
      pitchCenterMode: "adaptive",
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    await waitFor(() => {
      const pitchPath = container.querySelector(".pitch-overlay-line") as SVGPathElement | null;
      expect(pitchPath?.getAttribute("d")).toBeTruthy();
    });

    const primaryGridLines = Array.from(container.querySelectorAll(".pitch-grid-line")) as HTMLSpanElement[];
    expect(primaryGridLines.length).toBeGreaterThan(3);

    const centerGridLine = container.querySelector(".pitch-grid-line-center") as HTMLSpanElement | null;
    const noteLabels = Array.from(container.querySelectorAll(".note-scale-note"), (element) => element.textContent);
    const pitchPoint = container.querySelector(".pitch-point-marker") as SVGCircleElement | null;

    expect(centerGridLine).toBeTruthy();
    expect(noteLabels).toContain("A4");

    const gridTop = Number.parseFloat(centerGridLine?.style.top ?? "NaN");
    const pointY = Number.parseFloat(pitchPoint?.getAttribute("cy") ?? "NaN");
    const pointTop = (pointY / 84) * 100;

    expect(Number.isFinite(gridTop)).toBe(true);
    expect(Number.isFinite(pointTop)).toBe(true);
    expect(Math.abs(gridTop - pointTop)).toBeLessThan(0.75);
  });

  test("suppresses low-energy false pitch markers inside rests", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaSourceUrl: "file://C:/media/tone.wav",
      sourcePath: "C:/media/tone.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/tone.wav", url: "file://C:/media/tone.wav" }
      ],
      duration: 5,
      pitchContour: [220, 220, 98, 262, 262],
      pitchConfidence: [0.96, 0.94, 0.18, 0.95, 0.95],
      amplitudeEnvelope: [0.28, 0.26, 0.02, 0.36, 0.34],
      pitchSpan: 12,
      pitchCenterMode: "adaptive",
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    await waitFor(() => {
      const markers = Array.from(container.querySelectorAll(".pitch-point-marker")) as SVGCircleElement[];
      expect(markers.length).toBeGreaterThan(0);
      const frequencies = markers.map((element) => Number.parseFloat(element.getAttribute("data-frequency-hz") ?? "NaN"));
      expect(frequencies.some((value) => Math.abs(value - 98) < 0.5)).toBe(false);
      expect(frequencies.some((value) => Math.abs(value - 220) < 0.5)).toBe(true);
      expect(frequencies.some((value) => Math.abs(value - 262) < 0.5)).toBe(true);
    });
  });

  test("updates pitch contour and envelope color, width, and intensity from the layer menu", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaSourceUrl: "file://C:/media/clip.wav",
      sourcePath: "C:/media/clip.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/clip.wav", url: "file://C:/media/clip.wav" }
      ],
      amplitudeEnvelope: [0.2, 0.45, 0.25],
      pitchContour: [220, 222, 224],
      pitchConfidence: [0.95, 0.95, 0.95],
      duration: 9,
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open menu for Player 1" }));

    fireEvent.change(screen.getByLabelText("Contour color"), { target: { value: "#ff8844" } });
    fireEvent.change(screen.getByLabelText("Contour width"), { target: { value: "1.8" } });
    fireEvent.change(screen.getByLabelText("Contour intensity"), { target: { value: "1.35" } });

    await waitFor(() => {
      const contourPath = container.querySelector(".pitch-overlay-line") as SVGPathElement | null;
      const progressPath = container.querySelector(".pitch-overlay-progress") as SVGPathElement | null;
      const amplitudePath = container.querySelector(".amplitude-strip path") as SVGPathElement | null;
      expect(contourPath?.style.stroke).toBe("rgba(255, 136, 68, 1)");
      expect(contourPath?.style.strokeWidth).toBe("1.8");
      expect(progressPath?.style.stroke).toBe("rgba(255, 136, 68, 1)");
      expect(progressPath?.style.strokeWidth).toBe("1.92");
      expect(amplitudePath?.style.fill).toBe("rgba(255, 136, 68, 0.38)");
      expect(amplitudePath?.style.stroke).toBe("rgba(255, 136, 68, 0.9)");
    });
  });

  test("nudges imported video to a drawable frame when loaded data arrives", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "video",
      mediaLabel: "clip.mp4",
      mediaSourceUrl: "file://C:/cache/playback.wav",
      displaySourceUrl: "file://C:/cache/display.mp4",
      sourcePath: "C:/cache/playback.wav",
      displaySourcePath: "C:/cache/display.mp4",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/cache/playback.wav", url: "file://C:/cache/playback.wav" }
      ],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    const videoElement = await waitFor(() => {
      const element = container.querySelector("video");
      expect(element).toBeTruthy();
      return element as HTMLVideoElement;
    });

    expect(videoElement.getAttribute("preload")).toBe("auto");
    expect(videoElement.getAttribute("playsinline")).toBe("");

    Object.defineProperty(videoElement, "duration", {
      configurable: true,
      value: 120
    });
    Object.defineProperty(videoElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 0
    });

    fireEvent.loadedData(videoElement);

    expect(videoElement.currentTime).toBe(0.001);
  });

  test("renders pitch contours for imported layers even when confidence data is missing", async () => {
    const project = createSingleLayerProject();
    project.layers[0] = {
      ...project.layers[0],
      mediaKind: "audio",
      mediaLabel: "legacy.wav",
      mediaSourceUrl: "file://C:/media/legacy.wav",
      sourcePath: "C:/media/legacy.wav",
      availableSources: [
        { kind: "original", label: "Original", path: "C:/media/legacy.wav", url: "file://C:/media/legacy.wav" }
      ],
      duration: 8,
      pitchContour: [220, 222, 0, 225, 227],
      pitchConfidence: [],
      analysisState: "ready"
    };
    desktopMocks.loadDesktopProject.mockResolvedValue(project);

    const { container } = render(<App />);

    await waitFor(() => {
      const contourPath = container.querySelector(".pitch-overlay-line") as SVGPathElement | null;
      expect(contourPath?.getAttribute("d")).toBeTruthy();
    });
  });

  test("imports desktop media, renders contours before playback, and generates stems from the original input", async () => {
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue(["C:/media/clip.mp4"]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions
      .mockResolvedValueOnce([
      createDesktopPayload("C:/media/clip.mp4", {
        playback_audio: "C:/cache/clip/playback.wav",
        display_video: "C:/cache/clip/display.mp4",
        analysis_json: "C:/cache/clip/analysis-vocals-yin.json",
        normalized_audio: "C:/cache/clip/normalized-vocals-yin.wav",
        analysis_source: { kind: "vocals", path: "C:/cache/clip/vocals.wav" },
        sources: [
          { kind: "original", label: "Original", path: "C:/cache/clip/playback.wav" },
          { kind: "normalized", label: "Normalized audio", path: "C:/cache/clip/normalized-vocals-yin.wav" },
          { kind: "vocals", label: "Vocals stem", path: "C:/cache/clip/vocals.wav" },
          { kind: "other", label: "Other stem", path: "C:/cache/clip/other.wav" }
        ],
        amplitudes: Array.from({ length: 31 }, (_, index) => 0.15 + (index % 6) * 0.05),
        pitch_hz: Array.from({ length: 31 }, (_, index) => 220 + index * 0.8),
        confidence: Array.from({ length: 31 }, () => 0.93)
      })
    ])
      .mockResolvedValueOnce([
      createDesktopPayload("C:/media/clip.mp4", {
        playback_audio: "C:/cache/clip/playback.wav",
        display_video: "C:/cache/clip/display.mp4",
        normalized_audio: "C:/cache/clip/normalized-vocals-yin.wav",
        analysis_json: "C:/cache/clip/analysis-vocals-yin.json",
        cache_status: "miss",
        analysis_source: { kind: "vocals", path: "C:/cache/clip/vocals.wav" },
        sources: [
          { kind: "original", label: "Original", path: "C:/cache/clip/playback.wav" },
          { kind: "normalized", label: "Normalized audio", path: "C:/cache/clip/normalized-vocals-yin.wav" },
          { kind: "vocals", label: "Vocals stem", path: "C:/cache/clip/vocals.wav" },
          { kind: "other", label: "Other stem", path: "C:/cache/clip/other.wav" }
        ],
        amplitudes: Array.from({ length: 31 }, (_, index) => 0.2 + (index % 5) * 0.05),
        pitch_hz: Array.from({ length: 31 }, (_, index) => 220 + index),
        confidence: Array.from({ length: 31 }, () => 0.95)
      })
    ]);

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose File And Import" }));

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenCalledWith(["C:/media/clip.mp4"], {
        separateStems: true,
        stemModel: "HTDemucs FT",
        pitchModel: "yin",
        pitchSourceKind: "vocals",
        processingDevice: "auto",
        bypassCache: false
      });
    });

    await waitFor(() => {
      const videoElement = container.querySelector("video") as HTMLVideoElement | null;
      const audioElement = container.querySelector("audio") as HTMLAudioElement | null;
      expect(videoElement?.getAttribute("src")).toContain("display.mp4");
      expect(audioElement?.getAttribute("src")).toContain("playback.wav");
    });

    const mediaMain = container.querySelector(".media-main");
    const visualStage = container.querySelector(".media-visual-stage");
    const overlayStack = container.querySelector(".media-visual-stage > .overlay-stack");
    const envelopeShell = container.querySelector(".media-envelope-shell");
    expect(mediaMain).toBeTruthy();
    expect(visualStage).toBeTruthy();
    expect(overlayStack).toBeTruthy();
    expect(envelopeShell).toBeTruthy();

    const pitchPathElement = container.querySelector(".pitch-overlay path");
    const amplitudePath = container.querySelector(".amplitude-strip path");
    expect(pitchPathElement?.getAttribute("d")).toBeTruthy();
    expect(amplitudePath?.getAttribute("d")).toBeTruthy();
    expect(container.querySelector(".layer-analysis-state")).toBeNull();

    const pitchPath = container.querySelector(".pitch-overlay-line")?.getAttribute("d");
    const progressPitchPath = container.querySelector(".pitch-overlay-progress")?.getAttribute("d");
    expect(pitchPath).toBeTruthy();
    expect(progressPitchPath).toBeTruthy();
    expect((getPathStartX(pitchPath) ?? 0)).toBeGreaterThan(14);

    const audioElement = container.querySelector("audio") as HTMLAudioElement | null;
    expect(audioElement).toBeTruthy();

    Object.defineProperty(audioElement as HTMLAudioElement, "duration", {
      configurable: true,
      value: 120
    });
    Object.defineProperty(audioElement as HTMLAudioElement, "currentTime", {
      configurable: true,
      writable: true,
      value: 30
    });

    fireEvent.loadedMetadata(audioElement as HTMLAudioElement);
    fireEvent.timeUpdate(audioElement as HTMLAudioElement);

    await waitFor(() => {
      const updatedProgressPitchPath = container.querySelector(".pitch-overlay-progress")?.getAttribute("d");
      expect(updatedProgressPitchPath).toBeTruthy();
      expect(updatedProgressPitchPath).not.toBe(pitchPath);
    });

    const firstPitchPoint = container.querySelector(".pitch-point-marker") as SVGCircleElement | null;
    expect(firstPitchPoint).toBeTruthy();
    expect(firstPitchPoint?.style.opacity).toBe("");

    fireEvent.mouseEnter(firstPitchPoint as SVGCircleElement);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/Hz/);
    expect(tooltip.textContent).toMatch(/ st/);
    expect(tooltip.textContent).toMatch(/ s/);
    expect(tooltip.textContent).toMatch(/[A-G]#?\d/);
    expect(container.querySelector(".pitch-guide-line-vertical")).toBeTruthy();
    expect(container.querySelector(".pitch-guide-line-horizontal")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Generate stems for Player 1" }));

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenLastCalledWith(["C:/media/clip.mp4"], {
        separateStems: true,
        stemModel: "HTDemucs FT",
        pitchModel: "yin",
        pitchSourceKind: "vocals",
        processingDevice: "auto",
        bypassCache: false
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Open menu for Player 1" }));
    expect((await screen.findAllByRole("option", { name: "Vocals stem" })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("option", { name: "Other stem" }).length).toBeGreaterThan(0);
  });

  test("passes bypass-cache mode through desktop import and stem generation when enabled", async () => {
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue(["C:/media/clip.mp4"]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions.mockResolvedValue([
      createDesktopPayload("C:/media/clip.mp4", {
        sources: [
          { kind: "original", label: "Original", path: "C:/cache/clip/playback.wav" },
          { kind: "normalized", label: "Normalized audio", path: "C:/cache/clip/normalized.wav" },
          { kind: "vocals", label: "Vocals stem", path: "C:/cache/clip/vocals.wav" },
          { kind: "other", label: "Other stem", path: "C:/cache/clip/other.wav" }
        ]
      })
    ]);

    render(<App />);

    fireEvent.click(await screen.findByLabelText("Bypass preprocessing cache"));
    fireEvent.click(screen.getByRole("button", { name: "Choose File And Import" }));

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenCalledWith(["C:/media/clip.mp4"], {
        separateStems: true,
        stemModel: "HTDemucs FT",
        pitchModel: "yin",
        pitchSourceKind: "vocals",
        processingDevice: "auto",
        bypassCache: true
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate stems for Player 1" }));

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenLastCalledWith(["C:/media/clip.mp4"], {
        separateStems: true,
        stemModel: "HTDemucs FT",
        pitchModel: "yin",
        pitchSourceKind: "vocals",
        processingDevice: "auto",
        bypassCache: true
      });
    });
  });

  test("passes the configured processing device through desktop preprocessing", async () => {
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue(["C:/media/clip.mp4"]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions.mockResolvedValue([createDesktopPayload("C:/media/clip.mp4")]);

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Processing device"), { target: { value: "gpu" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose File And Import" }));

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenCalledWith(["C:/media/clip.mp4"], {
        separateStems: true,
        stemModel: "HTDemucs FT",
        pitchModel: "yin",
        pitchSourceKind: "vocals",
        processingDevice: "gpu",
        bypassCache: false
      });
    });
  });

  test("keeps imported pitch analysis fixed when a player switches to another stem source", async () => {
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue(["C:/media/clip.mp4"]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions
      .mockResolvedValueOnce([
        createDesktopPayload("C:/media/clip.mp4", {
          playback_audio: "C:/cache/clip/playback.wav",
          display_video: "C:/cache/clip/display.mp4",
          analysis_source: { kind: "vocals", path: "C:/cache/clip/vocals.wav" },
          sources: [
            { kind: "original", label: "Original", path: "C:/cache/clip/playback.wav" },
            { kind: "normalized", label: "Normalized audio", path: "C:/cache/clip/normalized-vocals-yin.wav" },
            { kind: "vocals", label: "Vocals stem", path: "C:/cache/clip/vocals.wav" },
            { kind: "other", label: "Other stem", path: "C:/cache/clip/other.wav" }
          ]
        })
      ])
      .mockResolvedValueOnce([
        createDesktopPayload("C:/media/clip.mp4", {
          playback_audio: "C:/cache/clip/playback.wav",
          display_video: "C:/cache/clip/display.mp4",
          normalized_audio: "C:/cache/clip/normalized-other-yin.wav",
          analysis_json: "C:/cache/clip/analysis-other-yin.json",
          analysis_source: { kind: "other", path: "C:/cache/clip/other.wav" },
          sources: [
            { kind: "original", label: "Original", path: "C:/cache/clip/playback.wav" },
            { kind: "normalized", label: "Normalized audio", path: "C:/cache/clip/normalized-other-yin.wav" },
            { kind: "vocals", label: "Vocals stem", path: "C:/cache/clip/vocals.wav" },
            { kind: "other", label: "Other stem", path: "C:/cache/clip/other.wav" }
          ]
        })
      ]);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose File And Import" }));

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open menu for Player 1" }));
    fireEvent.change(await screen.findByLabelText("Source"), { target: { value: "other" } });

    await waitFor(() => {
      expect(desktopMocks.analyzeDesktopMediaFilesWithOptions).toHaveBeenCalledTimes(1);
      expect(screen.getByText("vocals stem")).toBeTruthy();
    });
  });

  test("treats desktop audio-only webm imports as audio layers", async () => {
    desktopMocks.pickDesktopMediaFiles.mockResolvedValue(["C:/media/over-the-rainbow.webm"]);
    desktopMocks.analyzeDesktopMediaFilesWithOptions.mockResolvedValue([
      createDesktopPayload("C:/media/over-the-rainbow.webm", {
        playback_audio: "C:/cache/rainbow/playback.wav",
        display_video: null,
        media_kind: "audio",
        sources: [
          { kind: "original", label: "Original", path: "C:/cache/rainbow/playback.wav" },
          { kind: "normalized", label: "Normalized audio", path: "C:/cache/rainbow/normalized-vocals-yin.wav" }
        ]
      })
    ]);

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Choose File And Import" }));

    await waitFor(() => {
      const audioElement = container.querySelector("audio") as HTMLAudioElement | null;
      const videoElement = container.querySelector("video") as HTMLVideoElement | null;
      expect(audioElement?.getAttribute("src")).toContain("playback.wav");
      expect(videoElement).toBeNull();
    });
  });
});