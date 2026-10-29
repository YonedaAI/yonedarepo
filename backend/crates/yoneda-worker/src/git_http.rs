//! Git over HTTPS sessions exported to the TypeScript adapter. A push or fetch spans many
//! calls (the body streams in, verification asks for repository objects, objects stream
//! out), so each keeps its state here under a handle. Sessions an adapter never closed
//! (a dropped connection) are evicted by age, and few large pushes run in one isolate.
use std::cell::RefCell;
use std::collections::HashMap;
use worker::wasm_bindgen::{JsError, prelude::wasm_bindgen};
use yoneda_platform::{
    platform_git_receive::ReceiveSession, platform_git_upload::UploadSession,
    platform_pack_stream::PackStream,
};

/// A session idle this long belongs to a request that is gone.
const STALE_MS: f64 = 10.0 * 60.0 * 1000.0;
/// Pushes hold their packs in this isolate's memory (128 MB in all): together at most this.
const RECEIVE_BYTES: usize = 80 * 1024 * 1024;
const RECEIVES: usize = 16;
const UPLOADS: usize = 8;
const STREAMS: usize = 4;

struct Sessions<T> {
    next: u32,
    open: HashMap<u32, (f64, T)>,
}

impl<T> Sessions<T> {
    fn new() -> Self {
        Self {
            next: 1,
            open: HashMap::new(),
        }
    }
    fn add(&mut self, now: f64, limit: usize, session: T) -> yoneda_core::Result<u32> {
        self.open.retain(|_, (used, _)| now - *used < STALE_MS);
        if self.open.len() >= limit {
            return Err(yoneda_core::Error::new(
                "RATE_LIMITED",
                "The server is busy with other Git transfers; retry shortly",
            ));
        }
        let handle = self.next;
        self.next = self.next.wrapping_add(1).max(1);
        self.open.insert(handle, (now, session));
        Ok(handle)
    }
    fn with<R>(
        &mut self,
        handle: u32,
        run: impl FnOnce(&mut T) -> yoneda_core::Result<R>,
    ) -> yoneda_core::Result<R> {
        let (_, session) = self
            .open
            .get_mut(&handle)
            .ok_or_else(|| yoneda_core::Error::new("GONE", "The Git session expired"))?;
        run(session)
    }
}

thread_local! {
    static RECEIVING: RefCell<Sessions<ReceiveSession>> = RefCell::new(Sessions::new());
    static UPLOADING: RefCell<Sessions<UploadSession>> = RefCell::new(Sessions::new());
    static STREAMING: RefCell<Sessions<PackStream>> = RefCell::new(Sessions::new());
}

fn answer(result: yoneda_core::Result<serde_json::Value>) -> String {
    match result {
        Ok(value) => serde_json::json!({ "value": value }),
        Err(e) => serde_json::json!({ "error": { "code": e.code, "message": e.message } }),
    }
    .to_string()
}

fn thrown(e: yoneda_core::Error) -> JsError {
    JsError::new(&serde_json::json!({ "code": e.code, "message": e.message }).to_string())
}

fn parse(input: &str) -> yoneda_core::Result<serde_json::Value> {
    serde_json::from_str(input)
        .map_err(|_| yoneda_core::Error::new("INVALID_INPUT", "Session input must be JSON"))
}

#[wasm_bindgen(js_name = gitReceiveOpen, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_receive_open(now: f64) -> String {
    answer(
        RECEIVING
            .with_borrow_mut(|s| s.add(now, RECEIVES, ReceiveSession::new()))
            .map(Into::into),
    )
}

#[wasm_bindgen(js_name = gitReceiveFeed, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_receive_feed(handle: u32, chunk: &[u8]) -> String {
    answer(RECEIVING.with_borrow_mut(|s| {
        let held: usize = s.open.values().map(|(_, r)| r.buffered()).sum();
        if held + chunk.len() > RECEIVE_BYTES {
            return Err(yoneda_core::Error::new(
                "RATE_LIMITED",
                "The server is busy with other large pushes; retry shortly",
            ));
        }
        s.with(handle, |r| r.feed(chunk))
            .map(|()| serde_json::Value::Null)
    }))
}

