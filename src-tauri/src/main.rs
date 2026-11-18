#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::TcpListener as StdTcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, watch, Mutex, RwLock};

const RENDERER_BRIDGE_PORT: u16 = 37121;
const RENDERER_DOCUMENT_LIMIT: usize = 64 * 1024 * 1024;
const RENDERER_ASSET_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Clone)]
struct BridgeAsset {
    content_type: String,
    bytes: Vec<u8>,
}

#[derive(Clone)]
struct BridgeDocument {
    target_origin: String,
    html: Vec<u8>,
    assets: HashMap<String, BridgeAsset>,
}

#[derive(Clone)]
struct SocketControl {
    tx: mpsc::Sender<Vec<u8>>,
    cancel: watch::Sender<bool>,
}

struct AppState {
    tcp_sockets: Arc<Mutex<HashMap<u32, SocketControl>>>,
    udp_sockets: Arc<Mutex<HashMap<u32, SocketControl>>>,
    renderer_documents: Arc<RwLock<HashMap<String, BridgeDocument>>>,
}

fn stable_origin_label(origin: &str) -> String {
    // Deterministic origin partition label, not a security primitive. The
    // unguessable document token authorizes access to registered bytes.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in origin.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("o-{hash:016x}")
}

fn bridge_key(label: &str, token: &str) -> String {
    format!("{label}/{token}")
}

fn valid_bridge_component(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn response_bytes(
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
    head_only: bool,
) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nCross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n",
        body.len()
    )
    .into_bytes();
    for (name, value) in extra_headers {
        response.extend_from_slice(name.as_bytes());
        response.extend_from_slice(b": ");
        response.extend_from_slice(value.as_bytes());
        response.extend_from_slice(b"\r\n");
    }
    response.extend_from_slice(b"\r\n");
    if !head_only {
        response.extend_from_slice(body);
    }
    response
}

