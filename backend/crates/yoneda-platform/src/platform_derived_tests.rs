//! Part II's key sufficiency for search: a partition is keyed by its tree id alone, so the
//! segment stored under that key must not name the directory the tree sits at.
use crate::platform_compute::compute;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::git_object::{
    FileMode, ObjectId, ObjectKind, TreeEntry, encode_tree, hash_object,
};

fn tree(entries: &[(&str, FileMode, ObjectId)]) -> (ObjectId, Value) {
    let list: Vec<TreeEntry> = entries
        .iter()
        .map(|(name, mode, id)| TreeEntry {
            name: (*name).into(),
            mode: *mode,
            id: *id,
        })
        .collect();
    let id = hash_object(ObjectKind::Tree, &encode_tree(&list).unwrap());
    (id, crate::platform_objects::entries_json(&list))
}

/// A partition's segment: its files listed, then indexed as one chunk.
fn index_partition(
    tree: &Value,
    shallow: &Value,
    trees: &Value,
    blobs: &Value,
    sizes: Value,
) -> Value {
    let listed = compute(
        json!({ "op": "partition_files", "tree": tree, "shallow": shallow,
                                 "trees": trees }),
    )
    .unwrap();
    compute(
        json!({ "op": "index_files", "files": listed["files"], "blobs": blobs,
                    "sizes": sizes }),
    )
    .unwrap()
}

/// Plans the root's partitions and answers `query` from each one's segment.
fn search(root: ObjectId, trees: &Value, blobs: &Value, query: &str) -> (Vec<Value>, Vec<String>) {
    let plan = compute(json!({ "op": "search_plan", "root": root, "trees": trees })).unwrap();
    let partitions = plan["partitions"].as_array().unwrap().clone();
    let mut paths = Vec::new();
    for p in &partitions {
        let built = index_partition(&p["tree"], &p["shallow"], trees, blobs, json!({}));
        let found = compute(
            json!({ "op": "search_segment", "segment_b64": built["segment_b64"],
            "prefix": p["prefix"], "query": query }),
        )
        .unwrap();
        for file in found["candidates"].as_array().unwrap() {
            paths.push(file["path"].as_str().unwrap().to_owned());
        }
    }
    paths.sort();
    (partitions, paths)
}

#[test]
fn renamed_and_duplicated_directories_share_a_key_and_a_segment_but_not_paths() {
    let content = b"fn retry_with_backoff() {}\n";
    let blob = hash_object(ObjectKind::Blob, content);
    let blobs = json!({ blob.hex(): STANDARD.encode(content) });
    let (sub, sub_json) = tree(&[("retry.rs", FileMode::Blob, blob)]);
    let index = |trees: &Value, p: &Value| {
        index_partition(&p["tree"], &p["shallow"], trees, &blobs, json!({}))["segment_b64"].clone()
    };

    // A rename of src/ to lib/ that leaves the content alone keeps the key and the segment.
    let (before, before_json) = tree(&[("src", FileMode::Tree, sub)]);
    let (after, after_json) = tree(&[("lib", FileMode::Tree, sub)]);
    let t1 = json!({ before.hex(): before_json, sub.hex(): sub_json });
    let t2 = json!({ after.hex(): after_json, sub.hex(): sub_json });
    let (p1, found1) = search(before, &t1, &blobs, "retry_with");
    let (p2, found2) = search(after, &t2, &blobs, "retry_with");
    assert_eq!(
        p1[0]["key"], p2[0]["key"],
        "the renamed subtree keeps its key"
    );
    assert_eq!(
        index(&t1, &p1[0]),
        index(&t2, &p2[0]),
        "so its segment must match"
    );
    assert_eq!(found1, ["src/retry.rs"]);
    assert_eq!(
        found2,
        ["lib/retry.rs"],
        "answers name the queried tree's paths"
    );

    // Two identical directories in one commit share one segment and keep their own paths.
    let (both, both_json) = tree(&[("a", FileMode::Tree, sub), ("b", FileMode::Tree, sub)]);
    let t3 = json!({ both.hex(): both_json, sub.hex(): sub_json });
    let (p3, found3) = search(both, &t3, &blobs, "retry_with");
    assert_eq!(p3[0]["key"], p3[1]["key"]);
    assert_eq!(found3, ["a/retry.rs", "b/retry.rs"]);
}

