//! A broken object stream resumes where it broke, concurrent wants of one object share
//! one request, and nothing unverified reaches the repository (fault-injecting fake).
use super::fake::{self, Reply, Seen};
use super::*;
use serde_json::json;

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

fn posts(log: &fake::Log) -> Vec<Seen> {
    log.lock()
        .map(|l| l.iter().map(|(s, _)| s.clone()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.method == "POST")
        .collect()
}

/// A page cut off inside its third object: the next request asks for that object onward
/// only (the two that arrived whole are kept), and an id the platform skipped before the
/// cut is still reported missing.
#[tokio::test]
async fn resumes_a_page_cut_mid_object_from_the_last_complete_object() -> Result<()> {
    let blobs: Vec<Vec<u8>> = (0..5u8).map(|i| vec![b'a' + i; 40_000]).collect();
    let unknown = "f".repeat(40);
    let mut ids: Vec<String> = blobs
        .iter()
        .map(|b| hash_object(ObjectKind::Blob, b).hex())
        .collect();
    ids.insert(1, unknown.clone());
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
        let missing: Vec<String> = seen
            .ids
            .iter()
            .filter(|id| {
                !served
                    .iter()
                    .any(|b| hash_object(ObjectKind::Blob, b).hex() == **id)
            })
            .cloned()
            .collect();
        let body = fake::page(&objects, &missing);
        let reply = Reply::ok("application/json", body.clone());
        if earlier.is_empty() {
            // Halfway into the third served object's base64.
            let third = &objects[2]["data_b64"];
            let at = String::from_utf8_lossy(&body)
                .find(third.as_str().unwrap_or("?"))
                .unwrap_or(0);
            reply.cut(at + 20_000)
        } else {
            reply
        }
    })
    .await?;
    let api = Api::account(&origin, None)?;
    let (fetched, missing) = request(&api, &wants(&ids), false).await?;
    let mut expected = ids.clone();
    expected.remove(1);
    assert_eq!(ids_of(&fetched), expected);
    for object in &fetched {
        verified(object)?;
    }
    assert_eq!(missing, vec![unknown]);
    let posts = posts(&log);
    assert_eq!(posts.len(), 2, "{posts:?}");
    // Re-read: the object the cut broke and what followed it, nothing that arrived whole.
    assert_eq!(posts[1].ids, ids[3..].to_vec());
    Ok(())
}

/// A large blob's download cut halfway resumes with `Range` from the bytes it has; a
/// platform that ignores the range (200, the whole blob) is handled too. Either way the
/// bytes are verified against the id.
#[tokio::test]
async fn resumes_a_large_blob_download_from_its_offset() -> Result<()> {
    let ranged: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let whole: Vec<u8> = (0..2_500_000u32).map(|i| (i % 241) as u8).collect();
    let ranged_id = hash_object(ObjectKind::Blob, &ranged).hex();
    let whole_id = hash_object(ObjectKind::Blob, &whole).hex();
    let (r, w) = (ranged.clone(), whole.clone());
    let (ri, wi) = (ranged_id.clone(), whole_id.clone());
    let (origin, log) = fake::serve(move |seen, earlier| {
        if seen.method == "POST" {
            let stubs = [
                json!({ "id": ri, "kind": "blob", "size": r.len(), "large": true }),
                json!({ "id": wi, "kind": "blob", "size": w.len(), "large": true }),
            ];
            return Reply::ok("application/json", fake::page(&stubs, &[]));
        }
        let (data, honors) = if seen.path.ends_with(&ri) {
            (&r, true)
        } else {
            (&w, false)
        };
        let first = !earlier.iter().any(|e| e.path == seen.path);
        let offset = seen
            .range
            .as_deref()
            .and_then(|v| v.strip_prefix("bytes="))
            .and_then(|v| v.strip_suffix('-'))
            .and_then(|v| v.parse::<usize>().ok());
        match offset {
            Some(from) if honors => {
                let mut reply = Reply::ok("application/octet-stream", data[from..].to_vec());
                reply.status = 206;
                reply.headers.push((
                    "content-range".into(),
                    format!("bytes {from}-{}/{}", data.len() - 1, data.len()),
                ));
                reply
            }
            _ if first => Reply::ok("application/octet-stream", data.clone()).cut(data.len() / 2),
            _ => Reply::ok("application/octet-stream", data.clone()),
        }
    })
    .await?;
    let api = Api::account(&origin, None)?;
    let (fetched, _) = request(&api, &wants(&[ranged_id.clone(), whole_id.clone()]), false).await?;
    for object in &fetched {
        verified(object)?;
    }
    let entries = log.lock().map(|l| l.clone()).unwrap_or_default();
    let gets: Vec<&(Seen, usize)> = entries.iter().filter(|(s, _)| s.method == "GET").collect();
    let of = |id: &str| -> Vec<&(Seen, usize)> {
        gets.iter()
            .copied()
            .filter(|(s, _)| s.path.ends_with(id))
            .collect()
    };
    let ranged_gets = of(&ranged_id);
    assert_eq!(ranged_gets.len(), 2, "{ranged_gets:?}");
    assert_eq!(
        ranged_gets[1].0.range.as_deref(),
        Some(format!("bytes={}-", ranged.len() / 2).as_str())
    );
    // Not one byte of the ranged blob was sent twice.
    assert_eq!(
        ranged_gets.iter().map(|(_, n)| n).sum::<usize>(),
        ranged.len()
    );
    assert_eq!(of(&whole_id).len(), 2);
    Ok(())
}

