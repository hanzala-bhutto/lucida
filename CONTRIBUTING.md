# Contributing to Lucida

Thanks for taking the time to help. Lucida is small and local-first by design —
contributions that keep it fast, private, and easy to run are very welcome.

## Set up

You'll need macOS on Apple Silicon, Node 20+, Rust (via `rustup`), Xcode
Command Line Tools, and [`uv`](https://github.com/astral-sh/uv).

```bash
# Frontend deps
npm install

# Python sidecar (MLX) — creates sidecar/.venv and installs mlx-lm
uv venv --python 3.12 sidecar/.venv
uv pip install --python sidecar/.venv/bin/python mlx-lm
```

## Run the app

```bash
npm run tauri dev      # hot-reload + auto-spawns the local model server
```

Beautify works immediately. "Suggest next" lights up once the model has loaded
(watch the status dot in the AI panel go grey → amber → green).

## Run the sanity tests

The `scratch/` tests are standalone — they are not part of the build:

```bash
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

## Workflow

Every change goes issue → branch → pull request. The full rules, including
which label an issue gets and how to name issues, branches, commits and PRs,
are in [docs/WORKFLOW.md](./docs/WORKFLOW.md); in short:

1. **Open or pick an issue** with a problem statement and acceptance criteria.
2. **Cut a fresh branch from an up-to-date `main`** for that issue only:
   `<type>/<issue>-<slug>`, e.g. `fix/14-save-on-close`. Types: `feat`, `fix`,
   `docs`, `chore`, `ci`, `refactor`, `test`, `perf`.
3. **Commit with [Conventional Commits](https://www.conventionalcommits.org/)**
   (`fix(board): save before the window closes`).
4. **Open a PR against `main`** with the template filled in, `Closes #<issue>`,
   and how you tested it. CI must pass.
5. PRs are **squash-merged** and the branch is deleted.

Keep PRs **small and focused**. Stack a PR on another one only when it truly
depends on unmerged work; say "Depends on #<n>" in its description.
