//! A symlink placed by blob id (merges, reverts, any client) gets the same target check as
//! one sent as content: prepare asks the adapter for the blob's bytes (`need_blobs`),
//! verifies them against the id and refuses a target that leaves the repository.
use super::*;

fn blob_id(text: &str) -> String {
    hash_object(ObjectKind::Blob, text.as_bytes()).hex()
}

fn link(path: &str, target: &str) -> Value {
    json!([{"path": path, "blob": blob_id(target), "type": "symlink"}])
}

#[test]
fn blob_referenced_symlinks_are_read_and_checked() {
    let (h, root) = seeded();
    let base = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([
                file("escape.txt", "../../etc/passwd"),
                file("inside.txt", "README.md")
            ]),
            json!([]),
        )
        .unwrap();
    // The first round asks for the referenced blob instead of trusting its mode.
    let asked = h.ok(
        AGENT,
        json!({"op":"repo_prepare_commit","parent":base,"base_version":1,
               "changes":link("evil", "../../etc/passwd"),"read_set":[],"trees":{},
               "message":"m","author":{"name":"A","email":"a@example.com"}}),
    );
    assert_eq!(asked["need_blobs"], json!([blob_id("../../etc/passwd")]));
    assert_eq!(asked["parent"], json!(base));
    let refused = h.commit(
        AGENT,
        Some(&base),
        1,
        link("evil", "../../etc/passwd"),
        json!([]),
    );
    assert_eq!(
        refused.err().map(|e| e.code).as_deref(),
        Some("UNSAFE_PATH")
    );
    h.commit(
        AGENT,
        Some(&base),
        1,
        link("readme", "README.md"),
        json!([]),
    )
    .unwrap();
    // A supplied blob must match its id.
    let forged = h.run(
        AGENT,
        json!({"op":"repo_prepare_commit","parent":base,"base_version":1,
               "changes":link("evil", "../../etc/passwd"),"read_set":[],"trees":{},
               "blobs":{blob_id("../../etc/passwd"): STANDARD.encode("README.md")},
               "message":"m","author":{"name":"A","email":"a@example.com"}}),
    );
    assert_eq!(code(forged), "BLOB_INVALID");
}

#[test]
fn stateless_builds_check_blob_referenced_symlinks_too() {
    let id = blob_id("/etc/passwd");
    let request = |blobs: Value| {
        crate::platform_compute::compute(json!({
            "op": "build_commit", "now": 1, "parent": null, "trees": {}, "read_set": [],
            "changes": [{"path": "evil", "blob": id, "type": "symlink"}],
            "message": "m", "author": {"name": "A", "email": "a@example.com"},
            "known_blobs": [id], "blobs": blobs,
        }))
    };
    assert_eq!(request(json!({})).unwrap()["need_blobs"], json!([id]));
    let supplied = json!({ id.clone(): STANDARD.encode("/etc/passwd") });
    assert_eq!(code(request(supplied)), "UNSAFE_PATH");
}