/// Spilled files' content since the last call (see `ReceiveSession::spilled`), led by one
/// byte: 1 when the pack waits for it to be taken (feed an empty chunk next), else 0.
#[wasm_bindgen(js_name = gitReceiveSpilled, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_receive_spilled(handle: u32) -> Result<Vec<u8>, JsError> {
    RECEIVING
        .with_borrow_mut(|s| {
            s.with(handle, |r| {
                // Asked before taking: taking the content is what resumes the walk.
                let mut out = vec![u8::from(r.paused())];
                out.extend_from_slice(&r.spilled());
                Ok(out)
            })
        })
        .map_err(thrown)
}

/// `{op: "finish" | "commands" | "verify", ...}` (see `ReceiveSession`).
#[wasm_bindgen(js_name = gitReceiveCall, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_receive_call(handle: u32, input: &str) -> String {
    answer(parse(input).and_then(|c| {
        RECEIVING.with_borrow_mut(|s| {
            s.with(handle, |r| match c["op"].as_str() {
                Some("finish") => r.finish(),
                Some("commands") => Ok(r.commands()),
                Some("verify") => r.verify(&c),
                Some("verified") => r.verified_page(
                    c["from"].as_u64().unwrap_or(0) as usize,
                    c["count"].as_u64().unwrap_or(0) as usize,
                ),
                _ => Err(yoneda_core::Error::new("UNKNOWN_OP", "Unknown receive op")),
            })
        })
    }))
}

#[wasm_bindgen(js_name = gitReceiveObjects, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_receive_objects(handle: u32, budget: u32) -> Result<Vec<u8>, JsError> {
    RECEIVING
        .with_borrow_mut(|s| s.with(handle, |r| r.next_objects(budget as usize)))
        .map_err(thrown)
}

#[wasm_bindgen(js_name = gitReceiveClose, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_receive_close(handle: u32) {
    RECEIVING.with_borrow_mut(|s| s.open.remove(&handle));
}

/// Opens a fetch over `repo_git_walk`'s answer.
#[wasm_bindgen(js_name = gitUploadOpen, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_open(now: f64, walk: &str) -> String {
    answer(
        parse(walk)
            .and_then(|w| UploadSession::new(&w))
            .and_then(|session| {
                UPLOADING
                    .with_borrow_mut(|s| s.add(now, UPLOADS, session))
                    .map(Into::into)
            }),
    )
}

#[wasm_bindgen(js_name = gitUploadStep, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_step(handle: u32, input: &str) -> String {
    answer(parse(input).and_then(|c| UPLOADING.with_borrow_mut(|s| s.with(handle, |u| u.step(&c)))))
}

/// Which of `ids` (a JSON list) the counted pack holds (`UploadSession::holds`).
#[wasm_bindgen(js_name = gitUploadHolds, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_holds(handle: u32, ids: &str) -> String {
    answer(
        parse(ids).and_then(|ids| UPLOADING.with_borrow_mut(|s| s.with(handle, |u| u.holds(&ids)))),
    )
}

/// The sending pass (`UploadSession::send`): the next wave's objects to write.
#[wasm_bindgen(js_name = gitUploadSend, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_send(handle: u32, input: &str) -> String {
    answer(parse(input).and_then(|c| UPLOADING.with_borrow_mut(|s| s.with(handle, |u| u.send(&c)))))
}

#[wasm_bindgen(js_name = gitUploadStart, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_start(handle: u32) -> Result<Vec<u8>, JsError> {
    UPLOADING
        .with_borrow_mut(|s| s.with(handle, |u| u.pack_start()))
        .map_err(thrown)
}

