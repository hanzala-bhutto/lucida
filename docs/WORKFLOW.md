# Workflow

How work moves through this repository: **issue → branch → pull request →
squash-merge**. People and the coding agent follow the same rules.

## 1. What kind of work is it?

Every issue and every PR has exactly **one type**. The type decides the label,
the branch prefix and the commit/PR title prefix.

| Type | Use it when | Label | Branch | Title prefix |
|---|---|---|---|---|
| **Bug** | Something that exists behaves differently from what the README, the UI or the code says it should: a crash, wrong output, data loss, a broken build. | `bug` | `fix/` | `fix` |
| **Feature** | Users get something new, or an intended behaviour changes on purpose. | `enhancement` | `feat/` | `feat` |
| **Performance** | Same behaviour, measurably faster or lighter (startup, memory, render time). Say what you measured. | `performance` | `perf/` | `perf` |
| **Docs** | Only documentation changes: README, guides, comments, templates. | `documentation` | `docs/` | `docs` |
| **CI / build / release** | GitHub Actions, the release pipeline, bundling and installers, the build config. | `ci` | `ci/` | `ci` or `build` |
| **Chore** | Maintenance with no user-visible change: dependency updates, tooling, repo process. | `chore` | `chore/` | `chore` |
| **Refactor** | Code restructured, behaviour unchanged. | `chore` | `refactor/` | `refactor` |
| **Tests** | Only tests or test fixtures. | `chore` | `test/` | `test` |

Deciding between the close calls:

- **Bug or feature?** If the current behaviour is what was intended, the change
  is a feature, even when the current behaviour is annoying. "It doesn't save
  when I close the window within a second" is a bug (saving is promised).
  "Add a Save button" is a feature.
- **Refactor or feature?** If anything a user can see changes, it is not a
  refactor.
- **Docs or something else?** A PR that changes code *and* its docs takes the
  code's type.
- **Security:** a vulnerability is reported privately (see `SECURITY.md`),
  never as a public issue. Hardening work that is safe to discuss is a `bug`
  or `enhancement` with the extra `security` label.

Extra labels, added on top of the type label:

| Label | Meaning |
|---|---|
| `security` | Security hardening or a security fix |
| `breaking` | Changes behaviour users or integrations rely on (settings, file formats, the board API, the MCP tools). The title gets a `!`. |
| `tracking` | A larger goal split into several issues; it is closed when they all are, and never gets a branch itself. |
| `blocked` | Waiting on another issue, PR or decision. Say on what in a comment. |
| `good first issue`, `help wanted`, `question`, `duplicate`, `invalid`, `wontfix` | GitHub's usual meanings. |

## 2. Issues

**One issue = one PR.** If the work cannot be reviewed as one PR (more than
about a day of work or about 400 changed lines, or several independent parts),
open a `tracking` issue with a task list of smaller issues instead.

**Title:** plain language, sentence case, no type prefix (the label carries the
type), no trailing period. Describe the problem or the outcome, not the
implementation.

| Good | Not like this |
|---|---|
| `Board changes are lost when the window closes right after an edit` | `[bug] fix save` |
| `Publish a Windows installer on every release tag` | `Add release.yml` |
| `Settings dialog does not show the key store in German` | `i18n` |

**Body:** use the matching template (`Bug report`, `Feature request`, `Task`).
Every issue has **acceptance criteria** as a checklist: the conditions under
which the issue can be closed.

## 3. Branches

Cut every branch fresh from an up-to-date `main`:

```powershell
git switch main
git pull --ff-only origin main
git switch -c <type>/<issue>-<slug>
```

- `<type>`: the branch prefix from the table above.
- `<issue>`: the issue number.
- `<slug>`: 2–5 lowercase words joined by hyphens.

Examples: `fix/14-save-on-close`, `feat/12-release-installer`,
`chore/2-dev-workflow`, `refactor/21-split-whiteboard`.

Never commit to `main`, and never reuse a branch for a second issue.

## 4. Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>)<!>: <summary>

<body: what changed and why, wrapped at 72 columns>

