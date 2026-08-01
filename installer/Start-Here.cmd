@echo off
rem BridgesLLM Remote GPU launcher. PowerShell performs one bounded UAC
rem relaunch when needed and returns the elevated setup's exact exit code.
title BridgesLLM Remote GPU Setup
set "setup_args="
if "%~1"=="" goto run_setup
if /I "%~1"=="--retire-legacy-helper" (
  if not "%~2"=="" goto invalid_arguments
  set "setup_args=-RetireLegacyHelper"
  goto run_setup
)

:invalid_arguments
echo.
echo Unsupported argument. Run Start-Here.cmd normally for setup, or use:
echo   Start-Here.cmd --retire-legacy-helper
echo only after the Portal shows this PC as the active native Remote GPU.
echo.
pause
exit /b 64

:run_setup
if defined setup_args (
  title BridgesLLM Legacy Remote GPU Cleanup
  echo Starting post-activation legacy helper retirement...
  echo The native Tailscale Serve listener will remain configured.
) else (
  echo Starting the BridgesLLM Remote GPU setup...
  echo This configures native Tailscale Serve. No background window is required.
)
echo Windows may show one UAC prompt. This setup runs Tailscale Serve from
echo an Administrator terminal. Approve it and continue in that window.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-OllamaTailnet.ps1" %setup_args%
set "setup_rc=%errorlevel%"
exit /b %setup_rc%
