//! Collaboration servers the desktop is signed in to. Device tokens stay in this process and in
//! a private file in the app's config directory; the web view only ever names a server, so a
//! script running in it cannot read a token.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[derive(Clone, Serialize, Deserialize)]
struct Account {
    server: String,
    token: String,
    user: Value,
}

#[derive(Clone, Serialize)]
pub struct AccountInfo {
    server: String,
    user: Value,
}

#[derive(Default)]
pub struct CollabState {
    accounts: tokio::sync::Mutex<Option<Vec<Account>>>,
    sockets: Mutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
    next: AtomicU64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SocketEvent {
    id: u64,
    kind: &'static str,
    data: Option<String>,
    code: Option<u16>,
    reason: Option<String>,
}

/// Errors reach the web view as JSON so it can tell "signed out" (401) from "offline" (0).
fn failure(status: u16, message: impl Into<String>) -> String {
    json!({ "status": status, "message": message.into() }).to_string()
}

fn private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host == "localhost" || host.ends_with(".local") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

/// `scheme://host[:port]`. Passwords and tokens cross the internet only over HTTPS; plain HTTP
/// is allowed on this machine and on private networks.
pub fn server_origin(input: &str) -> Result<String, String> {
    let url = url::Url::parse(input.trim()).map_err(|_| failure(0, "服务器地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(failure(
            0,
            "请输入以 http(s):// 开头、不含账号密码的服务器地址",
        ));
    }
    let host = url.host_str().ok_or_else(|| failure(0, "服务器地址无效"))?;
    if url.scheme() == "http" && !private_host(host) {
        return Err(failure(0, "公网上的协作服务器请使用 HTTPS 地址"));
    }
    Ok(url.origin().ascii_serialization())
}

async fn accounts_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    Ok(dir.join("collaboration-accounts.json"))
}

async fn accounts<'a>(
    app: &AppHandle,
    state: &'a CollabState,
) -> Result<tokio::sync::MutexGuard<'a, Option<Vec<Account>>>, String> {
    let mut guard = state.accounts.lock().await;
    if guard.is_none() {
        let saved = tokio::fs::read(accounts_file(app).await?).await.ok();
        *guard = Some(
            saved
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default(),
        );
    }
    Ok(guard)
}

/// Written through a 0600 temporary file, so the token file is private to this user.
async fn persist(app: &AppHandle, list: &[Account]) -> Result<(), String> {
    let json = serde_json::to_vec(list).map_err(|e| e.to_string())?;
    super::saving::atomic_write(&accounts_file(app).await?, &json).await
}

async fn token_for(app: &AppHandle, state: &CollabState, server: &str) -> Result<String, String> {
    let guard = accounts(app, state).await?;
    guard
        .iter()
        .flatten()
        .find(|a| a.server == server)
        .map(|a| a.token.clone())
        .ok_or_else(|| failure(401, "尚未登录这个协作服务器"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| failure(0, e.to_string()))
}

async fn send(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|e| failure(0, format!("无法连接协作服务器：{e}")))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| status.to_string());
        return Err(failure(status.as_u16(), message));
    }
    Ok(body)
}

#[tauri::command]
pub async fn collab_sign_in(
    app: AppHandle,
    state: State<'_, CollabState>,
    server: String,
    username: String,
    password: String,
    device: String,
) -> Result<AccountInfo, String> {
    let server = server_origin(&server)?;
    let issued = send(
        client()?
            .post(format!("{server}/api/tokens"))
            .json(&json!({ "username": username, "password": password, "name": device })),
    )
    .await?;
    let token = issued["token"]
        .as_str()
        .filter(|t| t.len() == 64)
        .ok_or_else(|| failure(0, "服务器返回了无效的登录凭据"))?
        .to_string();
    let user = issued["user"].clone();
    let mut guard = accounts(&app, &state).await?;
    let list = guard.get_or_insert_with(Vec::new);
    list.retain(|a| a.server != server);
    list.push(Account {
        server: server.clone(),
        token,
        user: user.clone(),
    });
    persist(&app, list).await?;
    Ok(AccountInfo { server, user })
}

#[tauri::command]
pub async fn collab_sign_out(
    app: AppHandle,
    state: State<'_, CollabState>,
    server: String,
) -> Result<(), String> {
    let mut guard = accounts(&app, &state).await?;
    let list = guard.get_or_insert_with(Vec::new);
    if let Some(account) = list.iter().find(|a| a.server == server) {
        // Revoke it on the server too; offline, it simply expires there.
        if let Ok(client) = client() {
            let _ = send(
                client
                    .delete(format!("{server}/api/tokens/current"))
                    .bearer_auth(&account.token),
            )
            .await;
        }
    }
    list.retain(|a| a.server != server);
    persist(&app, list).await
}

#[tauri::command]
pub async fn collab_accounts(
    app: AppHandle,
    state: State<'_, CollabState>,
) -> Result<Vec<AccountInfo>, String> {
    let guard = accounts(&app, &state).await?;
    Ok(guard
        .iter()
        .flatten()
        .map(|a| AccountInfo {
            server: a.server.clone(),
            user: a.user.clone(),
        })
        .collect())
}

