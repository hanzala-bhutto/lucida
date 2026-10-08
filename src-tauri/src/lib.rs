use std::fs::{self, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, State};

mod board_api;
use board_api::BoardApi;
use std::sync::Arc;

/// TCP port for the local model server. LUCIDA_AI_PORT overrides the default.
fn port() -> u16 {
    std::env::var("LUCIDA_AI_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8765)
}

/// Hugging Face repo of the GGUF model served by llama_cpp.server.
/// LUCIDA_AI_MODEL overrides the default.
fn model() -> String {
    std::env::var("LUCIDA_AI_MODEL").unwrap_or_else(|_| "Qwen/Qwen2.5-3B-Instruct-GGUF".to_string())
}

/// TCP port for the local speech server. LUCIDA_LISTEN_PORT overrides the default.
fn listen_port() -> u16 {
    std::env::var("LUCIDA_LISTEN_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8766)
}

/// faster-whisper model served by listen.py. LUCIDA_LISTEN_MODEL overrides the default.
fn listen_model() -> String {
    std::env::var("LUCIDA_LISTEN_MODEL").unwrap_or_else(|_| "large-v3-turbo".to_string())
}

/// The user's profile folder, `C:\Users\<name>`.
fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// A folder from an environment variable, or a path under the profile when
/// it is unset (on a normal Windows login it always is set).
fn env_dir(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(fallback))
}

/// `%APPDATA%\Lucida` — settings and the board API token.
pub(crate) fn support_dir() -> PathBuf {
    env_dir("APPDATA", "AppData\\Roaming").join("Lucida")
}

/// Where serve.ps1, listen.ps1 and their .venv live, unless the settings (or
/// LUCIDA_AI_DIR) name another folder. Only the experiments need it. Local,
/// not roaming: the .venv and the models are gigabytes.
fn default_sidecar_dir() -> PathBuf {
    std::env::var("LUCIDA_AI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            env_dir("LOCALAPPDATA", "AppData\\Local")
                .join("Lucida")
                .join("sidecar")
        })
}

/// Start a process without flashing a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Whether something is already listening on the local server port — e.g. a
/// server left behind by a `tauri dev` hot-reload, or one started by hand.
fn port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// Owns one local server child process and its config. Two live in the app:
/// the llama.cpp text model (`AiSidecar`) and the Whisper speech server
/// (`ListenSidecar`); both are the same shape.
struct Sidecar {
    child: Mutex<Option<Child>>,
    port: u16,
    model: String,
    /// the folder holding the script and its .venv — set from the settings
    dir: Mutex<PathBuf>,
    script: &'static str,
    log: &'static str,
    /// name of the env var the script reads the port from, and the model from
    env_port: &'static str,
    env_model: &'static str,
}

struct AiSidecar(Sidecar);
struct ListenSidecar(Sidecar);

