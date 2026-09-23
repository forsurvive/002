@echo off
rem Story Engine - personal edition. One-click launcher: double-click this file.
rem Checks the Claude Code login (first run on each PC) and starts http://127.0.0.1:8801
rem KEEP THIS WINDOW OPEN while using the app.
rem Everything lives in this folder. To move to another PC, copy the whole folder.
rem NOTE: keep this file ASCII-only with CRLF line endings (cmd.exe reads it in the legacy codepage).
setlocal
chcp 65001 >nul 2>&1
title Story Engine - personal

rem Match a clean double-click environment: drop inherited CLAUDE_* variables.
for /f "delims==" %%v in ('set CLAUDE_ 2^>nul') do set "%%v="

rem Find node.exe: bundled portable (tools\node) first, then PATH. Nothing outside this folder.
set "NODE_EXE="
if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Put a portable Node in tools\node\ or install Node.js.
  pause
  exit /b 1
)

echo   Keep this window open while you write.
"%NODE_EXE%" "%~dp0tools\launch.mjs"

echo.
echo   Stopped. You can close this window.
pause