/// Two concurrent fetches wanting one object in common ask the platform for it once.
#[tokio::test]
async fn coalesces_concurrent_requests_for_the_same_object() -> Result<()> {
    let blobs: Vec<Vec<u8>> = (0..3u8).map(|i| vec![b'k' + i; 1000]).collect();
    let ids: Vec<String> = blobs
        .iter()
        .map(|b| hash_object(ObjectKind::Blob, b).hex())
        .collect();
    let served = blobs.clone();
    let (origin, log) = fake::serve(move |seen, _| {
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
        let mut reply = Reply::ok("application/json", fake::page(&objects, &[]));
        reply.delay_ms = 200;
        reply
    })
    .await?;
    let api = Api::account(&origin, None)?;
    let first = wants(&ids[..2]);
    let second = wants(&ids[1..]);
    let (a, b) = tokio::join!(request(&api, &first, false), request(&api, &second, false));
    assert_eq!(ids_of(&a?.0), ids[..2].to_vec());
    assert_eq!(ids_of(&b?.0), ids[1..].to_vec());
    let mut asked: Vec<String> = posts(&log).into_iter().flat_map(|s| s.ids).collect();
    asked.sort();
    let mut once = ids.clone();
    once.sort();
    assert_eq!(asked, once, "each object is requested exactly once");
    Ok(())
}

/// Bytes that do not match their id (here the resumed tail of a large blob) fail the
/// fetch, and nothing of it is written: not the blob, not the tree that names it.
#[tokio::test]
async fn rejects_corrupt_resumed_bytes_and_writes_nothing() -> Result<()> {
    let repo = crate::testkit::Repo::new()?;
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 239) as u8).collect();
    let small = b"small\n".to_vec();
    let entries = vec![
        TreeEntry {
            name: "big.bin".into(),
            mode: FileMode::Blob,
            id: hash_object(ObjectKind::Blob, &big),
        },
        TreeEntry {
            name: "small.txt".into(),
            mode: FileMode::Blob,
            id: hash_object(ObjectKind::Blob, &small),
        },
    ];
    let tree_id = hash_object(
        ObjectKind::Tree,
        &encode_tree(&entries).map_err(|e| Error::new(e.message))?,
    )
    .hex();
    let tree = json!({ "id": tree_id, "kind": "tree", "entries": entries.iter().map(|e|
        json!({ "name": e.name, "type": "blob", "id": e.id.hex() })).collect::<Vec<_>>() });
    let big_id = entries[0].id.hex();
    let (b, s, t, bi) = (big.clone(), small.clone(), tree.clone(), big_id.clone());
    let (origin, _) = fake::serve(move |seen, earlier| {
        if seen.method == "POST" {
            let objects: Vec<Value> = seen
                .ids
                .iter()
                .map(|id| {
                    if *id == bi {
                        json!({ "id": bi, "kind": "blob", "size": b.len(), "large": true })
                    } else if t["id"] == *id {
                        t.clone()
                    } else {
                        blob_json(&s)
                    }
                })
                .collect();
            return Reply::ok("application/json", fake::page(&objects, &[]));
        }
        if seen.range.is_none() && !earlier.iter().any(|e| e.method == "GET") {
            return Reply::ok("application/octet-stream", b.clone()).cut(b.len() / 2);
        }
        // The resumed (or repeated) bytes are wrong.
        let mut reply = Reply::ok("application/octet-stream", vec![0u8; b.len() - b.len() / 2]);
        reply.status = 206;
        reply.headers.push((
            "content-range".into(),
            format!("bytes {}-{}/{}", b.len() / 2, b.len() - 1, b.len()),
        ));
        reply
    })
    .await?;
    let api = Api::account(&origin, None)?;
    let failed = fetch_tree(&api, &repo.git, &tree_id).await;
    let Err(failure) = failed else {
        return Err(Error::new("corrupt bytes were accepted"));
    };
    assert!(
        failure.to_string().contains("different content"),
        "{failure}"
    );
    let absent = repo
        .git
        .missing(&[tree_id.clone(), big_id, entries[1].id.hex()])?;
    assert_eq!(absent.len(), 3, "nothing was written: {absent:?}");
    Ok(())
}