/// One entry: a tree the session read (`data` ignored), or a blob or commit's content.
#[wasm_bindgen(js_name = gitUploadEntry, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_entry(
    handle: u32,
    kind: &str,
    id: &str,
    data: &[u8],
) -> Result<Vec<u8>, JsError> {
    UPLOADING
        .with_borrow_mut(|s| {
            s.with(handle, |u| {
                // Trees and tag objects are held by the session.
                u.pack_entry(kind, id, (!matches!(kind, "tree" | "tag")).then_some(data))
            })
        })
        .map_err(thrown)
}

/// Starts a file the adapter streams (see `UploadSession::large_start`): its entry header.
#[wasm_bindgen(js_name = gitUploadLargeStart, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_large_start(handle: u32, id: &str, size: f64) -> Result<Vec<u8>, JsError> {
    UPLOADING
        .with_borrow_mut(|s| s.with(handle, |u| u.large_start(id, size as usize)))
        .map_err(thrown)
}

#[wasm_bindgen(js_name = gitUploadLargeData, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_large_data(handle: u32, content: &[u8], packed: &[u8]) -> Result<(), JsError> {
    UPLOADING
        .with_borrow_mut(|s| s.with(handle, |u| u.large_data(content, packed)))
        .map_err(thrown)
}

#[wasm_bindgen(js_name = gitUploadLargeEnd, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_large_end(handle: u32) -> Result<(), JsError> {
    UPLOADING
        .with_borrow_mut(|s| s.with(handle, |u| u.large_end()))
        .map_err(thrown)
}

/// The trailer; closes the session.
#[wasm_bindgen(js_name = gitUploadFinish, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_finish(handle: u32) -> Result<Vec<u8>, JsError> {
    let trailer = UPLOADING
        .with_borrow_mut(|s| s.with(handle, |u| u.pack_finish()))
        .map_err(thrown);
    git_upload_close(handle);
    trailer
}

#[wasm_bindgen(js_name = gitUploadClose, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_upload_close(handle: u32) {
    UPLOADING.with_borrow_mut(|s| s.open.remove(&handle));
}

/// This isolate's Wasm memory in bytes (it only grows): what tests bound for large files.
#[wasm_bindgen(js_name = wasmMemoryBytes, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn wasm_memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    return (core::arch::wasm32::memory_size(0) * 65_536) as f64;
    #[cfg(not(target_arch = "wasm32"))]
    0.0
}

/// Opens a pack of `count` objects the adapter writes piece by piece (`PackStream`).
#[wasm_bindgen(js_name = gitPackOpen, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_pack_open(now: f64, count: u32) -> String {
    answer(
        STREAMING
            .with_borrow_mut(|s| s.add(now, STREAMS, PackStream::new(count)))
            .map(Into::into),
    )
}

/// One piece: `op` 0 the header, 1 a whole object (`kind`, `data`), 2 a streamed file's
/// start (`kind` its id, `size`), 3 its content and packed bytes (`data`, `packed`),
/// 4 its end, 5 the trailer (the stream closes).
#[wasm_bindgen(js_name = gitPackPiece, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_pack_piece(
    handle: u32,
    op: u8,
    kind: &str,
    size: f64,
    data: &[u8],
    packed: &[u8],
) -> Result<Vec<u8>, JsError> {
    if op == 5 {
        let stream = STREAMING.with_borrow_mut(|s| s.open.remove(&handle));
        return stream
            .map(|(_, p)| p.finish())
            .ok_or_else(|| thrown(yoneda_core::Error::new("GONE", "The pack stream expired")));
    }
    STREAMING
        .with_borrow_mut(|s| {
            s.with(handle, |p| match op {
                0 => Ok(p.header()),
                1 => p.entry(kind, data),
                2 => p.large_start(kind, size as usize),
                3 => p.large_data(data, packed).map(|()| Vec::new()),
                4 => p.large_end().map(|()| Vec::new()),
                _ => Err(yoneda_core::Error::new("UNKNOWN_OP", "Unknown pack piece")),
            })
        })
        .map_err(thrown)
}

#[wasm_bindgen(js_name = gitPackClose, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn git_pack_close(handle: u32) {
    STREAMING.with_borrow_mut(|s| s.open.remove(&handle));
}