impl Sidecar {
    /// Start the server if it isn't already alive. Idempotent. `dir` is the
    /// sidecar folder from the settings; empty keeps the current one.
    fn spawn(&self, dir: Option<String>) -> Result<(), String> {
        if let Some(d) = dir.filter(|d| !d.trim().is_empty()) {
            if let Ok(mut g) = self.dir.lock() {
                *g = PathBuf::from(d.trim());
            }
        }
        let dir = self.dir.lock().map_err(|e| e.to_string())?.clone();
        let script = dir.join(self.script);
        if !script.is_file() {
            return Err(format!(
                "{} not found — set the folder for local models in the settings",
                script.display()
            ));
        }
        let mut child = self.child.lock().map_err(|e| e.to_string())?;
        if let Some(c) = child.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
        // A server may already be serving on the port (a dev hot-reload can
        // leave one behind, or the user started one by hand). Adopt it rather
        // than spawning a duplicate that would just fail to bind.
        if port_in_use(self.port) {
            return Ok(());
        }
        let out = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(self.log))
            .map_err(|e| e.to_string())?;
        let err = out.try_clone().map_err(|e| e.to_string())?;
        let ch = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .env(self.env_port, self.port.to_string())
            .env(self.env_model, &self.model)
            .stdout(out)
            .stderr(err)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        *child = Some(ch);
        Ok(())
    }

    /// Kill the server child — the PowerShell script and the Python server it
    /// started — and reap it. Best-effort.
    fn stop(&self) {
        if let Ok(mut g) = self.child.lock() {
            if let Some(mut c) = g.take() {
                // Killing the script alone would orphan Python; /T takes the tree.
                let _ = Command::new("taskkill")
                    .args(["/PID", &c.id().to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }

    /// Whether a server is reachable — either our own child or one we adopted.
    fn running(&self) -> bool {
        if let Ok(mut g) = self.child.lock() {
            if let Some(c) = g.as_mut() {
                if matches!(c.try_wait(), Ok(None)) {
                    return true;
                }
            }
        }
        port_in_use(self.port)
    }
}

fn status_of(s: &Sidecar) -> serde_json::Value {
    serde_json::json!({
        "running": s.running(),
        "port": s.port,
        "model": s.model,
    })
}

#[tauri::command]
fn ai_start(state: State<AiSidecar>, dir: Option<String>) -> Result<(), String> {
    state.0.spawn(dir)
}

#[tauri::command]
fn ai_stop(state: State<AiSidecar>) {
    state.0.stop()
}

#[tauri::command]
fn ai_status(state: State<AiSidecar>) -> serde_json::Value {
    status_of(&state.0)
}

/// The speech server is started on demand — the first toggle of Listen — so a
/// user who never speaks never downloads a Whisper model.
#[tauri::command]
fn listen_start(state: State<ListenSidecar>, dir: Option<String>) -> Result<(), String> {
    state.0.spawn(dir)
}

#[tauri::command]
fn listen_stop(state: State<ListenSidecar>) {
    state.0.stop()
}

#[tauri::command]
fn listen_status(state: State<ListenSidecar>) -> serde_json::Value {
    status_of(&state.0)
}

/* ───────────────────────────  Project folder  ─────────────────────────── */

/// Files a board reads from the folder it belongs to. Everything is optional —
/// a folder that is not a repo is still a perfectly good place for a board.
#[derive(serde::Serialize)]
struct ProjectFiles {
    path: String,
    /// directory name, the fallback title when no manifest names the project
    dir_name: String,
    agents: Option<String>,
    claude: Option<String>,
    readme: Option<String>,
    package_json: Option<String>,
    /// the saved board, if this folder already has one
    board: Option<String>,
}

/// Read a file if it is there and small enough to be a document rather than data.
fn read_doc(dir: &std::path::Path, name: &str) -> Option<String> {
    let p = dir.join(name);
    let meta = fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > 512 * 1024 {
        return None;
    }
    fs::read_to_string(&p).ok()
}

/// Where a folder's board lives. One board per folder, beside the code.
fn board_path(dir: &std::path::Path) -> PathBuf {
    dir.join(".lucida").join("board.excalidraw")
}

/// The folder passed on the command line (`lucida .`), if it is a directory.
#[tauri::command]
fn launch_project() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let p = std::path::Path::new(&arg);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            std::env::current_dir().ok()?.join(p)
        };
        if abs.is_dir() {
            return abs.canonicalize().ok().map(|c| c.display().to_string());
        }
    }
    None
}

/// Everything the board needs to know about the folder it is opening in.
#[tauri::command]
fn project_open(path: String) -> Result<ProjectFiles, String> {
    let dir = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(ProjectFiles {
        dir_name: dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        agents: read_doc(&dir, "AGENTS.md"),
        claude: read_doc(&dir, "CLAUDE.md"),
        readme: read_doc(&dir, "README.md"),
        package_json: read_doc(&dir, "package.json"),
        board: fs::read_to_string(board_path(&dir)).ok(),
        path: dir.display().to_string(),
    })
}

