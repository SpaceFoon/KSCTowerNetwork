@echo off
setlocal
set ROOT=%~dp0
if not defined SESSION_ID set SESSION_ID=dev-shared
if not defined TOWER_API_BASE set TOWER_API_BASE=http://127.0.0.1:48787/v1
if not defined PCM_PORT set PCM_PORT=47372
if not defined CTL_PORT set CTL_PORT=47373
if not defined KSP_WATCHDOG set KSP_WATCHDOG=1
if not defined KSP_PROCESS_NAME set KSP_PROCESS_NAME=KSP_x64.exe

if not exist "%ROOT%node\node.exe" (
  echo [voice-bridge] FATAL: %ROOT%node\node.exe is missing. 1>&2
  echo [voice-bridge] This release was packaged without the bundled Node runtime. 1>&2
  echo [voice-bridge] Re-run scripts\build-bridge-runtime.ps1 -NodeExePath ^<path to node.exe^> 1>&2
  echo [voice-bridge] or download a Windows x64 node.exe from https://nodejs.org/dist/ 1>&2
  echo [voice-bridge] and place it at %ROOT%node\node.exe 1>&2
  exit /b 87
)

if not exist "%ROOT%app\dist\bridge.js" (
  echo [voice-bridge] FATAL: %ROOT%app\dist\bridge.js is missing. 1>&2
  echo [voice-bridge] The bridge app was not built into this release. 1>&2
  exit /b 88
)

"%ROOT%node\node.exe" "%ROOT%app\dist\bridge.js"
