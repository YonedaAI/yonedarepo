//! Replayed commits: given the author, committer and exact message of a commit made
//! elsewhere, the platform builds the same Git object (so the same id).
use super::*;
use crate::repo_store::prepare::changes::changes as parse_changes;
use base64::{Engine, engine::general_purpose::STANDARD};

const NOW_MS: i64 = 1_800_000_000_123;

fn added(c: &Value) -> Result<Built> {
    let changes = parse_changes(c, &[])?;
    build(
        c,
        None,
        &[],
        &changes,
        &Trees(HashMap::new()),
        NOW_MS,
        &|_| Ok(()),
    )
}

fn request(extra: Value) -> Value {
    let mut c = json!({
        "message": "add a\n\nbody line\n",
        "author": {"name": "Ada", "email": "ada@example.com"},
        "changes": [{"path": "a.txt", "content_b64": "YQo="}],
    });
    for (k, v) in extra.as_object().into_iter().flatten() {
        c[k] = v.clone();
    }
    c
}

fn sig(name: &str, email: &str, seconds: i64, offset: &str) -> Signature {
    Signature {
        name: name.into(),
        email: email.into(),
        seconds,
        offset: offset.parse().unwrap(),
    }
}

#[test]
fn a_replayed_commit_is_byte_identical_to_the_local_one() -> Result<()> {
    let built = added(&request(json!({
        "author": {"name": "Ada", "email": "ada@example.com", "time": 1_700_000_000, "tz": "+0130"},
        "committer": {"name": "Bob", "email": "bob@example.com", "time": 1_700_000_100, "tz": "-0700"},
    })))?;
    let expected = Commit::new(
        built.root,
        &[],
        &sig("Ada", "ada@example.com", 1_700_000_000, "+0130"),
        &sig("Bob", "bob@example.com", 1_700_000_100, "-0700"),
        "add a\n\nbody line\n",
    )?;
    assert_eq!(built.id, expected.id());
    assert_eq!(built.objects[0].2, expected.encode());
    // Decoding the stored object gives back exactly what was asked for.
    let decoded = Commit::decode(&built.objects[0].2)?;
    assert_eq!(decoded.committer()?.offset.to_string(), "-0700");
    Ok(())
}

#[test]
fn without_times_the_platform_commits_now_in_utc() -> Result<()> {
    let built = added(&request(json!({})))?;
    let commit = Commit::decode(&built.objects[0].2)?;
    assert_eq!(
        commit.author()?,
        sig("Ada", "ada@example.com", NOW_MS / 1000, "+0000")
    );
    assert_eq!(
        commit.committer()?,
        sig(COMMITTER.0, COMMITTER.1, NOW_MS / 1000, "+0000")
    );
    // A committer without a time takes the author's.
    let built = added(&request(json!({
        "author": {"name": "Ada", "email": "ada@example.com", "time": 5, "tz": "+0200"},
        "committer": {"name": "Bob", "email": "bob@example.com"},
    })))?;
    let commit = Commit::decode(&built.objects[0].2)?;
    assert_eq!(
        commit.committer()?,
        sig("Bob", "bob@example.com", 5, "+0200")
    );
    Ok(())
}

#[test]
fn refuses_malformed_signatures() {
    for bad in [
        json!({"author": {"name": "Ada", "email": "ada@example.com", "tz": "0100"}}),
        json!({"author": {"name": "Ada", "email": "ada@example.com", "time": -1}}),
        json!({"author": {"name": "Ada", "email": "ada@example.com", "time": "soon"}}),
        json!({"committer": {"name": "Bob <x>", "email": "bob@example.com"}}),
        json!({"committer": {"email": "bob@example.com"}}),
    ] {
        assert!(added(&request(bad.clone())).is_err(), "{bad}");
    }
}

#[test]
fn symlinks_must_point_inside_the_repository() -> Result<()> {
    let link = |path: &str, target: &str| {
        request(json!({ "changes": [
            {"path": "a.txt", "content_b64": "YQo="},
            {"path": path, "type": "symlink", "content_b64": STANDARD.encode(target)},
        ]}))
    };
    let built = added(&link("docs/readme", "../a.txt"))?;
    assert!(
        built
            .touches
            .iter()
            .any(|t| t.path == "docs/readme" && t.mode == Some(FileMode::Symlink))
    );
    for (path, target) in [
        ("docs/escape", "../../etc/passwd"),
        ("abs", "/etc/passwd"),
        ("empty", ""),
        ("git", ".git/config"),
        ("slash", "a\\b"),
    ] {
        let error = added(&link(path, target)).err().map(|e| e.code);
        assert_eq!(error.as_deref(), Some("UNSAFE_PATH"), "{path} -> {target}");
    }
    Ok(())
}
