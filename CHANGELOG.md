# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Lucida is now a Windows app** (Windows 10/11 x64); macOS is no longer
  supported. Settings and the board API token live in `%APPDATA%\Lucida`,
  managed defaults in `%ProgramData%\Lucida\defaults.json`, the OpenRouter
  key in Windows Credential Manager (setting value `keyStore: "credentials"`).
  Shortcuts use Ctrl. Bundles are an NSIS installer (per user) and an MSI.
- **Local models** run on llama.cpp (`Qwen/Qwen2.5-3B-Instruct-GGUF`) and
  faster-whisper instead of MLX; `sidecar\setup.ps1` builds the `.venv`, and
  `serve.ps1` / `listen.ps1` replace the shell scripts.
- `scripts\lucida.cmd` replaces `scripts/lucida`; the MCP server finds and
  starts `Lucida.exe` (or `LUCIDA_APP`).

### Fixed

- The board API token is drawn from the OS random generator; it no longer
  depends on `/dev/urandom`, which does not exist on Windows.

## [0.2.0] — 2026-10-05

The board loses its side panel and gains a job: pictures from a word, a plan
wall that writes Markdown files, and a door for agents.

### Added

- **Pictures from a word.** Select a word (or a sketch) and a **✦ Bild** chip
  appears under it; `⌘I` does the same. Click a picture to change it ("make
  the roof red" — the model gets the picture itself, so it edits rather than
  re-rolls) or **↻** to draw the same subject again. `⌘Z` brings the old one
  back. Default model `openai/gpt-image-2.5-flare` with a transparent
  background; any OpenRouter image model can be picked in the settings.
- **Settings (`⌘,`)** — language (German / English / System), appearance,
  folder, **organisation** (name, accent colour, logo for light and dark
  surfaces), OpenRouter key and where it is kept, image model and text models
  (listed live from OpenRouter), picture style, Zero Data Retention, and the
  experiments with their folder. Stored in
  `~/Library/Application Support/Lucida/settings.json`.
- **Managed defaults for IT** — `/Library/Application Support/Lucida/
  defaults.json` sets defaults for every user and locks keys that must not
  change; locked values are shown, not editable.
- **German and English** throughout — the app, the plan wall, the company map
  and the posters.
- **Agents on the board (MCP).** A board API on `127.0.0.1:8767` (bearer token
  in `~/Library/Application Support/Lucida/board-api.json`, 0600; requests from
  web pages refused) and a dependency-free MCP server, `mcp/server.mjs`, with
  `get_board`, `add_nodes`, `add_image`, `render_masterplan`, `plan_board`,
  `company_map`, `export_png`, `discard_proposal`, `set_intent`, `open_folder`.
  Everything an agent adds arrives as a proposal (`⌘↵` keep, `Esc` drop). The
  MCP server starts Lucida if it is not running.
- **Plan wall, two-way.** `wiki/plan/*.md` — one small file per goal, horizon,
  front, card, decision, risk, process and step — drawn as a heist wall: the
  goal in a dossier with a countdown, the crew as polaroids, pinned index
  cards per front × horizon, sticky notes for open decisions, stamped risks,
  red string wherever one card waits on another. Dragging a card, dropping a
  polaroid on it, drawing or deleting a string, typing a title, writing a word
  into a cell, deleting a card (→ archived, never deleted) or moving a step
  writes the file; editing a file redraws the wall within ~2 s. A clean grid
  look is kept (`plan_board(look: "clean")`). `npm run demo` writes a
  fictional plan to try it.
- **Masterplan poster** — `render_masterplan` lays out a plan as one finished
  infographic with a generated picture per phase, and `export_png` writes it
  as a 2× PNG.
- **Live company map** — `company_map` draws every entity page of a Markdown
  wiki (`wiki/entities/*.md`), grouped by tags, and redraws it when a page
  changes. Frontmatter and `index.md` only; pages marked `access: leadership`
  stay off unless asked for.
- **One board per folder, any number of folders** — `lucida <folder>` opens the
  board in `<folder>/.lucida/`, and "Ordner öffnen …" switches folders.

### Changed

- **No side panel.** The canvas is the whole window; settings live in `⌘,`, the
  menu holds the folder and the live boards, and a small pill shows only while
  something runs.
- **The OpenRouter key lives in the macOS Keychain** (or a 0600 key file, if
  chosen), never in the webview's storage; a key from 0.1.0 is moved once,
  automatically.
- **No organisation is built in.** Posters, the company map, the plan wall and
  the house picture style take name, colour and logo from the settings; without
  them everything is neutral.
- No paths are assumed: the MCP tools use the folder open in Lucida, the local
  models a folder set in the settings.
- **Privacy on every cloud call:** OpenRouter Zero Data Retention routing
  (`provider: {zdr: true, data_collection: "deny"}`, falling back to
  `data_collection: "deny"` only for models without a ZDR endpoint) and no app
  attribution headers.
- **The local model no longer starts with the app.** Suggestions, live stroke
  prediction and listening are experiments, off by default; the MLX server
  only starts when "Vorschläge" is on without a key.
- Pictures are never guessed: nothing selected means nothing is drawn.

### Fixed

- A title cut short to fit its card is no longer written back as an edit.
- An agent's poster is no longer accepted by the click that focuses the window.
- Requests right after launch wait for the folder's board instead of drawing on
  one about to be replaced.

## [0.1.0] — 2026-06-15

Initial public release.

### Added

- **Beautify** — freehand strokes snap to clean shapes (rectangle, ellipse,
  diamond, triangle, line) on pen-up, via a pure-geometry recognizer. Works
  fully offline.
- **Suggest next** — a local MLX LLM (`Qwen2.5-3B-Instruct-4bit` by default)
  proposes the next 1–3 diagram elements, rendered as editable "ghost" elements
  you accept or dismiss.
- Tauri v2 shell that manages the `mlx_lm.server` sidecar (spawn / adopt an
  existing server / stop) and exposes `ai_start` / `ai_stop` / `ai_status`.
- Glassmorphic UI with light & dark themes, a status pill, a welcome hint, an
  error toast, and keyboard shortcuts (⌘↵ suggest/accept, Esc dismiss, ⌘B beautify).
- GitHub Actions CI (build + sanity tests + Rust fmt/clippy/build), a custom
  icon + favicon, and full documentation.

[Unreleased]: https://github.com/Lang-Julian/lucida/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lang-Julian/lucida/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lang-Julian/lucida/releases/tag/v0.1.0
