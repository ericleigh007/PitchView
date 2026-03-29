import { describe, expect, test } from "vitest";
import { createDemoProject } from "./demo";

describe("demo project", () => {
  test("creates a ready-to-verify workspace with recent files and overlay data", () => {
    const project = createDemoProject(1280, 720);

    expect(project.layers).toHaveLength(4);
    expect(project.recentFiles.length).toBeGreaterThan(0);
    expect(project.layers.every((layer) => layer.analysisState === "ready")).toBe(true);
    expect(project.layers.every((layer) => layer.pitchContour.length > 0)).toBe(true);
    expect(project.layers[0].availableSources.some((source) => source.kind === "vocals")).toBe(true);
  });
});
