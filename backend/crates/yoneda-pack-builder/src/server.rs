//! The routes its Worker calls, one at a time (builds run in order; /health answers always):
//!
//! - `GET /health`: up (start-up waits for the port).
//! - `POST /fetch` (wanted ids, one per line): takes their history (git.rs `fetch`); answers
//!   `{"mirror":bool,"from_platform":n,"objects":n,"ms":..,"cpu_ms":..,"peak_mib":..}`.
//! - `POST /pack?filter=blob:none&depth=1` (wanted ids): streams that pack, chunked.
//! - `GET /stats`: the last pack's `{"ok":bool,"bytes":n,"ms":..,"cpu_ms":..,"peak_mib":..}`
//!   (or its error), asked once the pack has streamed.
//!
//! Every route but /health takes `Authorization: Bearer <PACK_TOKEN>`, the secret its Worker
//! started this container with. Nothing here holds a credential for anything else: the
//! mirror and the platform are reached through the Worker, which adds its own.
use crate::git::{self, Builder, Shape, log, quote};
use crate::http::{Chunked, Request, read_request, respond};
use std::io::{BufReader, Write};
use std::net::TcpStream;
use std::sync::Mutex;

pub struct Server {
    token: String,
    builder: Mutex<Builder>,
    last: Mutex<Option<std::result::Result<git::Packed, String>>>,
}

const JSON: &str = "application/json";

impl Server {
    pub fn new(token: String, builder: Builder) -> Self {
        Self {
            token,
            builder: Mutex::new(builder),
            last: Mutex::new(None),
        }
    }

    /// Serves one connection.
    pub fn serve(&self, stream: TcpStream) {
        let mut out = match stream.try_clone() {
            Ok(out) => out,
            Err(_) => return,
        };
        let request = match read_request(&mut BufReader::new(stream)) {
            Ok(request) => request,
            Err(e) => return error(&mut out, 400, &e.to_string()),
        };
        if request.method == "GET" && request.path == "/health" {
            let _ = respond(&mut out, 200, "text/plain", b"ok\n");
            return;
        }
        if !self.authorized(&request) {
            return error(&mut out, 401, "a bearer token is required");
        }
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/fetch") => self.fetch(&request, &mut out),
            ("POST", "/pack") => self.pack(&request, out),
            ("GET", "/stats") => self.stats(&mut out),
            _ => error(&mut out, 404, "no such route"),
        }
    }

    fn authorized(&self, request: &Request) -> bool {
        let Some(given) = request
            .authorization
            .as_deref()
            .and_then(|a| a.strip_prefix("Bearer "))
        else {
            return false;
        };
        // Compared whole, so the time taken says nothing about a prefix.
        given.len() == self.token.len()
            && given
                .bytes()
                .zip(self.token.bytes())
                .fold(0, |d, (a, b)| d | (a ^ b))
                == 0
    }

    fn fetch(&self, request: &Request, out: &mut TcpStream) {
        let wants = match git::ids(&request.body) {
            Ok(wants) => wants,
            Err(e) => return error(out, 400, &e),
        };
        let fetched = self
            .builder
            .lock()
            .map_err(|_| "busy".to_owned())
            .and_then(|b| b.fetch(&wants));
        match fetched {
            Ok(f) => {
                let body = format!(
                    r#"{{"mirror":{},"from_platform":{},"objects":{},{}}}"#,
                    f.mirror,
                    f.from_platform,
                    f.objects,
                    f.cost.json()
                );
                log("pack.fetched", &body[1..body.len() - 1]);
                let _ = respond(out, 200, JSON, body.as_bytes());
            }
            Err(e) => {
                log("pack.fetch_failed", &format!(r#""error":{}"#, quote(&e)));
                error(out, 500, &e)
            }
        }
    }

    fn pack(&self, request: &Request, mut out: TcpStream) {
        let (wants, shape) = match (git::ids(&request.body), Shape::parse(&request.query)) {
            (Ok(wants), Ok(shape)) => (wants, shape),
            (Err(e), _) | (_, Err(e)) => return error(&mut out, 400, &e),
        };
        let Ok(builder) = self.builder.lock() else {
            return error(&mut out, 409, "busy");
        };
        let packed = match Chunked::start(&mut out, "application/x-git-packfile") {
            Ok(mut chunked) => builder.pack(&wants, &shape, &mut chunked).and_then(|p| {
                chunked
                    .finish()
                    .map_err(|e| format!("pack not sent: {e}"))?;
                Ok(p)
            }),
            Err(e) => Err(format!("pack not sent: {e}")),
        };
        match &packed {
            Ok(p) => log(
                "pack.built",
                &format!(r#""bytes":{},{}"#, p.bytes, p.cost.json()),
            ),
            Err(e) => log("pack.failed", &format!(r#""error":{}"#, quote(e))),
        }
        if let Ok(mut last) = self.last.lock() {
            *last = Some(packed);
        }
    }

    fn stats(&self, out: &mut TcpStream) {
        let body = match self.last.lock().ok().and_then(|l| l.clone()) {
            Some(Ok(p)) => format!(r#"{{"ok":true,"bytes":{},{}}}"#, p.bytes, p.cost.json()),
            Some(Err(e)) => format!(r#"{{"ok":false,"error":{}}}"#, quote(&e)),
            None => r#"{"ok":false,"error":"no pack yet"}"#.to_owned(),
        };
        let _ = respond(out, 200, JSON, body.as_bytes());
    }
}

fn error(out: &mut impl Write, status: u16, message: &str) {
    let body = format!(r#"{{"error":{}}}"#, quote(message));
    let _ = respond(out, status, JSON, body.as_bytes());
}
