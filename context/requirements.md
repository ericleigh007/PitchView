# PitchView Requirements

## Status

This document is a working requirements baseline for PitchView.

It captures the requirements that are currently known from the implemented product, the README, and the recent development work. It is not yet a final specification. It should be updated as the source of truth for what the app must do.

## Product Summary

PitchView is a Windows-first desktop application for comparing vocal phrasing, pitch contour, audio amplitude, and timing across multiple synchronized media players.

The app is intended for practice, analysis, and alignment workflows where a user needs to:

- load one or more recordings
- keep selected recordings synchronized, or let them be unsynchronized
- inspect pitch movement directly on top of the media view
  - pitch scale is adjustable
- time scale is adjustable
- isolate vocals or alternate stems when available
- compare phrasing, timing, and contour across layered windows

## Primary Users

- singers practicing against reference material
- musicians comparing multiple takes or arrangements
- users analyzing vocal timing and pitch alignment
- users wanting to analyze the use of pitch correction or autotune software.
- users who want desktop preprocessing for stem generation and pitch analysis

## Core Product Goals

- provide a desktop-first comparison workspace for multiple synchronized media players
- make pitch analysis visible directly on the player surface instead of in a separate analysis-only screen
- support both fast browser-style interaction and deeper desktop-native preprocessing workflows
- allow layered comparison of multiple sources without losing transport and inspection control
- support real media import rather than demo-only placeholder content

## Functional Requirements

### 1. Multi-Player Workspace

- The app must display multiple player layers in a shared stage workspace.
- The app must support at least four comparison layers in the current default workflow, with the ability to add, remove players, and re-tile the players for flexibility.
- Each layer must retain its own media source, playback position, dimensions, opacity, z-order, and mix state.
- The user must be able to select an active layer for focused editing and inspection.

### 2. Media Import

- The app must support importing audio-only and video media.
- The app must allow browser-based file selection when running as a web UI.
- The app must allow native desktop file selection when running in Tauri.
- The user must be able to target one player, several players, or all players during import.
- Imported media must become playable in the assigned player layer.

### 3. Synchronized Playback

- The app must support locked playback across selected players.
- The app must allow unlocked players to drift independently.
- The app must support play, stop, seek backward, seek forward, and direct position updates.
- The app must expose a master time reference for the workspace.

### 4. Pitch Visualization

- The app must overlay pitch contours directly on each player surface.
- The transparency of the video and background should still allow the pitch contour to come through.
- The pitch color and width should be adjustable.  What we see now is probably good for midrange.
- The app must support configurable time scale options.
- The app must support configurable pitch span options.
- The app must support pitch center modes, including adaptive and fixed-center behavior.
- The pitch center should be adjustable by mouse click and drag, or similar.
- The app must allow the user to choose the preferred pitch source.
- The app must favor separated vocals as the preferred pitch source when available.

#### Pitch display performance
- Pitch model input must be leveled to allow the pitch to be tracked over a wide range of amplitudes
- Pitch display must be true and free of extra 'glitches' that are not in the actual pitch change input.

### 5. Stem-Aware Workflow

- The app must support multiple available stems for a player, including at minimum original, vocals, and other when present.
- The user must be able to switch the active audio target between available stems.
- The app must support desktop preprocessing to generate stems from imported media.
- The app must expose available stem model options to the user.

### 6. Desktop Preprocessing

- The desktop app must support a preprocessing worker with high performance.
- The preprocessing flow must support backend detection before running jobs.
- The preprocessing flow must support FFmpeg-backed normalization and media preparation.
- The preprocessing flow must support running a stem generation job against a selected model.
- The preprocessing flow must produce output files that can be attached back to player layers.
- The desktop workflow must surface preprocessing status to the user.

### 7. On-Stage Window Manipulation

- The user must be able to drag player layers on the stage.
- The user must be able to resize player layers.
- The user must be able to change layer opacity.
- The user must be able to change layer order.
- The user must be able to tile layers side-by-side using a dedicated action.
- The default tiling direction should favor evenly spaced horizontal placement across the stage when that best preserves vertical pitch detail.
- Default player proportions should favor equal or portrait-leaning shapes rather than wide landscape cards, so pitch detail has enough vertical resolution.
- The user must be able to add and remove players
- After tiling, the user must still be able to drag layers over one another manually.

### 8. Layer Controls And Inspection

- The app must provide per-layer transport controls.
- The app must provide per-layer mix mode controls.
- The app must provide player-launched layer menus so that a player's settings stay tied to that player.
- Each player menu must allow the user to review and adjust the focused layer without requiring a separate side inspector.
- Player customization controls should be reachable from the player surface itself through a compact popup workflow.
- The stage layout should preserve the graph area by keeping supporting metadata and controls out of the main analysis surface when practical.

### 8a. Look And Feel

- The app should be mouse-first rather than touch-first.
- Primary action controls should use compact icon-based buttons with tooltips rather than large text-heavy buttons.
- Controls should take up as little space as practical while remaining clearly usable with a mouse.
- The visual style should feel like a serious desktop analysis tool rather than a tablet-style or child-oriented interface.
- Dense control areas should minimize empty padding and unnecessary spacing between related actions.
- Player-specific settings should appear in popup menus anchored to the player, not in a detached global panel.
- The stage should remain visually dominant, with controls subordinate to the pitch and timing comparison surfaces.
- Default player presentation should prioritize pitch granularity vertically and time granularity horizontally.