/// Write the board into its folder. Creates `.lucida/` on first save.
#[tauri::command]
fn board_save(path: String, json: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let target = board_path(dir);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, json).map_err(|e| e.to_string())
}

/* ───────────────────────────  Company map (a Markdown wiki)  ─────────────────────────── */

/// Only the frontmatter of each page leaves this function — names, categories,
/// tags, access and dates. Page bodies (meeting notes, contracts) are never read
/// into the webview for the map.
#[derive(serde::Serialize)]
struct WikiPage {
    /// "entities" | "concepts"
    dir: String,
    slug: String,
    front: String,
}

#[derive(serde::Serialize)]
struct WikiSnapshot {
    /// the index's one-line descriptions, the curated summary of every page
    index: Option<String>,
    pages: Vec<WikiPage>,
}

const WIKI_DIRS: [&str; 2] = ["entities", "concepts"];

fn wiki_dir(root: &str) -> Result<PathBuf, String> {
    let wiki = std::path::Path::new(root).join("wiki");
    if !wiki.join("entities").is_dir() {
        return Err(format!("{root} has no wiki/entities folder"));
    }
    Ok(wiki)
}

fn frontmatter(text: &str) -> String {
    let Some(rest) = text.strip_prefix("---") else {
        return String::new();
    };
    match rest.find("\n---") {
        Some(end) => rest[..end].to_string(),
        None => String::new(),
    }
}

/// A cheap fingerprint of the wiki: every page's size and mtime. The map polls
/// this and rebuilds only when it changes.
#[tauri::command]
fn wiki_stamp(root: String) -> Result<String, String> {
    let wiki = wiki_dir(&root)?;
    let mut acc: u64 = 1469598103934665603;
    let mut mix = |v: u64| {
        acc ^= v;
        acc = acc.wrapping_mul(1099511628211);
    };
    let mut count = 0u64;
    let mut files: Vec<PathBuf> = vec![wiki.join("index.md")];
    for d in WIKI_DIRS {
        if let Ok(rd) = fs::read_dir(wiki.join(d)) {
            files.extend(rd.flatten().map(|e| e.path()));
        }
    }
    for f in files {
        if let Ok(m) = fs::metadata(&f) {
            count += 1;
            mix(m.len());
            if let Ok(t) = m.modified() {
                if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                    mix(d.as_millis() as u64);
                }
            }
            for b in f.to_string_lossy().bytes() {
                mix(b as u64);
            }
        }
    }
    Ok(format!("{count}-{acc:x}"))
}

#[tauri::command]
fn wiki_read(root: String) -> Result<WikiSnapshot, String> {
    let wiki = wiki_dir(&root)?;
    let mut pages = Vec::new();
    for d in WIKI_DIRS {
        let Ok(rd) = fs::read_dir(wiki.join(d)) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&p) else {
                continue;
            };
            pages.push(WikiPage {
                dir: d.to_string(),
                slug: p
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                front: frontmatter(&text),
            });
        }
    }
    pages.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(WikiSnapshot {
        index: fs::read_to_string(wiki.join("index.md")).ok(),
        pages,
    })
}

/* ───────────────────────────  Plan (wiki/plan — the SSOT)  ─────────────────────────── */

/// One plan file: its slug and the whole text. The plan is small, and the
/// board needs the body too — it is where the "why" of a card lives.
#[derive(serde::Serialize)]
struct PlanFile {
    slug: String,
    text: String,
}

fn plan_dir(root: &str) -> Result<PathBuf, String> {
    Ok(wiki_dir(root)?.join("plan"))
}

