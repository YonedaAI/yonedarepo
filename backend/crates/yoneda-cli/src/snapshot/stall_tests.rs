//! A stream that stops sending without closing (a stall) is treated like a cut after the
//! idle timeout and resumed; a platform that always stalls ends in an error that names the
//! request and how far the fetch got, within the fetch's time budget.
use super::fake::{self, Reply, Seen};
use super::*;
use serde_json::json;
use std::time::{Duration, Instant};

fn blob_json(data: &[u8]) -> Value {
    json!({ "id": hash_object(ObjectKind::Blob, data).hex(), "kind": "blob",
        "data_b64": base64::engine::general_purpose::STANDARD.encode(data) })
}

fn wants(ids: &[String]) -> Vec<(String, ObjectKind)> {
    ids.iter()
        .map(|id| (id.clone(), ObjectKind::Blob))
        .collect()
}

fn ids_of(objects: &[Value]) -> Vec<String> {
    objects
        .iter()
        .map(|o| o["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn seen(log: &fake::Log, method: &str) -> Vec<Seen> {
    log.lock()
        .map(|l| l.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.method == method)
        .collect()
}

/// Milliseconds of idle time instead of seconds, so the tests stay fast.
fn quick(origin: &str, budget: Duration) -> Result<Api> {
    Ok(Api::account(origin, None)?.with_timeouts(Duration::from_millis(150), budget))
}

/// A page that stops sending inside its third object (connection left open) resumes from
/// that object once the idle timeout passes.
#[tokio::test]
async fn resumes_a_page_that_stalls_mid_object() -> Result<()> {
    let blobs: Vec<Vec<u8>> = (0..5u8).map(|i| vec![b'a' + i; 40_000]).collect();
    let ids: Vec<String> = blobs
        .iter()
        .map(|b| hash_object(ObjectKind::Blob, b).hex())
        .collect();
    let served = blobs.clone();
    let (origin, log) = fake::serve(move |seen, earlier| {
        let objects: Vec<Value> = seen
            .ids
            .iter()
            .filter_map(|id| {
                served
                    .iter()
                    .find(|b| hash_object(ObjectKind::Blob, b).hex() == *id)
            })
            .map(|b| blob_json(b))
            .collect();
        let body = fake::page(&objects, &[]);
        if earlier.is_empty() {
            let third = objects[2]["data_b64"].as_str().unwrap_or("?").to_owned();
            let at = String::from_utf8_lossy(&body).find(&third).unwrap_or(0);
            return Reply::ok("application/json", body).stall(at + 20_000);
        }
        Reply::ok("application/json", body)
    })
    .await?;
    let api = quick(&origin, Duration::from_secs(20))?;
    let began = Instant::now();
    let (fetched, missing) = request(&api, &wants(&ids), false).await?;
    assert_eq!(ids_of(&fetched), ids);
    assert!(missing.is_empty());
    for object in &fetched {
        verified(object)?;
    }
    let posts = seen(&log, "POST");
    assert_eq!(posts.len(), 2, "{posts:?}");
    assert_eq!(
        posts[1].ids,
        ids[2..].to_vec(),
        "re-read from the stalled object"
    );
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    Ok(())
}

/// A large blob's download that stalls halfway resumes with `Range` from its offset.
#[tokio::test]
async fn resumes_a_download_that_stalls_halfway() -> Result<()> {
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 227) as u8).collect();
    let id = hash_object(ObjectKind::Blob, &big).hex();
    let (b, i) = (big.clone(), id.clone());
    let (origin, log) = fake::serve(move |seen, earlier| {
        if seen.method == "POST" {
            let stub = json!({ "id": i, "kind": "blob", "size": b.len(), "large": true });
            return Reply::ok("application/json", fake::page(&[stub], &[]));
        }
        if let Some(from) = seen
            .range
            .as_deref()
            .and_then(|v| v.strip_prefix("bytes="))
            .and_then(|v| v.trim_end_matches('-').parse::<usize>().ok())
        {
            let mut reply = Reply::ok("application/octet-stream", b[from..].to_vec());
            reply.status = 206;
            reply.headers.push((
                "content-range".into(),
                format!("bytes {from}-{}/{}", b.len() - 1, b.len()),
            ));
            return reply;
        }
        let first = !earlier.iter().any(|e| e.method == "GET");
        let reply = Reply::ok("application/octet-stream", b.clone());
        if first {
            reply.stall(b.len() / 2)
        } else {
            reply
        }
    })
    .await?;
    let api = quick(&origin, Duration::from_secs(20))?;
    let (fetched, _) = request(&api, &wants(std::slice::from_ref(&id)), false).await?;
    verified(&fetched[0])?;
    let gets = seen(&log, "GET");
    assert_eq!(gets.len(), 2, "{gets:?}");
    assert_eq!(
        gets[1].range.as_deref(),
        Some(format!("bytes={}-", big.len() / 2).as_str())
    );
    Ok(())
}

