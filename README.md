# PitchView

PitchView is a Windows-first desktop media analysis app for comparing vocal phrasing, pitch contour, and timing across multiple synchronized players.

The current build is aimed at practice and analysis workflows where you want to line up one or more recordings, isolate vocals when possible, and inspect pitch movement directly on top of each player.

![PitchView overview](docs/images/pitchview-workspace.png)

![PitchView import and workflow controls](docs/images/pitchview-controls-detail.png)

## What It Does

- loads audio-only or video media into multiple player surfaces
- keeps selected players time-locked for synchronized comparison
- overlays a per-player pitch graph directly on the media layer
- supports browser import and native desktop file selection
- can run desktop preprocessing to generate vocal-focused stems
- lets you target one player, several players, or all players during import
- exposes per-player mix, mute, solo, opacity, order, color, and drag controls
- includes a scripted demo loop for repeatable UI and sync verification

## Current Workflow

The current app supports this flow end to end:

1. Open a media file into one or more player targets.
2. Keep players locked together or let individual players drift independently.
3. Choose the preferred pitch source, with separated vocals favored when available.
4. Run stem generation from the desktop shell through the Python preprocessing worker.
5. Inspect the overlaid contour while adjusting zoom, pitch span, and layer visibility.

## Current Architecture

### Frontend

- React 19
- TypeScript
- Vite

### Desktop shell

- Tauri 2
- Rust command bridge in `src-tauri`

### Audio and pitch analysis

- browser-side YIN analysis through `pitchfinder`
- desktop/offline pitch analysis through the Python worker
- graph rendering and smoothing logic in `src/lib`

### Preprocessing

- Python worker at `tools/preprocess_media.py`
- FFmpeg-backed normalization path
- selectable stem backends and model planning

## Stem Separation Models

The current model workbench includes:

- Vocals Mel-Band Roformer
- HTDemucs FT
- HTDemucs 6 Stem
- MDX23C
- UVR MDX Karaoke
- Spleeter 2 Stem
- Open-Unmix

The intended default path is the Roformer-based vocals workflow when the model and Python dependencies are available.

## Repository Layout

- `src/`: React UI, reducer logic, pitch display, preprocess wrappers
- `src-tauri/`: Tauri desktop backend and Rust commands
- `tools/`: Python preprocess worker and analysis utilities
- `sample/`: bundled sample assets and generated output folders used during development
- `docs/images/`: README screenshots

## Running PitchView

### Browser UI

1. Install dependencies:

	```bash
	npm install
	```

2. Start Vite:

	```bash
	npm run dev
	```

3. Or use the Windows launcher:

	```bat
	launch-demo.bat
	```

### Desktop shell

Use the Windows launcher so the app can pick the Python environment that already contains the preprocessing stack:

```bat
launch-tauri.bat
```

If you need to set the interpreter manually, set `PITCHVIEW_PYTHON` before starting Tauri.

Known good environment used during development:

```text
C:\Users\ericl\AITools\Qwen-Audio\.venv\Scripts\python.exe
```

## Testing

Run the automated test suite with:

```bash
npm test
```

The current suite covers reducer workflow behavior, pitch display shaping, pitch analysis helpers, preprocess planning, and Tauri wrapper behavior.

## Utility Scripts

- `npm run scan:display-glitches`
- `npm run benchmark:pitch-detectors`

These are development diagnostics used to evaluate contour rendering and detector behavior.

## Current Limitations

- project persistence is not implemented yet
- the desktop preprocessing flow depends on an external Python environment
- backend availability depends on which models and Python packages are installed locally
- the UI is functional but still in active refinement

## Future Work

- tune the overlay workflow so windows can be stacked more aggressively without making them harder to manipulate
- move more adjustment controls into places that stay usable while the comparison view remains visible
- reduce the amount of focus loss caused by opening controls while trying to inspect timing and pitch alignment
- keep improving the balance between direct on-stage control and a clean analysis surface

## Status

PitchView is past the scaffold stage and already supports real media import, real pitch extraction, real stem-generation workflows, and automated tests. It is still an active development repository rather than a finished product release.
