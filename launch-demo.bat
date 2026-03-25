@echo off
setlocal

cd /d "%~dp0"
set HOST=127.0.0.1
set PORT=1420

if not exist node_modules (
  echo Installing JavaScript dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)

:check_port
set PORT_PID=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"%HOST%:%PORT% .*LISTENING"') do (
  set PORT_PID=%%P
  goto :port_found
)
goto :start_server

:port_found
set PROCESS_NAME=
for /f "tokens=1" %%N in ('tasklist /fi "PID eq %PORT_PID%" /fo table /nh') do set PROCESS_NAME=%%N

if /i "%PROCESS_NAME%"=="node.exe" (
  echo PitchView demo already appears to be running on http://%HOST%:%PORT% .
  start "" http://%HOST%:%PORT%
  endlocal
  exit /b 0
)

set /a PORT=%PORT%+1
goto :check_port

:start_server
echo Starting PitchView demo on http://%HOST%:%PORT% ...
start "PitchView Demo Server" cmd /k "cd /d "%~dp0" && npm run dev -- --host %HOST% --port %PORT%"

timeout /t 4 /nobreak >nul
start "" http://%HOST%:%PORT%

echo Demo server launched. Close the spawned terminal window to stop it.
endlocal