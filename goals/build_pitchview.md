# Build PitchView

## Objective

Implement PitchView as a Windows-first desktop application with an optional browser-based test harness. The app must support a multi-layer synchronized media workspace, pitch and amplitude analysis surfaces, desktop preprocessing, project persistence, and a one-command build path.

## Architecture

- Desktop host: Tauri
- Frontend: React + TypeScript + Vite
- Deterministic preprocessing: Python entrypoint at tools/preprocess_media.py
- Persistence: browser localStorage during development, desktop-backed persistence in later slices

## Phases

### Phase 0: Foundation

- Create GOTCHA scaffolding and manifests.
- Initialize workspace memory and local data directories.
- Create root workspace scripts for bootstrap, build, and test.
- Establish frontend and desktop host packages.

### Phase 1: Workspace Shell

- Implement a stage with four default comparison layers.
- Support active-layer selection, tiling, opacity, z-order movement, sync lock toggles, and pitch/time display settings.
- Add browser-safe persistence for workspace state.
- Add automated tests for layout and state transitions.

### Phase 2: Media Import And Transport

- Support per-layer media assignment and playable sources.
- Add shared and independent transport state.
- Provide desktop-native import through Tauri and browser file input fallback.
- Add synchronization verification tests.

### Phase 3: Analysis Surface

- Add amplitude strip rendering.
- Add pitch contour overlay rendering.
- Add configurable pitch span, time scale, center modes, and pitch source preferences.
- Level pitch-model input so tracking remains stable across wide amplitude variation.
- Deglitch displayed pitch contours so false jumps are suppressed without hiding real pitch transitions.

### Phase 4: Desktop Preprocessing

- Implement backend detection and FFmpeg checks.
- Add normalization, stem selection, model selection, and pitch extraction orchestration.
- Feed generated assets back into player layers.
- Include preprocessing steps for pitch-input leveling and contour cleanup tuned for truthful display.

### Phase 5: Persistence And Packaging

- Move project persistence to durable desktop storage.
- Restore recent files, player states, model selections, and cached analysis.
- Package Windows desktop builds with resource validation.

## Inputs

- context/requirements.md
- args/build.dev.json

## Tools

- tools/preprocess_media.py
- scripts/bootstrap.ps1
- scripts/build.ps1
- scripts/test.ps1

## Environment for Python
- use the .\PitchView\.venv environment created for this project only.  Use no other Python environments.

## Verification

- Frontend unit tests for workspace state.
- Integration tests for tiling and player selection behavior.
- Preprocessing smoke test for backend detection.
- Build scripts must fail clearly when prerequisites are unavailable.

## Notes

- Browser mode exists to accelerate UI iteration and testing, not as the primary product target.
- Heavy media work must remain in deterministic tools instead of frontend code.