### 9. Amplitude And Analysis Support

- The app must support amplitude-strip analysis for media sources.
- The app must display amplitude context alongside and in sync with layer playback controls.
- The app must support desktop or offline pitch analysis through the preprocessing worker.

### 10. Demo And Verification Support

- The app must include a scripted demo mode for repeatable UI and synchronization verification.
- The app should support development diagnostics for pitch rendering and detector evaluation.

## Desktop Requirements

- The primary supported desktop target is Windows.
- The desktop shell must run through a high performance framework.
- The desktop workflow must support native file browsing.
- The desktop workflow must support converting local files into playable app URLs.

## Browser Requirements

- Browser operation is no longer a product requirement.
- The primary supported runtime is the Tauri desktop application on Windows.
- Browser-based execution may remain available only when useful for isolated development, component verification, or non-GUI test scaffolding.
- Release readiness and functional acceptance must be judged by the desktop/Tauri workflow, not by browser parity.
- Desktop-only features must fail clearly when invoked outside Tauri if browser-based developer scaffolding is still used.

## Technical Requirements

### Frontend

- A high performance frontend must be used that allows for fluid interaction, even when background processing is runnning.

### Desktop Backend

- The desktop backend must be high performance. 
- The desktop backend processing can make use of GPU resources up to 12GB of VRAM, with expansions available on request.

### Analysis And Preprocessing

- Desktop preprocessing must run through `tools/preprocess_media.py`.
- FFmpeg must be available for media normalization and probing.
- The preprocessing environment must support model-driven stem separation.

## Supported Stem Models

The current known model set includes:

- Vocals Mel-Band Roformer
- HTDemucs FT
- HTDemucs 6 Stem
- MDX23C
- UVR MDX Karaoke
- Spleeter 2 Stem
- Open-Unmix

The intended default path is the Roformer-based vocals workflow when the environment supports it, however this will be configurable.

## Supported Pitch-detection models

The pitch-detection model must be selectable from at least:
- yin
- torch-based, cuda, accelerated by the local GPU resources
- other, suggested by websearch of the most popular/performant/accurate possibilities.

## Usability Requirements

- The app should feel workspace-first rather than demo-first.
- Common transport and inspection actions should remain visible while the user is comparing layers.
- Overlay windows should remain manipulable without obscuring core analysis tasks more than necessary.
- Dropdowns, selectors, and inputs must remain readable and usable during normal stage workflows.
- Player-specific customization should feel local to the player being adjusted.
- Popup menus and compact controls should support quick repeated comparison work without making the stage feel crowded.
- All settings changes must be immediately reflected in the video window as they are changed.

## Test requirements
- Testing must take place without human intervention 
- Unit tests must be provided that provide 80% coverage
- Integrtion tests must be provided that test all end-to-end functionality
  - Loading a video
  - Loading an audio
  - Stem Separation with each supported model
  - Pitch detection with each supported model
- Pitch must be tested using synthetic fixed pitches, chromatic runs at 144 BPM 32nd notes, up and down holding at begining, top, and end for a half note.
- Pitch accuracy will be tested with these same test files.
- Various audio levels must be tested to verify the best vocal pitch capture.
- Test results should be reported in a markdown file for each pitch detector
  - Pitch accuracy
  - Pitch detection amplitude sensitivity
- Changing settings and verify they are updated in the window.
- Browser-based end-to-end verification is not required when equivalent or better automated desktop GUI verification exists.
- The preferred automated verification target is the Tauri desktop application and its real preprocessing workflow.

## Settings
- project persistence is required in order that the following would be remembered across sessions and video playbacks
  - Last / recent files
  - current pitch detector model
  - current stem separator model
  - pitch range for each player
  - position for each player
  - cache of pitch for each step for each player
- In other words, when the desktop app is brought up, it will restore the current state of everything.
  - Local file storage is required, desired, and allowed in order to meet these objectives.

## Development and Build Requirements
- The build must be hands-off, one script, from the github repo.
- Tests must be selectable as part of the build.
- Feedback must be given in case local resources are not sufficient for the build.
- Any dependent repos must also be brought from their sources, or make use of supported distributions of their products.
- Any AI models required must be obtained from github/huggingface, with local caching supported.

## Current Limitations

These are current known constraints, not desired end-state requirements:

- desktop preprocessing depends on an external Python environment
- backend availability depends on installed local models and Python packages
- the UI is still being refined
- desktop startup behavior is currently under investigation and is not yet stable enough to consider fully verified

## Future Requirements Candidates

These are likely requirement areas that may need to become formal requirements later:

- better stage stacking and overlap ergonomics
- clearer desktop startup and troubleshooting flow
- improved packaged desktop startup reliability
- more explicit import, preprocess, and error-recovery workflows

## Open Questions

- What is the minimum acceptable desktop startup path for a release build?
- What level of project persistence is required for a usable first release?
- Which preprocessing backends are mandatory versus optional?
- What are the acceptance criteria for pitch-display accuracy?
- What are the acceptance criteria for tiled layout behavior and overlap editing?

## Source Inputs For This Draft

- implemented application behavior
- current README
- current workspace UI and stage controls
- desktop preprocessing workflow already present in the codebase
- recent tiling, amplitude, and inspector work