/// A slug is a file name the board may write: lowercase, digits, dashes.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 96
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[tauri::command]
fn plan_stamp(root: String) -> Result<String, String> {
    let dir = plan_dir(&root)?;
    let mut acc: u64 = 1469598103934665603;
    let mut count = 0u64;
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let Ok(m) = e.metadata() else { continue };
            count += 1;
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            for v in [m.len(), mtime] {
                acc ^= v;
                acc = acc.wrapping_mul(1099511628211);
            }
            for b in e.file_name().to_string_lossy().bytes() {
                acc ^= b as u64;
                acc = acc.wrapping_mul(1099511628211);
            }
        }
    }
    Ok(format!("{count}-{acc:x}"))
}

#[tauri::command]
fn plan_read(root: String) -> Result<Vec<PlanFile>, String> {
    let dir = plan_dir(&root)?;
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let slug = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if !valid_slug(&slug) {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&p) {
            out.push(PlanFile { slug, text });
        }
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Write one plan file. Atomic (temp file + rename), so Obsidian or a sync
/// never sees half a file, and confined to `wiki/plan/<slug>.md`.
#[tauri::command]
fn plan_write(root: String, slug: String, text: String) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err(format!("not a plan slug: {slug}"));
    }
    let dir = plan_dir(&root)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{slug}.md"));
    let tmp = dir.join(format!(".{slug}.md.tmp"));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

/* ───────────────────────────  Secrets  ─────────────────────────── */

/// Only these may be read or written from the webview.
const SECRET_NAMES: [&str; 1] = ["OPENROUTER_API_KEY"];
/// The Windows Credential Manager service Lucida's items are filed under
/// (listed there as `<name>.Lucida`).
const CREDENTIAL_SERVICE: &str = "Lucida";

fn secret_allowed(name: &str) -> Result<(), String> {
    if SECRET_NAMES.contains(&name) {
        Ok(())
    } else {
        Err(format!("{name} is not a secret Lucida uses"))
    }
}

/// A key file: `NAME=value` lines in the user's profile, which only they can
/// read. `%USERPROFILE%\.env.secrets` unless the settings name another; a
/// leading `~` stands for the profile.
fn secrets_file(path: Option<&str>) -> PathBuf {
    match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => match p.strip_prefix('~') {
            Some(rest) => home_dir().join(rest.trim_start_matches(['/', '\\'])),
            None => PathBuf::from(p),
        },
        None => home_dir().join(".env.secrets"),
    }
}

fn file_get(path: &PathBuf, name: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    text.lines().find_map(|line| {
        let (k, v) = line.trim().split_once('=')?;
        (k.trim() == name)
            .then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|v| !v.is_empty())
    })
}