async fn handle_renderer_bridge_connection(
    mut stream: TcpStream,
    documents: Arc<RwLock<HashMap<String, BridgeDocument>>>,
) {
    let mut request = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    while request.len() < 64 * 1024 {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                request.extend_from_slice(&chunk[..n]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
        }
    }

    let header = String::from_utf8_lossy(&request);
    let mut lines = header.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let path = request_line.next().unwrap_or_default();
    let host = lines
        .find_map(|line| {
            line.strip_prefix("Host:")
                .or_else(|| line.strip_prefix("host:"))
                .map(str::trim)
        })
        .unwrap_or_default();
    let label = host
        .split(':')
        .next()
        .unwrap_or_default()
        .strip_suffix(".localhost")
        .unwrap_or_default();
    let segments: Vec<&str> = path.split('?').next().unwrap_or(path).split('/').collect();

    let fallback = || {
        response_bytes(
            "421 Misdirected Request",
            "text/plain; charset=utf-8",
            b"WASM transport ownership required",
            &[("X-WASMOS-Network-Owner", "wasm")],
            method == "HEAD",
        )
    };

    let response = if method == "OPTIONS" {
        response_bytes(
            "204 No Content",
            "text/plain; charset=utf-8",
            &[],
            &[("Allow", "GET, HEAD, OPTIONS")],
            true,
        )
    } else if !matches!(method, "GET" | "HEAD")
        || !valid_bridge_component(label, 32)
        || segments.len() < 5
        || segments[1] != "__wasmos__"
    {
        fallback()
    } else {
        let token = segments[2];
        let kind = segments[3];
        let name = segments[4];
        let key = bridge_key(label, token);
        let records = documents.read().await;
        if let Some(document) = records.get(&key) {
            if kind == "document" && name == "index.html" {
                response_bytes(
                    "200 OK",
                    "text/html; charset=utf-8",
                    &document.html,
                    &[
                        ("Content-Security-Policy", "default-src 'none'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; connect-src 'self'; worker-src 'self' blob:; child-src 'self' blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:"),
                        ("X-WASMOS-Target-Origin", &document.target_origin),
                    ],
                    method == "HEAD",
                )
            } else if kind == "asset" {
                if let Some(asset) = document.assets.get(name) {
                    response_bytes(
                        "200 OK",
                        &asset.content_type,
                        &asset.bytes,
                        &[
                            ("Content-Security-Policy", "default-src 'none'; connect-src 'self'; script-src 'self' blob:; worker-src 'self' blob:"),
                            ("Service-Worker-Allowed", "/"),
                        ],
                        method == "HEAD",
                    )
                } else {
                    fallback()
                }
            } else {
                fallback()
            }
        } else {
            fallback()
        }
    };

    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

fn start_renderer_origin_bridge(
    documents: Arc<RwLock<HashMap<String, BridgeDocument>>>,
) -> Result<(), String> {
    let listener = StdTcpListener::bind(("127.0.0.1", RENDERER_BRIDGE_PORT))
        .map_err(|e| format!("renderer origin bridge bind failed: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("renderer origin bridge nonblocking failed: {e}"))?;
    tauri::async_runtime::spawn(async move {
        // Register with the Tokio reactor on its runtime, not on the GUI thread.
        let listener = match TcpListener::from_std(listener) {
            Ok(value) => value,
            Err(err) => { eprintln!("renderer bridge unavailable: {err}"); return; }
        };
        while let Ok((stream, _)) = listener.accept().await {
            let records = Arc::clone(&documents);
            tokio::spawn(handle_renderer_bridge_connection(stream, records));
        }
    });
    Ok(())
}

#[tauri::command]
async fn renderer_origin_publish(
    state: State<'_, AppState>,
    target_origin: String,
    token: String,
    html: Vec<u8>,
) -> Result<String, String> {
    if !(target_origin.starts_with("https://") || target_origin.starts_with("http://")) {
        return Err("renderer target origin must be HTTP(S)".to_string());
    }
    if !valid_bridge_component(&token, 160) || html.len() > RENDERER_DOCUMENT_LIMIT {
        return Err("invalid renderer token or oversized document".to_string());
    }
    let label = stable_origin_label(&target_origin);
    let key = bridge_key(&label, &token);
    state.renderer_documents.write().await.insert(
        key,
        BridgeDocument {
            target_origin,
            html,
            assets: HashMap::new(),
        },
    );
    Ok(format!(
        "http://{label}.localhost:{RENDERER_BRIDGE_PORT}/__wasmos__/{token}/document/index.html"
    ))
}

#[tauri::command]
async fn renderer_origin_publish_asset(
    state: State<'_, AppState>,
    target_origin: String,
    token: String,
    asset_key: String,
    content_type: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if !valid_bridge_component(&token, 160)
        || !valid_bridge_component(&asset_key, 160)
        || bytes.len() > RENDERER_ASSET_LIMIT
        || content_type.contains('\r')
        || content_type.contains('\n')
    {
        return Err("invalid or oversized renderer asset".to_string());
    }
    let label = stable_origin_label(&target_origin);
    let key = bridge_key(&label, &token);
    let mut records = state.renderer_documents.write().await;
    let document = records
        .get_mut(&key)
        .ok_or_else(|| "renderer document is not published".to_string())?;
    document.assets.insert(
        asset_key.clone(),
        BridgeAsset {
            content_type,
            bytes,
        },
    );
    Ok(format!(
        "http://{label}.localhost:{RENDERER_BRIDGE_PORT}/__wasmos__/{token}/asset/{asset_key}"
    ))
}

#[tauri::command]
async fn renderer_origin_remove(
    state: State<'_, AppState>,
    target_origin: String,
    token: String,
) -> Result<(), String> {
    let label = stable_origin_label(&target_origin);
    state
        .renderer_documents
        .write()
        .await
        .remove(&bridge_key(&label, &token));
    Ok(())
}

fn emit_socket_closed(app: &AppHandle, protocol: &str, socket_id: u32, closed: &AtomicBool) {
    if !closed.swap(true, Ordering::AcqRel) {
        let _ = app.emit(&format!("{}-closed-{}", protocol, socket_id), ());
    }
}

#[tauri::command]
async fn tcp_open(
    app: AppHandle,
    state: State<'_, AppState>,
    socket_id: u32,
    host: String,
    port: u16,
    _keep_alive: bool,
    no_delay: bool,
) -> Result<(), String> {
    let addr = format!("{}:{}", host, port);
    let stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("Connection error to {}: {}", addr, e))?;

    if no_delay {
        let _ = stream.set_nodelay(true);
    }

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    let (cancel, mut read_cancel) = watch::channel(false);
    let mut write_cancel = cancel.subscribe();

    {
        let mut map = state.tcp_sockets.lock().await;
        if map.contains_key(&socket_id) {
            return Err(format!("Socket {} already exists", socket_id));
        }
        map.insert(socket_id, SocketControl { tx, cancel });
    }

    let app_clone = app.clone();
    let read_sockets = Arc::clone(&state.tcp_sockets);
    let closed = Arc::new(AtomicBool::new(false));
    let read_closed = Arc::clone(&closed);
    tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        loop {
            tokio::select! {
                _ = read_cancel.changed() => break,
                result = reader.read(&mut buf) => match result {
                    Ok(0) => break,
                    Ok(n) => {
                        // Bytes remain opaque to the host. The WASM application
                        // owns TLS records, HTTP framing and all document parsing.
                        if app_clone.emit(&format!("tcp-data-{}", socket_id), &buf[..n]).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = app_clone.emit(&format!("tcp-error-{}", socket_id), e.to_string());
                        break;
                    }
                }
            }
        }
        read_sockets.lock().await.remove(&socket_id);
        emit_socket_closed(&app_clone, "tcp", socket_id, &read_closed);
    });

    let app_clone = app.clone();
    let write_sockets = Arc::clone(&state.tcp_sockets);
    let write_closed = Arc::clone(&closed);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = write_cancel.changed() => break,
                data = rx.recv() => match data {
                    Some(data) => {
                        if let Err(e) = writer.write_all(&data).await {
                            let _ = app_clone.emit(&format!("tcp-error-{}", socket_id), e.to_string());
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
        let _ = writer.shutdown().await;
        write_sockets.lock().await.remove(&socket_id);
        emit_socket_closed(&app_clone, "tcp", socket_id, &write_closed);
    });

    Ok(())
}

#[tauri::command]
async fn tcp_write(
    state: State<'_, AppState>,
    socket_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let tx = {
        let map = state.tcp_sockets.lock().await;
        map.get(&socket_id).cloned()
    };

    if let Some(control) = tx {
        control.tx
            .send(data)
            .await
            .map_err(|e| format!("Socket {} send error: {}", socket_id, e))?;
        Ok(())
    } else {
        Err(format!("Socket {} not found", socket_id))
    }
}

#[tauri::command]
async fn tcp_close(state: State<'_, AppState>, socket_id: u32) -> Result<(), String> {
    let control = state.tcp_sockets.lock().await.remove(&socket_id);
    if let Some(control) = control {
        let _ = control.cancel.send(true);
    }
    Ok(())
}

#[tauri::command]
async fn udp_open(
    app: AppHandle,
    state: State<'_, AppState>,
    socket_id: u32,
    host: String,
    port: u16,
) -> Result<(), String> {
    let remote_addr = format!("{}:{}", host, port);
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("UDP bind error: {}", e))?;

    socket
        .connect(&remote_addr)
        .await
        .map_err(|e| format!("UDP connect error to {}: {}", remote_addr, e))?;

    let socket = Arc::new(socket);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    let (cancel, mut read_cancel) = watch::channel(false);
    let mut write_cancel = cancel.subscribe();

    {
        let mut map = state.udp_sockets.lock().await;
        if map.contains_key(&socket_id) {
            return Err(format!("UDP socket {} already exists", socket_id));
        }
        map.insert(socket_id, SocketControl { tx, cancel });
    }

    let app_clone = app.clone();
    let socket_recv = Arc::clone(&socket);
    let read_sockets = Arc::clone(&state.udp_sockets);
    let closed = Arc::new(AtomicBool::new(false));
    let read_closed = Arc::clone(&closed);
    tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        loop {
            tokio::select! {
                _ = read_cancel.changed() => break,
                result = socket_recv.recv(&mut buf) => match result {
                    Ok(n) => {
                        if app_clone.emit(&format!("udp-data-{}", socket_id), &buf[..n]).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = app_clone.emit(&format!("udp-error-{}", socket_id), e.to_string());
                        break;
                    }
                }
            }
        }
        read_sockets.lock().await.remove(&socket_id);
        emit_socket_closed(&app_clone, "udp", socket_id, &read_closed);
    });

    let app_clone = app.clone();
    let socket_send = Arc::clone(&socket);
    let write_sockets = Arc::clone(&state.udp_sockets);
    let write_closed = Arc::clone(&closed);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = write_cancel.changed() => break,
                data = rx.recv() => match data {
                    Some(data) => {
                        if let Err(e) = socket_send.send(&data).await {
                            let _ = app_clone.emit(&format!("udp-error-{}", socket_id), e.to_string());
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
        write_sockets.lock().await.remove(&socket_id);
        emit_socket_closed(&app_clone, "udp", socket_id, &write_closed);
    });

    Ok(())
}

