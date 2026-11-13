@echo off
setlocal DisableDelayedExpansion

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo Could not open the Telecart project folder.
  pause
  exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.16+ or 24+ is required. PostgreSQL is not needed.
  echo Install Node.js and pnpm, then double-click this file again.
  popd
  pause
  exit /b 1
)

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo pnpm is required but was not found on PATH.
  echo Install pnpm, then double-click this file again.
  popd
  pause
  exit /b 1
)

node "%~dp0scripts\dev-local.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Telecart stopped. Read the message above, fix it, and run this file again.
) else (
  echo.
  echo Telecart has stopped.
)

popd
pause
exit /b %EXIT_CODE%
