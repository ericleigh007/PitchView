@echo off
setlocal

set "REPO_DIR=%~dp0"
cd /d "%REPO_DIR%"

if not defined PITCHVIEW_PYTHON (
  call :TryPython "%REPO_DIR%\.venv\Scripts\python.exe"
)

if not defined PITCHVIEW_PYTHON (
  call :TryPython "%USERPROFILE%\AITools\Qwen-Audio\.venv\Scripts\python.exe"
)

if defined PITCHVIEW_PYTHON (
  echo Using preprocess Python: %PITCHVIEW_PYTHON%
) else (
  echo PITCHVIEW_PYTHON is not set. Tauri will fall back to plain python on PATH.
  echo If preprocess fails, set PITCHVIEW_PYTHON to the venv that contains audio_separator.
)

call npm run tauri dev
goto :eof

:TryPython
if not exist "%~1" goto :eof
"%~1" -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('audio_separator') and importlib.util.find_spec('imageio_ffmpeg') and importlib.util.find_spec('onnxruntime') else 1)"
if errorlevel 1 goto :eof
set "PITCHVIEW_PYTHON=%~1"
goto :eof