#[tauri::command]
async fn udp_send(
    state: State<'_, AppState>,
    socket_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let tx = {
        let map = state.udp_sockets.lock().await;
        map.get(&socket_id).cloned()
    };

    if let Some(control) = tx {
        control.tx
            .send(data)
            .await
            .map_err(|e| format!("UDP send error: {}", e))?;
        Ok(())
    } else {
        Err(format!("UDP Socket {} not found", socket_id))
    }
}

#[tauri::command]
async fn udp_close(state: State<'_, AppState>, socket_id: u32) -> Result<(), String> {
    let control = state.udp_sockets.lock().await.remove(&socket_id);
    if let Some(control) = control {
        let _ = control.cancel.send(true);
    }
    Ok(())
}

#[tauri::command]
fn open_devtools(app: AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "Main webview is unavailable".to_string())?;
    webview.open_devtools();
    Ok(())
}

fn main() {
    let renderer_documents = Arc::new(RwLock::new(HashMap::new()));
    tauri::Builder::default()
        .manage(AppState {
            tcp_sockets: Arc::new(Mutex::new(HashMap::new())),
            udp_sockets: Arc::new(Mutex::new(HashMap::new())),
            renderer_documents: Arc::clone(&renderer_documents),
        })
        .setup(move |_app| {
            start_renderer_origin_bridge(Arc::clone(&renderer_documents)).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::Other, error)
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tcp_open, tcp_write, tcp_close,
            udp_open, udp_send, udp_close,
            open_devtools,
            renderer_origin_publish,
            renderer_origin_publish_asset,
            renderer_origin_remove
        ])
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}
