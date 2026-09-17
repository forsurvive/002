@echo off
rem Story Engine (brand new 2) - one-click launcher. Double-click this file.
rem Handles login (first run only) and starts the app at http://127.0.0.1:8801
rem KEEP THIS WINDOW OPEN while using the app.
rem NOTE: keep this file ASCII-only (cmd.exe reads batch files in the legacy codepage).
setlocal
chcp 65001 >nul 2>&1
title Story Engine (keep this window open)

rem Match a clean double-click environment: drop inherited CLAUDE_* variables.
for /f "delims==" %%v in ('set CLAUDE_ 2^>nul') do set "%%v="

rem Find node.exe: local portable -> sibling folders -> PATH.
set NODE_EXE=
if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if "%NODE_EXE%"=="" for /d %%D in ("%~dp0..\*") do if exist "%%~fD\tools\node\node.exe" if not defined NODE_EXE set "NODE_EXE=%%~fD\tools\node\node.exe"
if "%NODE_EXE%"=="" (
  where node >nul 2>nul
  if not errorlevel 1 set NODE_EXE=node
)
if "%NODE_EXE%"=="" (
  echo [ERROR] node.exe not found. Put a portable Node in tools\node\ or install Node.js.
  pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0tools\launch.mjs"

echo.
echo   Stopped. You can close this window.
pause
