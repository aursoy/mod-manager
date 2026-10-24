@echo off
setlocal
title Kt Mod Manager - Build
cd /d "%~dp0"

echo.
echo ==========================================
echo          KT MOD MANAGER BUILD
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install Node.js LTS from https://nodejs.org/ then try again.
  pause
  exit /b 1
)

echo [1/3] Installing project dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/3] Packaging the app for Windows x64...
call npx --yes electron-packager . "Kt Mod Manager" --platform=win32 --arch=x64 --out=dist --overwrite --prune=true --ignore="^/dist($|/)" --ignore="^/samples($|/)" --ignore="^/test($|/)" --ignore="^/vendor($|/)"
if errorlevel 1 (
  echo [ERROR] Packaging failed.
  pause
  exit /b 1
)

echo.
echo [3/3] Build complete.
echo EXE location:
echo "%~dp0dist\Kt Mod Manager-win32-x64\Kt Mod Manager.exe"
echo.
echo Keep the full packaged folder together; the EXE needs its neighboring files.
pause
endlocal
