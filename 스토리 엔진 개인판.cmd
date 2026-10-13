@echo off
rem Story Engine - personal edition. One-click launcher: double-click this file.
rem Checks the Claude Code login (first run on each PC) and starts http://127.0.0.1:8801
rem KEEP THIS WINDOW OPEN while using the app.
rem Everything lives in this folder. It runs the same from a USB stick or from a folder on the PC.
rem To move to another PC, copy the whole folder.
rem NOTE: keep this file ASCII-only with CRLF line endings (cmd.exe reads it in the legacy codepage).
setlocal
chcp 65001 >nul 2>&1
title Story Engine - personal
set "HERE=%~dp0"

rem Match a clean double-click environment: drop inherited CLAUDE_* variables.
for /f "delims==" %%v in ('set CLAUDE_ 2^>nul') do set "%%v="

rem Find node.exe: bundled portable (tools\node) first, then fetch it into tools\node once, then PATH.
rem Nothing outside this folder.
set "NODE_EXE="
if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if not defined NODE_EXE call :getnode
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Put a portable Node in tools\node\ or install Node.js.
  echo         Download: %NODE_URL%
  pause
  exit /b 1
)

echo   Keep this window open while you write.
"%NODE_EXE%" "%~dp0tools\launch.mjs"

echo.
echo   Stopped. You can close this window.
pause
exit /b 0

rem ---- Fetch the portable Node into tools\node (first run only). Same file and SHA256 as tools\usb-build.mjs.
:getnode
set "NODE_URL=https://nodejs.org/dist/v22.23.3/win-x64/node.exe"
set "NODE_SHA=9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e"
set "NODE_TMP=%HERE%tools\node\node.exe.tmp"
where curl >nul 2>nul
if errorlevel 1 goto :eof
if not exist "%HERE%tools\node" mkdir "%HERE%tools\node"
echo   ------------------------------------------------------------
echo    First run: downloading Node.js into tools\node (about 90MB, once)
echo    Source: %NODE_URL%
echo   ------------------------------------------------------------
curl -fL --retry 2 -o "%NODE_TMP%" "%NODE_URL%"
if errorlevel 1 goto :getnode_fail
set "GOT="
for /f "delims=" %%h in ('certutil -hashfile "%NODE_TMP%" SHA256 ^| findstr /v ":"') do if not defined GOT set "GOT=%%h"
if not defined GOT goto :getnode_bad
set "GOT=%GOT: =%"
if /i not "%GOT%"=="%NODE_SHA%" goto :getnode_bad
move /y "%NODE_TMP%" "%HERE%tools\node\node.exe" >nul
if exist "%HERE%tools\node\node.exe" set "NODE_EXE=%HERE%tools\node\node.exe"
echo   [OK] node.exe checked (SHA256) and saved in tools\node
echo.
goto :eof
:getnode_bad
echo   [ERROR] The downloaded node.exe did not match the expected SHA256. It was deleted.
del /f /q "%NODE_TMP%" >nul 2>nul
goto :eof
:getnode_fail
echo   [WARN] Could not download node.exe (no internet?).
del /f /q "%NODE_TMP%" >nul 2>nul
goto :eof
