//! Moving objects from the platform: batched `POST /objects` pages and large-blob downloads
//! that survive a broken stream, shared between concurrent callers.
//!
//! - A page cut off mid-body keeps every object that arrived whole; the next request asks
//!   from the first incomplete one (the platform serves in request order, so the ids it
//!   skipped before the last whole object are the ones it lacks).
//! - A large blob's download cut off resumes with `Range` from the bytes it has.
//! - Concurrent callers of one `Api` wanting the same object share one request.
//! - A request that goes quiet for the idle timeout counts as cut (`api::Timeouts`); a
//!   fetch past its total budget ends naming the request it waited on and how far it got.
//!
//! Every object is still verified against its id before it is written (`verified`,
//! `commits`); a download is also checked here, so corrupt resumed bytes never leave it.
use super::object_id;
use super::page::{aligned, whole_objects};
use crate::api::{self, Api, Received};
use crate::error::{Error, Result};
use base64::Engine;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use yoneda_core::git_object::{ObjectKind, hash_object};

/// Ids per `POST /objects` request (the platform takes up to 10 000).
const REQUEST_OBJECTS: usize = 2_000;
/// Consecutive attempts that brought nothing new before a request is given up (or, for a
/// page, asked again for half as many ids).
const ATTEMPTS: u64 = 3;

/// How far a fetch got and what it is waiting on, for the error that ends it.
#[derive(Default)]
struct Progress {
    arrived: usize,
    doing: String,
}

type Tracker = Mutex<Progress>;

fn note(tracker: &Tracker, update: impl FnOnce(&mut Progress)) {
    if let Ok(mut progress) = tracker.lock() {
        update(&mut progress);
    }
}

/// `failure` ended the request `doing` names.
fn failed(tracker: &Tracker, failure: api::Failure) -> Error {
    let doing = tracker.lock().map(|p| p.doing.clone()).unwrap_or_default();
    Error::new(format!("{doing}: {failure}"))
}

/// The served objects among `wanted`, in request order, and the ids the platform does not
/// have. `raw` asks for commits as their exact Git content. Large blobs come as stubs
/// (`large`: base64 in a JSON page costs the platform several copies of a blob) and are
/// downloaded one by one.
pub(super) async fn request(
    api: &Api,
    wanted: &[(String, ObjectKind)],
    raw: bool,
) -> Result<(Vec<Value>, Vec<String>)> {
    let key = |id: &str, kind: ObjectKind| format!("{}:{}:{id}", u8::from(raw), kind.name());
    let keys: Vec<String> = wanted.iter().map(|(id, kind)| key(id, *kind)).collect();
    let (mut lead, waits) = api.objects().claim(&keys);
    // Each key this caller owns, fetched once however often it was asked for.
    let mut own: HashSet<&String> = lead.keys().collect();
    let mine: Vec<(String, ObjectKind)> = wanted
        .iter()
        .zip(&keys)
        .filter(|(_, k)| own.remove(k))
        .map(|(object, _)| object.clone())
        .collect();
    let mut outcomes: HashMap<String, Option<Arc<Value>>> = HashMap::new();
    if !mine.is_empty() {
        // On failure `lead` is dropped unfinished: its waiters fail with this caller.
        let budget = api.timeouts().budget;
        let tracker = Tracker::default();
        let (fetched, absent) =
            match tokio::time::timeout(budget, pages(api, &mine, raw, &tracker)).await {
                Ok(fetched) => fetched?,
                Err(_) => {
                    let progress = tracker.lock().map(|p| (p.arrived, p.doing.clone()));
                    let (arrived, doing) = progress.unwrap_or_default();
                    return Err(Error::new(format!(
                        "fetching objects took longer than its {} ms budget \
                     (YONEDA_FETCH_BUDGET_SECS): {arrived} of {} objects arrived, \
                     still waiting on {doing}",
                        budget.as_millis(),
                        mine.len()
                    )));
                }
            };
        let absent: HashSet<String> = absent.into_iter().collect();
        let mut fetched: HashMap<String, Value> = fetched
            .into_iter()
            .map(|o| (o["id"].as_str().unwrap_or_default().to_owned(), o))
            .collect();
        for (id, kind) in &mine {
            let object = fetched.remove(id).map(Arc::new);
            if object.is_none() && !absent.contains(id) {
                return Err(Error::new(format!("the platform's answer left out {id}")));
            }
            lead.finish(&key(id, *kind), Ok(object.clone()));
            outcomes.insert(key(id, *kind), object);
        }
    }
    drop(lead);
    for (k, wait) in waits {
        outcomes.insert(k, wait.outcome().await.map_err(Error::new)?);
    }
    let mut served = Vec::with_capacity(wanted.len());
    let mut missing = Vec::new();
    for ((id, _), k) in wanted.iter().zip(&keys) {
        // `remove`: a duplicate id is answered once.
        match outcomes.remove(k) {
            Some(Some(object)) => {
                served.push(Arc::try_unwrap(object).unwrap_or_else(|shared| (*shared).clone()));
            }
            Some(None) => missing.push(id.clone()),
            None => {}
        }
    }
    Ok((served, missing))
}