/// A JSON API call on behalf of the signed-in account; a rejected token is forgotten.
#[tauri::command]
pub async fn collab_request(
    app: AppHandle,
    state: State<'_, CollabState>,
    server: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !path.starts_with("/api/") || path.contains("..") {
        return Err(failure(400, "无效的请求路径"));
    }
    let token = token_for(&app, &state, &server).await?;
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| failure(400, "无效的请求方法"))?;
    let mut request = client()?
        .request(method, format!("{server}{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let result = send(request).await;
    if let Err(error) = &result {
        if error.contains("\"status\":401") {
            let mut guard = accounts(&app, &state).await?;
            let list = guard.get_or_insert_with(Vec::new);
            list.retain(|a| a.server != server);
            persist(&app, list).await?;
        }
    }
    result
}

/// Runs one WebSocket until either side closes; `report` sees every message and one close.
pub async fn run_socket(
    id: u64,
    url: String,
    token: String,
    mut outgoing: mpsc::UnboundedReceiver<Message>,
    report: impl Fn(SocketEvent),
) {
    let event = |kind, data, code, reason| SocketEvent {
        id,
        kind,
        data,
        code,
        reason,
    };
    let mut request = match url.into_client_request() {
        Ok(request) => request,
        Err(e) => return report(event("close", None, Some(1006), Some(e.to_string()))),
    };
    if let Ok(value) = format!("Bearer {token}").parse() {
        request.headers_mut().insert("Authorization", value);
    }
    let (stream, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(e) => return report(event("close", None, Some(1006), Some(e.to_string()))),
    };
    let (mut write, mut read) = stream.split();
    let (code, reason) = loop {
        tokio::select! {
            message = outgoing.recv() => match message {
                Some(message) => {
                    if let Err(e) = write.send(message).await {
                        break (1006, e.to_string());
                    }
                }
                None => {
                    let _ = write.send(Message::Close(None)).await;
                    break (1000, String::new());
                }
            },
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    report(event("message", Some(text.to_string()), None, None));
                }
                Some(Ok(Message::Close(frame))) => {
                    break frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1005, String::new()));
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => break (1006, e.to_string()),
                None => break (1006, String::new()),
            },
        }
    };
    report(event("close", None, Some(code), Some(reason)));
}

/// Opens the project socket; messages and the close arrive as `collab-socket` events.
#[tauri::command]
pub async fn collab_connect(
    app: AppHandle,
    state: State<'_, CollabState>,
    server: String,
    path: String,
) -> Result<u64, String> {
    if !path.starts_with("/api/projects/") || !path.contains("/socket") || path.contains("..") {
        return Err(failure(400, "无效的连接路径"));
    }
    let token = token_for(&app, &state, &server).await?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = mpsc::unbounded_channel();
    state
        .sockets
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, sender);
    let url = format!(
        "{}{}",
        server
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1),
        path
    );
    tauri::async_runtime::spawn(async move {
        let emitter = app.clone();
        run_socket(id, url, token, receiver, move |event| {
            let _ = emitter.emit("collab-socket", event);
        })
        .await;
        if let Ok(mut sockets) = app.state::<CollabState>().sockets.lock() {
            sockets.remove(&id);
        }
    });
    Ok(id)
}

#[tauri::command]
pub fn collab_send(state: State<'_, CollabState>, id: u64, data: String) -> Result<(), String> {
    let sockets = state.sockets.lock().map_err(|e| e.to_string())?;
    sockets
        .get(&id)
        .ok_or("连接已关闭")?
        .send(Message::text(data))
        .map_err(|_| "连接已关闭".to_string())
}

#[tauri::command]
pub fn collab_close(state: State<'_, CollabState>, id: u64) -> Result<(), String> {
    // Dropping the sender ends the socket's loop, which closes it politely.
    state.sockets.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn accepts_https_anywhere_and_http_only_nearby() {
        assert_eq!(
            server_origin(" https://writer.example.com/app?x=1 ").unwrap(),
            "https://writer.example.com"
        );
        for nearby in [
            "http://127.0.0.1:8787",
            "http://192.168.1.20:8787",
            "http://lab-pc.local",
            "http://[::1]:8787",
        ] {
            assert!(server_origin(nearby).is_ok(), "{nearby}");
        }
        for refused in [
            "http://writer.example.com",
            "http://8.8.8.8",
            "ftp://x",
            "https://u:p@x.com",
            "x",
        ] {
            assert!(server_origin(refused).is_err(), "{refused}");
        }
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // The handshake callback's error type is tungstenite's.
    async fn relays_messages_with_the_token_and_reports_one_close() {
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
        use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut authorization = String::new();
            let mut ws =
                tokio_tungstenite::accept_hdr_async(tcp, |req: &Request, res: Response| {
                    authorization = req
                        .headers()
                        .get("Authorization")
                        .map(|v| v.to_str().unwrap().to_string())
                        .unwrap_or_default();
                    Ok(res)
                })
                .await
                .unwrap();
            ws.send(Message::text(format!("auth:{authorization}")))
                .await
                .unwrap();
            let echo = ws.next().await.unwrap().unwrap();
            ws.send(echo).await.unwrap();
            ws.close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: "revoked".into(),
            }))
            .await
            .unwrap();
        });
        let events = Arc::new(Mutex::new(vec![]));
        let (sender, receiver) = mpsc::unbounded_channel();
        sender.send(Message::text("hello")).unwrap();
        let seen = events.clone();
        run_socket(
            7,
            format!("ws://{address}/"),
            "t0k".into(),
            receiver,
            move |e| seen.lock().unwrap().push(e),
        )
        .await;
        let events = events.lock().unwrap();
        let texts: Vec<_> = events.iter().filter_map(|e| e.data.clone()).collect();
        assert_eq!(texts, ["auth:Bearer t0k", "hello"]);
        assert_eq!(events.iter().filter(|e| e.kind == "close").count(), 1);
        let close = events.last().unwrap();
        assert_eq!(
            (close.code, close.reason.as_deref()),
            (Some(1008), Some("revoked"))
        );
    }
}