#[test]
fn files_known_too_large_are_listed_unread_with_the_same_segment() {
    let small = b"fn retry_with_backoff() {}\n".to_vec();
    let large = vec![b'x'; yoneda_core::search::MAX_INDEXED_BYTES + 1];
    let (small_id, large_id) = (
        hash_object(ObjectKind::Blob, &small),
        hash_object(ObjectKind::Blob, &large),
    );
    let (root, root_json) = tree(&[
        ("big.txt", FileMode::Blob, large_id),
        ("retry.rs", FileMode::Blob, small_id),
    ]);
    let trees = json!({ root.hex(): root_json });
    let index = |blobs: Value, sizes: Value| {
        index_partition(&json!(root), &json!(true), &trees, &blobs, sizes)
    };
    let read = index(
        json!({ small_id.hex(): STANDARD.encode(&small), large_id.hex(): STANDARD.encode(&large) }),
        json!({}),
    );
    // Knowing the large file's size, only the small one is asked for.
    let sized = json!({ large_id.hex(): large.len() });
    assert_eq!(
        index(json!({}), sized.clone())["need_blobs"],
        json!([small_id])
    );
    let unread = index(json!({ small_id.hex(): STANDARD.encode(&small) }), sized);
    assert_eq!(unread["segment_b64"], read["segment_b64"]);
    let found = compute(
        json!({ "op": "search_segment", "segment_b64": read["segment_b64"],
        "prefix": "", "query": "xxx" }),
    )
    .unwrap();
    assert_eq!(
        found["unindexed"],
        json!([{ "path": "big.txt", "reason": "larger than 4 MiB" }])
    );
    assert_eq!(found["candidates"], json!([]));
}

#[test]
fn blame_answers_cap_each_line_at_500_characters() {
    let content = format!("{}\nshort\n", "é".repeat(2000));
    let blob = hash_object(ObjectKind::Blob, content.as_bytes());
    let commit = ObjectId::from_bytes([7; 20]);
    let answer = compute(json!({
        "op": "blame",
        "versions": [{ "commit": commit, "blob": blob }],
        "blobs": { blob.hex(): STANDARD.encode(&content) },
    }))
    .unwrap();
    assert_eq!(answer["lines"][0]["text"], "é".repeat(500));
    assert_eq!(answer["lines"][1]["text"], "short");
    assert_eq!(answer["lines"][1]["line"], 2);
}

/// A real partition's segment is far longer than a short text field: the Worker sends it
/// base64'd as `segment_b64`, and a segment over 16 KiB of text must still be searched
/// (live: every search answered 400 "Missing or invalid segment_b64").
#[test]
fn a_segment_larger_than_a_text_field_is_searched() {
    let mut entries = Vec::new();
    let mut blobs = serde_json::Map::new();
    for i in 0..200 {
        let content = format!("pub fn handler_{i}() {{ let hook_{i} = {i} * 31; }}\n").into_bytes();
        let blob = hash_object(ObjectKind::Blob, &content);
        blobs.insert(blob.hex(), json!(STANDARD.encode(&content)));
        entries.push((format!("f{i:03}.rs"), blob));
    }
    let named: Vec<(&str, FileMode, ObjectId)> = entries
        .iter()
        .map(|(n, id)| (n.as_str(), FileMode::Blob, *id))
        .collect();
    let (root, root_json) = tree(&named);
    let trees = json!({ root.hex(): root_json });
    let blobs = Value::Object(blobs);
    let plan = compute(json!({ "op": "search_plan", "root": root, "trees": trees })).unwrap();
    let p = &plan["partitions"][0];
    let built = index_partition(&p["tree"], &p["shallow"], &trees, &blobs, json!({}));
    let segment = built["segment_b64"].as_str().unwrap();
    assert!(
        segment.len() > 16_384,
        "the segment is only {} bytes of base64",
        segment.len()
    );
    let found = compute(
        json!({ "op": "search_segment", "segment_b64": segment, "prefix": "", "query": "hook_17" }),
    )
    .unwrap();
    let paths: Vec<&str> = found["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["path"].as_str())
        .collect();
    assert!(paths.contains(&"f017.rs"), "{paths:?}");
}
