//! Local real HTTP protocol fixture; not a Cloudflare or hosted acceptance claim.
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
#[derive(Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Response {
    pub fn json(value: Value) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: serde_json::to_vec(&value).unwrap(),
        }
    }
    pub fn raw(value: Value, bytes: &[u8]) -> Self {
        let meta = serde_json::to_string(&value)
            .unwrap()
            .bytes()
            .map(|b| format!("%{b:02X}"))
            .collect::<String>();
        Self {
            status: 200,
            headers: vec![
                ("Content-Type".into(), "application/octet-stream".into()),
                ("x-yoneda-source".into(), meta),
            ],
            body: bytes.into(),
        }
    }
}
pub struct Server {
    pub origin: String,
    pub requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    pub fn new(responses: Vec<Response>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let observed = requests.clone();
        let cancelled = stop.clone();
        let mut responses = responses.into_iter();
        let thread = thread::spawn(move || {
            while !cancelled.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        socket
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let request = read(&mut socket);
                        observed.lock().unwrap().push(request);
                        let response = responses.next().unwrap_or_else(|| {
                            Response::json(json!({"error":{"code":"FIXTURE_EXHAUSTED"}}))
                        });
                        let mut header = format!(
                            "HTTP/1.1 {} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n",
                            response.status,
                            response.body.len()
                        );
                        for (key, value) in response.headers {
                            header.push_str(&format!("{key}: {value}\r\n"));
                        }
                        header.push_str("\r\n");
                        socket.write_all(header.as_bytes()).unwrap();
                        socket.write_all(&response.body).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        Self {
            origin,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn read(socket: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut target = None;
    loop {
        let size = socket.read(&mut buffer).unwrap();
        if size == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..size]);
        if target.is_none()
            && let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n")
        {
            let header = String::from_utf8_lossy(&bytes[..index]);
            let size = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|n| n.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            target = Some(index + 4 + size);
        }
        if target.is_some_and(|target| bytes.len() >= target) {
            break;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}
pub fn status() -> Value {
    json!({"version":1,"capabilities":{"source_api":1},"transport":"api-source-v1","workspace_id":"ws","view_digest":"view","workspace_version":0,"status":"open","access":"read_write","authority":"staged_source","checked":false,"published":false})
}
pub fn file(version: u64) -> Value {
    json!({"path":"app.js","kind":"file","exists":true,"file_version":version,"mode":"100644","size":3})
}
pub fn read_meta() -> Value {
    json!({"version":1,"workspace_id":"ws","workspace_version":0,"file":file(0),"offset":0,"length":3})
}
