# Local text model for the Suggestions experiment: llama.cpp's OpenAI-compatible
# server on 127.0.0.1. Lucida starts and stops it; run setup.ps1 once first.
# The GGUF file is fetched from Hugging Face on first start.
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$port = if ($env:LUCIDA_AI_PORT) { $env:LUCIDA_AI_PORT } else { '8765' }
$model = if ($env:LUCIDA_AI_MODEL) { $env:LUCIDA_AI_MODEL } else { 'Qwen/Qwen2.5-3B-Instruct-GGUF' }
$file = if ($env:LUCIDA_AI_MODEL_FILE) { $env:LUCIDA_AI_MODEL_FILE } else { '*q4_k_m.gguf' }
& "$PSScriptRoot\.venv\Scripts\python.exe" -m llama_cpp.server `
  --hf_model_repo_id $model --model $file --model_alias $model `
  --n_ctx 8192 --host 127.0.0.1 --port $port
exit $LASTEXITCODE