fn file_set(path: &PathBuf, name: &str, value: &str) -> Result<(), String> {
    let old = fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<String> = old
        .lines()
        .filter(|l| {
            l.trim()
                .split_once('=')
                .map(|(k, _)| k.trim() != name)
                .unwrap_or(true)
        })
        .map(String::from)
        .collect();
    if !value.is_empty() {
        lines.push(format!("{name}={value}"));
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    write_private(path, &text)
}

/// Write a file atomically. The files this writes live in the user's profile
/// (`%APPDATA%`, `%USERPROFILE%`), whose ACL already keeps other users out.
fn write_private(path: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("lucida-tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn credential(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, name).map_err(|e| e.to_string())
}

fn credential_get(name: &str) -> Option<String> {
    credential(name)
        .ok()?
        .get_password()
        .ok()
        .filter(|v| !v.is_empty())
}

fn credential_set(name: &str, value: &str) -> Result<(), String> {
    let entry = credential(name)?;
    if value.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

/// Read a secret from where the settings keep it: the Windows Credential
/// Manager (default) or a key file.
#[tauri::command]
fn secret_get(
    name: String,
    storage: Option<String>,
    file: Option<String>,
) -> Result<Option<String>, String> {
    secret_allowed(&name)?;
    Ok(match storage.as_deref() {
        Some("file") => file_get(&secrets_file(file.as_deref()), &name),
        _ => credential_get(&name),
    })
}

/// Set or (with an empty value) remove one secret in the chosen store.
#[tauri::command]
fn secret_set(
    name: String,
    value: String,
    storage: Option<String>,
    file: Option<String>,
) -> Result<(), String> {
    secret_allowed(&name)?;
    let value = value.trim();
    if value.contains('\n') || value.contains('\r') {
        return Err("a key is one line".into());
    }
    match storage.as_deref() {
        Some("file") => file_set(&secrets_file(file.as_deref()), &name, value),
        _ => credential_set(&name, value),
    }
}

/* ───────────────────────────  Settings  ─────────────────────────── */

/// Settings live in a file, not in the webview: one place to back up, and
/// one an administrator can provision.
///
///  - `%APPDATA%\Lucida\settings.json` — the user's own;
///  - `%ProgramData%\Lucida\defaults.json` — optional, written by IT (Intune,
///    Group Policy): `{ "defaults": {…}, "locked": ["key", …] }`. Defaults fill
///    what the user has not set; locked keys cannot be changed in the app.
fn user_settings_file() -> PathBuf {
    support_dir().join("settings.json")
}

fn managed_settings_file() -> PathBuf {
    std::env::var("LUCIDA_MANAGED_SETTINGS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var_os("ProgramData")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
                .join("Lucida")
                .join("defaults.json")
        })
}

#[tauri::command]
fn settings_read() -> serde_json::Value {
    let read = |p: PathBuf| -> serde_json::Value {
        fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::Value::Null)
    };
    let managed = read(managed_settings_file());
    serde_json::json!({
        "user": read(user_settings_file()),
        "defaults": managed.get("defaults").cloned().unwrap_or(serde_json::Value::Null),
        "locked": managed.get("locked").cloned().unwrap_or(serde_json::json!([])),
        "path": user_settings_file().display().to_string(),
        "managedPath": managed_settings_file().display().to_string(),
        "managed": !managed.is_null(),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
fn settings_write(settings: serde_json::Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("settings must be an object".into());
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    write_private(&user_settings_file(), &text)
}

/// A picked logo as a data URL, so the board can hang it. Images only, at most 2 MB.
#[tauri::command]
fn image_data_url(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("a logo must be SVG, PNG, JPEG or WebP".into()),
    };
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("a logo must be at most 2 MB".into());
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64(&bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The webview's answer to one board API request.
#[tauri::command]
fn board_api_reply(state: State<Arc<BoardApi>>, id: u64, reply: serde_json::Value) {
    state.reply(id, reply)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dir = default_sidecar_dir();
    let sidecar = AiSidecar(Sidecar {
        child: Mutex::new(None),
        port: port(),
        model: model(),
        dir: Mutex::new(dir.clone()),
        script: "serve.ps1",
        log: "server.log",
        env_port: "LUCIDA_AI_PORT",
        env_model: "LUCIDA_AI_MODEL",
    });
    let listen = ListenSidecar(Sidecar {
        child: Mutex::new(None),
        port: listen_port(),
        model: listen_model(),
        dir: Mutex::new(dir),
        script: "listen.ps1",
        log: "listen.log",
        env_port: "LUCIDA_LISTEN_PORT",
        env_model: "LUCIDA_LISTEN_MODEL",
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar)
        .manage(listen)
        .manage(BoardApi::new())
        .setup(|app| {
            // The local model is an experiment now; it starts when the webview
            // asks for it (ai_start), not on every launch.
            app.state::<Arc<BoardApi>>().start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_start,
            ai_stop,
            ai_status,
            listen_start,
            listen_stop,
            listen_status,
            launch_project,
            project_open,
            board_save,
            board_api_reply,
            wiki_stamp,
            wiki_read,
            plan_stamp,
            plan_read,
            plan_write,
            secret_get,
            secret_set,
            settings_read,
            settings_write,
            image_data_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(s) = app_handle.try_state::<AiSidecar>() {
                    s.0.stop();
                }
                if let Some(s) = app_handle.try_state::<ListenSidecar>() {
                    s.0.stop();
                }
            }
        });
}