/// A platform that never answers ends the fetch with an error naming the request and how
/// far it got, within the budget (not a loop, not a hang).
#[tokio::test]
async fn a_platform_that_always_stalls_fails_within_the_budget() -> Result<()> {
    let ids: Vec<String> = (0..3u8)
        .map(|i| hash_object(ObjectKind::Blob, &[i]).hex())
        .collect();
    let (origin, _) =
        fake::serve(|_, _| Reply::ok("application/json", Vec::new()).silent()).await?;
    let budget = Duration::from_millis(1500);
    let api = quick(&origin, budget)?;
    let began = Instant::now();
    let failed = request(&api, &wants(&ids), false).await;
    let elapsed = began.elapsed();
    let Err(failure) = failed else {
        return Err(Error::new("a silent platform was not an error"));
    };
    let message = failure.to_string();
    assert!(message.contains("POST /objects"), "{message}");
    assert!(message.contains("0 of 3 objects"), "{message}");
    assert!(elapsed < budget + Duration::from_millis(700), "{elapsed:?}");
    Ok(())
}

/// Request counts for a 7,270-object fetch (the size of claude-code's history) against a
/// fake that pages like the platform (`repo-object-fetch.ts`: a page ends past 4 MiB of
/// response or 24 MiB of object bytes read; blobs over 2 MiB are stubs). SYNTHETIC sizes:
/// 7,262 blobs cycling 1 KiB to 19 KiB (about 72 MiB) plus 8 blobs of 3 MiB.
#[tokio::test]
async fn counts_requests_for_a_seven_thousand_object_fetch() -> Result<()> {
    let mut blobs: Vec<Vec<u8>> = (0..7_262u32)
        .map(|i| {
            let mut b = vec![(i % 251) as u8; 1024 * (1 + (i % 19) as usize)];
            b[..4].copy_from_slice(&i.to_be_bytes());
            b
        })
        .collect();
    blobs.extend((0..8u8).map(|i| vec![i; 3 * 1024 * 1024]));
    let ids: Vec<String> = blobs
        .iter()
        .map(|b| hash_object(ObjectKind::Blob, b).hex())
        .collect();
    let by_id: std::collections::HashMap<String, Vec<u8>> =
        ids.iter().cloned().zip(blobs.iter().cloned()).collect();
    let pages = std::sync::Arc::new(by_id);
    let (origin, log) = fake::serve(move |seen, _| {
        if seen.method == "GET" {
            let id = seen.path.rsplit('/').next().unwrap_or_default();
            return Reply::ok(
                "application/octet-stream",
                pages.get(id).cloned().unwrap_or_default(),
            );
        }
        // The platform's page rule (OBJECT_BUDGET, READ_BUDGET, LARGE_BLOB).
        let (mut objects, mut bytes, mut read, mut next) = (Vec::new(), 0usize, 0usize, None);
        for (index, id) in seen.ids.iter().enumerate() {
            if read >= 24 * 1024 * 1024 {
                next = Some(index);
                break;
            }
            let data = pages.get(id).cloned().unwrap_or_default();
            read += data.len();
            let object = if data.len() > 2 * 1024 * 1024 {
                json!({ "id": id, "kind": "blob", "size": data.len(), "large": true })
            } else {
                blob_json(&data)
            };
            let size = object["data_b64"].as_str().map_or(80, |t| t.len() + 96);
            if !objects.is_empty() && bytes + size > 4 * 1024 * 1024 {
                next = Some(index);
                break;
            }
            bytes += size;
            objects.push(object);
        }
        let body = fake::page(&objects, &[]);
        let text = String::from_utf8_lossy(&body)
            .replace("\"next\":null", &format!("\"next\":{}", json!(next)));
        Reply::ok("application/json", text.into_bytes())
    })
    .await?;
    let api = Api::account(&origin, None)?;
    let (fetched, _) = request(&api, &wants(&ids), false).await?;
    assert_eq!(fetched.len(), 7_270);
    let (posts, gets) = (seen(&log, "POST").len(), seen(&log, "GET").len());
    println!("7,270 objects: {posts} page requests + {gets} large-blob downloads");
    // Pages are bounded by bytes, not by 8 objects (that would be 909 pages).
    assert!(posts < 40, "{posts} pages");
    assert_eq!(gets, 8);
    Ok(())
}
