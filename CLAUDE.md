# CLAUDE.md

Lucida for Windows: a Tauri 2 desktop whiteboard (React + Excalidraw frontend in
`src/`, Rust shell in `src-tauri/`, MCP server in `mcp/`). Windows 10/11 x64 only.
Forked from [Lang-Julian/lucida](https://github.com/Lang-Julian/lucida) — keep
his credit in `README.md` and `LICENSE`.

Repository: `hanzala-bhutto/lucida`. Always pass `--repo hanzala-bhutto/lucida`
to `gh`, because this is a fork and `gh` otherwise defaults to the parent repo.

## Commands

```powershell
npm install
npm run build                 # tsc + vite build
npm test                      # pure-logic tests, no app, no network
npm run tauri dev             # run the app
npm run tauri build           # lucida.exe + NSIS/MSI installers
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

If `cargo` is not found, add `%USERPROFILE%\.cargo\bin` to `PATH`.

## Every task

Follow the workflow below for every task, however small:

1. Find or create the issue: one type label, a plain-language title, and
   acceptance criteria.
2. `git switch main && git pull --ff-only origin main`, then
   `git switch -c <type>/<issue>-<slug>`.
3. Work only on that issue; anything else becomes a new issue.
4. Conventional Commits; verify (build, tests, clippy if Rust changed) before
   pushing.
5. Open the PR with a `<type>(<scope>): <summary>` title, every template
   section filled in, `Closes #<issue>`, and the issue's labels.
6. Get CI green; merge (squash) only when the maintainer asks.

Commits, PRs, issues and release notes carry **no AI attribution**: no
`Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line, no
mention of an assistant. `.claude/settings.json` turns the automatic lines off.

@docs/WORKFLOW.md

## Conventions

- Windows only: paths come from `%APPDATA%`, `%LOCALAPPDATA%`,
  `%ProgramData%` and `%USERPROFILE%`; scripts are `.ps1` or `.cmd` (CRLF,
  see `.gitattributes`); shortcuts and labels use Ctrl.
- Strict TypeScript; English in code, comments and docs; match the
  surrounding code.
- User-visible changes get an entry under `## [Unreleased]` in
  `CHANGELOG.md`.
- Every visible string goes through `src/lib/i18n.ts` (German and English).