<footer: Closes #<issue>, BREAKING CHANGE: …>
```

- **type:** the title prefix from the table (`feat`, `fix`, `perf`, `docs`, `ci`,
  `build`, `chore`, `refactor`, `test`).
- **scope** (optional, recommended): the part of the app, from the list below.
- **`!`** after the scope when the change is breaking.
- **summary:** imperative ("add", not "added"), lowercase start, no period, at
  most 72 characters for the whole first line.
- No AI attribution trailers.

Scopes:

| Scope | Covers |
|---|---|
| `board` | the canvas, saving and loading boards (`Whiteboard.tsx`, `board_save`) |
| `pictures` | picture generation and editing (`ai.ts` illustrate path) |
| `suggest` | suggestions and shape prediction |
| `plan` | the plan wall (`plan.ts`, `heist.ts`, `PlanInspector.tsx`) |
| `map` | the company map (`companyMap.ts`) |
| `poster` | the masterplan poster (`masterplan.ts`) |
| `settings` | settings, managed defaults, the key store |
| `i18n` | visible strings and translations |
| `api` | the board API (`board_api.rs`, `boardApi.ts`) |
| `mcp` | the MCP server (`mcp/server.mjs`) |
| `sidecar` | local models and Listen (`sidecar/`) |
| `shell` | other Rust in `src-tauri` (files, secrets, process handling) |
| `installer` | bundling, installers, app icon and identity |
| `deps` | dependency updates |

## 5. Pull requests

**Title:** the same format as a commit's first line, because it becomes the
squash commit on `main`:

```
<type>(<scope>)<!>: <summary>
```

Examples:

- `fix(board): save pending changes before the window closes`
- `feat(installer): publish a Windows installer on release tags`
- `feat!: make Lucida a Windows-only app and rebrand the fork`
- `chore: document the issue, branch and pull request workflow`

**Body:** fill in every section of the PR template:

- **Summary:** what and why, in one or two sentences.
- **`Closes #<issue>`**, so the issue closes on merge.
- **Changes:** one bullet per notable change.
- **Testing:** what you ran and what happened, and what was *not* tested.
- **Screenshots:** for UI changes.
- **Checklist:** tick only what was actually done; mark the rest
  "not applicable".

**Labels:** the same type label as the issue, plus any extra labels.

**Size:** one issue per PR. If review turns up unrelated work, open a new issue
for it.

**Updating a PR:** add new commits. Don't force-push an open PR, except when
rebasing a stacked PR (below).

## 6. Merging

- CI must be green (`gh pr checks <n> --repo hanzala-bhutto/lucida`).
- Merge with **squash**, keeping the PR title as the commit subject and the PR
  summary as the body, without attribution trailers:
  ```powershell
  gh pr merge <n> --repo hanzala-bhutto/lucida --squash `
    --subject "<PR title> (#<n>)" --body "<summary>`n`nCloses #<issue>"
  git switch main
  git pull --ff-only origin main
  ```
- The maintainer decides when to merge; the coding agent merges only when asked.
- **Never delete remote branches.** Merged branches stay on GitHub: no
  `--delete-branch`, no `git push --delete`, no `git push origin :<branch>`,
  no deleting from the GitHub UI. The repository's "Automatically delete head
  branches" setting stays off, and `.claude/settings.json` blocks the delete
  commands for the coding agent.

## 7. Stacked PRs

Not by default. Stack only when an issue needs code from a PR that is not merged
yet:

1. Branch from the parent branch instead of `main`.
2. Open the PR with `--base <parent-branch>` and write "Depends on #<parent>"
   under the summary.
3. After the parent is squash-merged:
   ```powershell
   git fetch origin
   git rebase --onto origin/main <parent-branch>
   git push --force-with-lease
   gh pr edit <n> --repo hanzala-bhutto/lucida --base main
   ```

## 8. Releases

Versions follow [Semantic Versioning](https://semver.org/). A `breaking` change
bumps the major version (minor while below 1.0), `feat` the minor, `fix` and
`perf` the patch. Move the `## [Unreleased]` entries in `CHANGELOG.md` under the
new version, and tag `v<version>` on `main`.