/// A tree fetch whose first page and first large download are both cut off still lands
/// every object in the repository, re-reading only the object each cut broke.
#[tokio::test]
async fn a_tree_fetch_cut_twice_completes_with_bounded_re_reads() -> Result<()> {
    let repo = crate::testkit::Repo::new()?;
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 233) as u8).collect();
    let smalls: Vec<Vec<u8>> = (0..4u8).map(|i| vec![b'p' + i; 30_000]).collect();
    let mut entries = vec![TreeEntry {
        name: "big.bin".into(),
        mode: FileMode::Blob,
        id: hash_object(ObjectKind::Blob, &big),
    }];
    for (i, small) in smalls.iter().enumerate() {
        entries.push(TreeEntry {
            name: format!("f{i}.txt"),
            mode: FileMode::Blob,
            id: hash_object(ObjectKind::Blob, small),
        });
    }
    let tree_id = hash_object(
        ObjectKind::Tree,
        &encode_tree(&entries).map_err(|e| Error::new(e.message))?,
    )
    .hex();
    let tree = json!({ "id": tree_id, "kind": "tree", "entries": entries.iter().map(|e|
        json!({ "name": e.name, "type": "blob", "id": e.id.hex() })).collect::<Vec<_>>() });
    let big_id = entries[0].id.hex();
    let (b, s, t, bi) = (big.clone(), smalls.clone(), tree.clone(), big_id.clone());
    let (origin, log) = fake::serve(move |seen, earlier| {
        if seen.method == "POST" {
            let objects: Vec<Value> = seen
                .ids
                .iter()
                .filter_map(|id| {
                    if *id == bi {
                        Some(json!({ "id": bi, "kind": "blob", "size": b.len(), "large": true }))
                    } else if t["id"] == *id {
                        Some(t.clone())
                    } else {
                        s.iter()
                            .find(|x| hash_object(ObjectKind::Blob, x).hex() == *id)
                            .map(|x| blob_json(x))
                    }
                })
                .collect();
            let body = fake::page(&objects, &[]);
            let blob_page = objects.len() > 1;
            let cut_before = earlier
                .iter()
                .any(|e| e.method == "POST" && e.ids.len() > 1);
            if blob_page && !cut_before {
                // Inside the third blob of the page.
                let third = objects[2]["data_b64"].as_str().unwrap_or("?").to_owned();
                let at = String::from_utf8_lossy(&body).find(&third).unwrap_or(0);
                return Reply::ok("application/json", body).cut(at + 1000);
            }
            return Reply::ok("application/json", body);
        }
        match seen.range.as_deref().and_then(|v| v.strip_prefix("bytes=")) {
            Some(from) => {
                let from: usize = from.trim_end_matches('-').parse().unwrap_or(0);
                let mut reply = Reply::ok("application/octet-stream", b[from..].to_vec());
                reply.status = 206;
                reply.headers.push((
                    "content-range".into(),
                    format!("bytes {from}-{}/{}", b.len() - 1, b.len()),
                ));
                reply
            }
            None => Reply::ok("application/octet-stream", b.clone()).cut(b.len() / 3),
        }
    })
    .await?;
    let api = Api::account(&origin, None)?;
    fetch_tree(&api, &repo.git, &tree_id).await?;
    let mut all: Vec<String> = entries.iter().map(|e| e.id.hex()).collect();
    all.push(tree_id);
    assert!(
        repo.git.missing(&all)?.is_empty(),
        "every object was written"
    );
    let entries = log.lock().map(|l| l.clone()).unwrap_or_default();
    // The retry asks from the object the cut broke on: none that arrived whole again.
    let pages: Vec<&Seen> = entries
        .iter()
        .map(|(s, _)| s)
        .filter(|s| s.method == "POST" && s.ids.len() > 1)
        .collect();
    assert_eq!(pages.len(), 2, "{entries:?}");
    assert_eq!(pages[1].ids, pages[0].ids[2..].to_vec());
    let downloaded: usize = entries
        .iter()
        .filter(|(s, _)| s.method == "GET")
        .map(|(_, n)| n)
        .sum();
    assert_eq!(
        downloaded,
        big.len(),
        "no byte of the large blob was sent twice"
    );
    Ok(())
}
