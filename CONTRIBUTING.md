# Contributing to Lucida

Thanks for taking the time to help. Lucida is small and local-first by design —
contributions that keep it fast, private, and easy to run are very welcome.

## Set up

You'll need Windows 10/11 x64, Node 20+, Rust (via `rustup`, MSVC toolchain),
the Visual Studio Build Tools with the **Desktop development with C++**
workload, and — for the local-model experiments only — Python 3.12 or
[`uv`](https://github.com/astral-sh/uv).

```powershell
# Frontend deps
npm install

# Python sidecar (llama.cpp + faster-whisper) — creates sidecar\.venv
powershell -ExecutionPolicy Bypass -File sidecar\setup.ps1
```

## Run the app

```powershell
npm run tauri dev      # hot-reload
```

Beautify works immediately. "Suggest next" lights up once the model has loaded
(watch the status dot in the AI panel go grey → amber → green).

## Run the sanity tests

The `scratch/` tests are standalone — they are not part of the build:

```powershell
npx tsx scratch/test-recognizer.ts   # synthetic strokes → expected shapes
npx tsx scratch/test-ai.ts           # model-output parsing + skeleton building
```

## Code style

- **Strict TypeScript.** The build runs `tsc` with `noUnusedLocals` and
  `noUnusedParameters` — keep it clean, no `any` escape hatches.
- **English everywhere** in code, comments, and docs.
- **Match the surrounding code.** Calm, terse, and consistent with the file
  you're editing beats clever.
- Shared contracts live in `src/lib/types.ts` and `src/lib/config.ts` — treat
  them as the single source of truth and change them deliberately.

## Pull requests

- Keep `npm run build` (`tsc && vite build`) green.
- Keep PRs **small and focused** — one change per PR is easier to review.
- Describe what changed and why; if it touches behavior, note how you tested it.

That's it. Open an issue first if you're planning something larger.
