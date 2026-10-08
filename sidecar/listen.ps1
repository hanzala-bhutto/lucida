# Local speech server for the Listen experiment (faster-whisper). Lucida starts
# and stops it; run setup.ps1 once first.
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
if (-not $env:LUCIDA_LISTEN_PORT) { $env:LUCIDA_LISTEN_PORT = '8766' }
if (-not $env:LUCIDA_LISTEN_MODEL) { $env:LUCIDA_LISTEN_MODEL = 'large-v3-turbo' }
& "$PSScriptRoot\.venv\Scripts\python.exe" "$PSScriptRoot\listen.py"
exit $LASTEXITCODE
