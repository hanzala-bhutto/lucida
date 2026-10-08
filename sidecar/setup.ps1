# One-time setup for the local-model experiments: a .venv next to this script
# with llama.cpp's server (Suggestions) and faster-whisper (Listen). CPU wheels
# of llama-cpp-python, so no compiler is needed.
#
#   powershell -ExecutionPolicy Bypass -File sidecar\setup.ps1
$ErrorActionPreference = 'Stop'
$venv = Join-Path $PSScriptRoot '.venv'
$py = Join-Path $venv 'Scripts\python.exe'
$wheels = 'https://abetlen.github.io/llama-cpp-python/whl/cpu'
$pkgs = @('llama-cpp-python[server]', 'huggingface-hub', 'faster-whisper', 'sounddevice', 'numpy')

function Check { if ($LASTEXITCODE) { exit $LASTEXITCODE } }

if (Get-Command uv -ErrorAction SilentlyContinue) {
  uv venv --python 3.12 $venv; Check
  uv pip install --python $py --extra-index-url $wheels @pkgs; Check
} else {
  py -3.12 -m venv $venv; Check
  & $py -m pip install --upgrade pip; Check
  & $py -m pip install --prefer-binary --extra-index-url $wheels @pkgs; Check
}
Write-Host "Done. In Lucida's settings, set 'Folder for local models' to $PSScriptRoot"