/// `wanted` (distinct) fetched page by page. A page the platform cannot answer (a gateway
/// error left after retries, such as a Worker over its limits) is asked again for half as
/// many ids, down to one; a page cut off resumes after its last whole object.
async fn pages(
    api: &Api,
    wanted: &[(String, ObjectKind)],
    raw: bool,
    tracker: &Tracker,
) -> Result<(Vec<Value>, Vec<String>)> {
    let mut fetched = Vec::with_capacity(wanted.len());
    let mut absent = Vec::new();
    for (n, batch) in wanted.chunks(REQUEST_OBJECTS).enumerate() {
        let mut pos = 0;
        let mut window = batch.len();
        let mut failures = 0;
        while pos < batch.len() {
            let part = &batch[pos..(pos + window).min(batch.len())];
            let ids: Vec<Value> = part
                .iter()
                .map(|(id, kind)| json!({ "id": id, "kind": kind.name() }))
                .collect();
            let body = json!({ "objects": ids, "after": 0, "raw": raw, "large": true });
            let first = n * REQUEST_OBJECTS + pos;
            note(tracker, |p| {
                p.doing = format!("POST /objects ({} ids from #{first})", part.len());
            });
            let (objects, done, stopped) = match api.post_read_once("/objects", &body).await {
                Ok(Received {
                    bytes, cut: None, ..
                }) => {
                    let page: Value = serde_json::from_slice(&bytes)
                        .map_err(|e| Error::new(format!("an unreadable object page: {e}")))?;
                    absent.extend(
                        page["missing"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|m| m.as_str().map(str::to_owned)),
                    );
                    // `next`: where the page stopped within `part` (none: it served all).
                    let done = page["next"]
                        .as_u64()
                        .map_or(part.len(), |n| usize::try_from(n).unwrap_or(0));
                    if done == 0 {
                        return Err(Error::new("the platform's object paging did not advance"));
                    }
                    let objects = page["objects"].as_array().cloned().unwrap_or_default();
                    (objects, done, None)
                }
                Ok(Received {
                    bytes,
                    cut: Some(cut),
                    ..
                }) => {
                    let whole = whole_objects(&bytes);
                    let (done, skipped) = aligned(part, &whole)?;
                    absent.extend(skipped);
                    (whole, done, Some(cut))
                }
                Err(failure) if api::transient(&failure) => (Vec::new(), 0, Some(failure)),
                Err(failure) => return Err(failed(tracker, failure)),
            };
            for object in objects {
                fetched.push(if object["large"] == true {
                    download(api, &object, tracker).await?
                } else {
                    object
                });
                note(tracker, |p| p.arrived += 1);
            }
            pos += done;
            match stopped {
                Some(failure) if done == 0 => {
                    failures += 1;
                    if failures <= ATTEMPTS {
                        api::pause(&failure, failures).await;
                    } else if window > 1 {
                        window = window.div_ceil(2);
                        failures = 0;
                    } else {
                        return Err(failed(tracker, failure));
                    }
                }
                _ => failures = 0,
            }
        }
    }
    Ok((fetched, absent))
}

/// A large blob's stub as the served blob: its bytes downloaded on their own, resuming a
/// cut download from the bytes already here, and verified against the id.
async fn download(api: &Api, stub: &Value, tracker: &Tracker) -> Result<Value> {
    let id = object_id(stub, "id")?;
    let path = format!("/objects/{id}");
    let mut bytes: Vec<u8> = Vec::new();
    let mut failures = 0;
    loop {
        let have = bytes.len() as u64;
        note(tracker, |p| {
            p.doing = format!("GET /objects/{id} from byte {have}")
        });
        let stopped = match api.get_bytes_from(&path, have).await {
            Ok(received) => {
                // A 206 continues these bytes; any other answer is the blob from its start.
                if received.status != 206 {
                    bytes.clear();
                } else if received.offset != have {
                    return Err(Error::new(format!(
                        "the platform resumed {id} at byte {} instead of {have}",
                        received.offset
                    )));
                }
                let progressed = bytes.len() as u64 + received.bytes.len() as u64 > have;
                bytes.extend_from_slice(&received.bytes);
                match received.cut {
                    None => break,
                    Some(_) if progressed => None,
                    Some(cut) => Some(cut),
                }
            }
            Err(failure) if api::transient(&failure) => Some(failure),
            Err(failure) => return Err(failed(tracker, failure)),
        };
        match stopped {
            Some(failure) => {
                failures += 1;
                if failures > ATTEMPTS {
                    return Err(failed(tracker, failure));
                }
                api::pause(&failure, failures).await;
            }
            None => failures = 0,
        }
    }
    if hash_object(ObjectKind::Blob, &bytes) != id {
        return Err(Error::new(format!(
            "the platform sent {id} with different content"
        )));
    }
    Ok(json!({
        "id": id.hex(),
        "kind": "blob",
        "data_b64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}
