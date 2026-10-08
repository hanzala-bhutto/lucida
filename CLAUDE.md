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

## Workflow

Follow this for every task, however small.

1. **Issue first.** Find the issue for the task or create one with
   `gh issue create`: a problem statement, the proposal, and acceptance criteria
   as a checklist. Add labels: `bug`, `enhancement`, `documentation`, `chore`
   or `ci`.
2. **Fresh branch from `main`.**
   ```powershell
   git switch main
   git pull --ff-only origin main
   git switch -c <type>/<issue>-<short-slug>    # e.g. feat/12-release-workflow
   ```
   Types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `perf`.
   Never commit to `main` directly, and never reuse a branch for a second task.
3. **Work on the branch.** Keep the change scoped to the issue. Anything else
   you notice becomes a new issue, not part of this branch.
4. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/):
   `type(scope): summary`, imperative mood, a body that says what changed and
   why. Several small commits are fine; they are squashed on merge.
5. **Verify before pushing.** `npm run build` and `npm test`; if Rust changed,
   also `cargo fmt --check` and `cargo clippy -D warnings`. Run the app
   when the change is user-visible.
6. **Push and open a PR.**
   ```powershell
   git push -u origin <branch>
   gh pr create --repo hanzala-bhutto/lucida --base main --title "<type>(scope): summary" --body-file <file>
   ```
   Fill in every section of `.github/PULL_REQUEST_TEMPLATE.md`: summary,
   `Closes #<issue>`, changes, how it was tested (with real results), and the
   checklist, ticking only what was actually done. Add the issue's labels.
7. **CI must pass.** Check with `gh pr checks <n> --repo hanzala-bhutto/lucida`
   and fix failures on the same branch with new commits (no force-push once a
   PR is open).
8. **Merging is the maintainer's call.** Merge only when asked, with
   `gh pr merge <n> --repo hanzala-bhutto/lucida --squash --delete-branch`,
   then `git switch main && git pull --ff-only`.

### Stacked PRs

Do not stack by default. Stack only when a task truly depends on code in
another PR that is not merged yet:

- branch from the parent branch instead of `main`;
- open the PR with `--base <parent-branch>` and say "Depends on #<parent>" in
  the body;
- once the parent is squash-merged, rebase onto `main`
  (`git rebase --onto origin/main <parent-branch>`), retarget the PR to
  `main` (`gh pr edit <n> --base main`), and force-push with
  `--force-with-lease`.

### Attribution

Commits, PRs, issues and release notes carry **no AI attribution**: no
`Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line, no
mention of an assistant. `.claude/settings.json` turns the automatic lines off.

## Conventions

- Windows only: paths come from `%APPDATA%`, `%LOCALAPPDATA%`,
  `%ProgramData%` and `%USERPROFILE%`; scripts are `.ps1` or `.cmd` (CRLF,
  see `.gitattributes`); shortcuts and labels use Ctrl.
- Strict TypeScript; English in code, comments and docs; match the
  surrounding code.
- User-visible changes get an entry under `## [Unreleased]` in
  `CHANGELOG.md`.
- Every visible string goes through `src/lib/i18n.ts` (German and English).
