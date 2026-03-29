# Build PitchView

This file is the operational runbook for building, testing, launching, and debugging PitchView locally.

It is intentionally separate from `AGENTS.md`.

## Prerequisites

- Windows
- Node.js
- npm
- Cargo
- Python environment for desktop preprocessing
- `PITCHVIEW_PYTHON` set explicitly, or an activated virtual environment

Current known working Python path in this workspace:

```powershell
$env:PITCHVIEW_PYTHON='C:/Users/ericl/AITools/Qwen-Audio/.venv/Scripts/python.exe'
```

## One-Time Setup

```powershell
./scripts/bootstrap.ps1
```

Or:

```powershell
npm run bootstrap
```

## Standard Commands

Run tests:

```powershell
./scripts/test.ps1
```

Run tests plus real desktop GUI automation:

```powershell
./scripts/test.ps1 -IncludeGui
```

Build frontend and desktop host:

```powershell
./scripts/build.ps1
```

Build and include tests:

```powershell
./scripts/build.ps1 -RunTests
```

Launch the desktop app:

```powershell
./scripts/run.ps1
```

Run real desktop GUI automation:

```powershell
./scripts/gui-test.ps1
```

## Recommended Debug Loop

Preferred fast loop:

```powershell
npm run dev:loop
```

Equivalent direct script:

```powershell
./scripts/dev-loop.ps1
```

Useful variants:

Clear diagnostics log and show the tail:

```powershell
./scripts/dev-loop.ps1 -SkipTests -SkipBuild -ClearLog -ShowLog
```

Run continuously in a manual rerun loop:

```powershell
./scripts/dev-loop.ps1 -Loop
```

Run validation, then launch:

```powershell
./scripts/dev-loop.ps1 -Launch
```

## Diagnostics Log

Desktop diagnostics log path:

```text
C:\Users\ericl\AppData\Roaming\com.pitchview.app\pitchview.log
```

The dev loop can clear and tail this file.

The in-app diagnostics panel and the desktop log are intended to reflect the same processing activity.

## Current Workflow Guidance

- Use desktop import for real preprocessing runs.
- Watch the preprocessing phase indicator for:
  - `Stem separating`
  - `Pitch caching`
  - `Stem cache hit`
  - `Pitch cache hit`
- Use the diagnostics panel when playback or preprocessing fails.
- Re-import the same file to confirm cache reuse during debugging.

## When Debugging Playback Or Import

Recommended sequence:

1. Clear diagnostics log.
2. Launch app.
3. Reproduce the problem.
4. Read the in-app diagnostics panel.
5. If needed, inspect the desktop log file directly.

Suggested command:

```powershell
./scripts/dev-loop.ps1 -SkipTests -SkipBuild -ClearLog -ShowLog
```

## Script Layout

- `scripts/common.ps1`: shared environment and diagnostics helpers
- `scripts/bootstrap.ps1`: dependency and environment bootstrap
- `scripts/test.ps1`: frontend tests, demo verification, preprocessing tests
- `scripts/build.ps1`: frontend build and desktop host check
- `scripts/run.ps1`: launch Tauri desktop app
- `scripts/dev-loop.ps1`: repeatable local debug loop scaffold
- `scripts/gui-test.ps1`: real Tauri window automation for import, cache reuse, contours, and stem generation