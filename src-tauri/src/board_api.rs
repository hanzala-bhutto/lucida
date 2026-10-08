//! The board API — how an agent reaches the board.
//!
//! A small HTTP server on 127.0.0.1:8767 (LUCIDA_BOARD_PORT overrides it). It
//! owns no board state: every request is handed to the webview as a
//! `board-api` event, and the webview answers through `board_api_reply`. The
//! board lives in exactly one place, so an agent can never see a different
//! board from the one on screen.
//!
//! Two locks on the door, because "localhost" is not "only me":
//!  - a bearer token, new on every launch, written to
//!    `%APPDATA%\Lucida\board-api.json`, which only this user can read;
//!  - any request carrying an `Origin` header is refused, so a web page in a
//!    browser cannot drive the board even if it guessed the port.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Largest request body accepted — a reference image, not a video.
const MAX_BODY: usize = 24 * 1024 * 1024;

pub fn port() -> u16 {
    std::env::var("LUCIDA_BOARD_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8767)
}

/// How long the webview may take to answer. Pictures are generated inside the
/// request, and one takes ~17 s at the median, so those calls get minutes.
fn timeout_for(method: &str) -> Duration {
    match method {
        "render_masterplan" | "add_image" => Duration::from_secs(300),
        "export_png" | "open_folder" | "company_map" | "plan_board" => Duration::from_secs(60),
        _ => Duration::from_secs(20),
    }
}

pub struct BoardApi {
    pending: Mutex<HashMap<u64, Sender<serde_json::Value>>>,
    next: AtomicU64,
    token: String,
    port: u16,
}

impl BoardApi {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            token: random_token(),
            port: port(),
        })
    }

    /// Hand a webview answer to the request waiting for it.
    pub fn reply(&self, id: u64, value: serde_json::Value) {
        if let Ok(mut p) = self.pending.lock() {
            if let Some(tx) = p.remove(&id) {
                let _ = tx.send(value);
            }
        }
    }

    /// Bind, write the token file, and serve on a background thread. A port
    /// that is taken (a second Lucida window) just means no agent API here.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let listener = match TcpListener::bind(("127.0.0.1", self.port)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("lucida: board API not started on :{} — {e}", self.port);
                return;
            }
        };
        if let Err(e) = write_token_file(self.port, &self.token) {
            eprintln!("lucida: could not write the board API token — {e}");
        }
        let api = Arc::clone(self);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let api = Arc::clone(&api);
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = api.handle(stream, &app);
                });
            }
        });
    }

    fn handle(&self, mut stream: TcpStream, app: &AppHandle) -> std::io::Result<()> {
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        let req = match read_request(&stream) {
            Ok(r) => r,
            Err(msg) => return respond(&mut stream, 400, &err_body(&msg)),
        };

        if req.headers.contains_key("origin") {
            return respond(
                &mut stream,
                403,
                &err_body("browser requests are not accepted"),
            );
        }
        if req.method == "GET" && req.path == "/health" {
            let body = serde_json::json!({ "ok": true, "app": "lucida", "version": env!("CARGO_PKG_VERSION") });
            return respond(&mut stream, 200, &body.to_string());
        }
        let expected = format!("Bearer {}", self.token);
        if req.headers.get("authorization").map(String::as_str) != Some(expected.as_str()) {
            return respond(&mut stream, 401, &err_body("missing or wrong token"));
        }
        if req.method != "POST" || req.path != "/rpc" {
            return respond(&mut stream, 404, &err_body("POST /rpc is the only route"));
        }

        let call: serde_json::Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(e) => {
                return respond(
                    &mut stream,
                    400,
                    &err_body(&format!("body is not JSON: {e}")),
                )
            }
        };
        let method = call
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        if method.is_empty() {
            return respond(&mut stream, 400, &err_body("missing \"method\""));
        }
        let params = call.get("params").cloned().unwrap_or(serde_json::json!({}));

        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        let event = serde_json::json!({ "id": id, "method": method, "params": params });
        if let Err(e) = app.emit("board-api", event) {
            self.forget(id);
            return respond(
                &mut stream,
                503,
                &err_body(&format!("board not reachable: {e}")),
            );
        }
        match rx.recv_timeout(timeout_for(&method)) {
            Ok(value) => respond(&mut stream, 200, &value.to_string()),
            Err(_) => {
                self.forget(id);
                respond(
                    &mut stream,
                    504,
                    &err_body("the board did not answer in time — is a Lucida window open?"),
                )
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
    }
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Result<Request, String> {
    let mut reader = BufReader::new(stream);
    let mut first = String::new();
    reader.read_line(&mut first).map_err(|e| e.to_string())?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if headers.len() > 64 {
            return Err("too many headers".into());
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return Err("body too large".into());
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        503 => "Service Unavailable",
        _ => "Gateway Timeout",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn err_body(msg: &str) -> String {
    serde_json::json!({ "ok": false, "error": msg }).to_string()
}

/// 24 bytes from the OS's CSPRNG (BCryptGenRandom). There is no weaker
/// fallback: without randomness the API must not start.
fn random_token() -> String {
    let mut buf = [0u8; 24];
    getrandom::fill(&mut buf).expect("no OS randomness for the board API token");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// `%APPDATA%\Lucida\board-api.json` — where the MCP server finds the port
/// and the token.
pub fn token_file() -> PathBuf {
    crate::support_dir().join("board-api.json")
}

fn write_token_file(port: u16, token: &str) -> std::io::Result<()> {
    let path = token_file();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let body = serde_json::json!({ "port": port, "token": token, "pid": std::process::id() });
    // %APPDATA% inherits the profile's ACL: only this user (and admins) can
    // read the token.
    fs::write(&path, body.to_string())
}
