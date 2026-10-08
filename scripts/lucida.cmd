@echo off
rem Open Lucida on a project folder: `lucida .` or `lucida C:\code\some-repo`.
rem That folder's board lives in <folder>\.lucida\board.excalidraw, and Lucida
rem reads its AGENTS.md / CLAUDE.md the way a coding agent would.
setlocal
set "target=%~1"
if "%target%"=="" set "target=."
if not exist "%target%\" (
  echo lucida: %target% is not a folder 1>&2
  exit /b 1
)
for %%I in ("%target%") do set "target=%%~fI"

set "app=%LUCIDA_APP%"
if "%app%"=="" set "app=%LOCALAPPDATA%\Lucida\Lucida.exe"
if not exist "%app%" set "app=%ProgramFiles%\Lucida\Lucida.exe"
if not exist "%app%" (
  echo lucida: Lucida.exe not found - install it, or set LUCIDA_APP 1>&2
  exit /b 1
)
start "" "%app%" "%target%"
