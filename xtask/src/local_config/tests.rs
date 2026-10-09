use super::*;

fn bindings(owner: &str, key: &str) -> String {
    format!(
        "# Preserve comments and CRLF exactly\r\nOWNER_TOKEN=\"{owner}\"\r\nVAULT_KEY='{key}'\r\nCUSTOM_VALUE=unchanged\r\n"
    )
}
fn assert_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn legacy_vars_copy_exactly_and_repeated_setup_retains_credentials_and_state() {
    let root = tempfile::tempdir().unwrap();
    let owner = "fixture-owner-token-preserved";
    let key = "a".repeat(64);
    let contents = bindings(owner, &key);
    fs::write(root.path().join(".dev.vars"), &contents).unwrap();
    fs::create_dir_all(root.path().join(".local")).unwrap();
    fs::write(root.path().join(".local/owner-token"), owner).unwrap();
    fs::write(root.path().join(".local/vault-key"), &key).unwrap();
    fs::create_dir_all(root.path().join(".wrangler/state")).unwrap();
    fs::write(
        root.path().join(".wrangler/state/existing.sqlite"),
        b"existing-state",
    )
    .unwrap();
    for _ in 0..2 {
        ensure(root.path()).unwrap();
        for path in [".dev.vars", DEV_VARS] {
            assert_eq!(
                fs::read(root.path().join(path)).unwrap(),
                contents.as_bytes()
            );
            assert_private(&root.path().join(path));
        }
        assert_eq!(
            fs::read_to_string(root.path().join(".local/owner-token")).unwrap(),
            owner
        );
        assert_eq!(
            fs::read_to_string(root.path().join(".local/vault-key")).unwrap(),
            key
        );
        assert_eq!(
            fs::read(root.path().join(".wrangler/state/existing.sqlite")).unwrap(),
            b"existing-state"
        );
    }
}

#[test]
fn missing_backups_adopt_existing_bindings_without_rotation() {
    let root = tempfile::tempdir().unwrap();
    let owner = "fixture-existing-owner";
    let key = "b".repeat(64);
    let contents = bindings(owner, &key);
    fs::write(root.path().join(".dev.vars"), &contents).unwrap();
    ensure(root.path()).unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join(".local/owner-token")).unwrap(),
        owner
    );
    assert_eq!(
        fs::read_to_string(root.path().join(".local/vault-key")).unwrap(),
        key
    );
    assert_eq!(
        fs::read_to_string(root.path().join(DEV_VARS)).unwrap(),
        contents
    );
    assert_private(&root.path().join(".local/owner-token"));
    assert_private(&root.path().join(".local/vault-key"));
}

#[test]
fn canonical_and_named_vars_are_not_overwritten_by_legacy_or_repeated_setup() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("cloudflare")).unwrap();
    let canonical = bindings("fixture-canonical-owner", &"c".repeat(64));
    fs::write(root.path().join(DEV_VARS), &canonical).unwrap();
    fs::write(
        root.path().join(".dev.vars"),
        bindings("fixture-legacy-owner", &"d".repeat(64)),
    )
    .unwrap();
    ensure(root.path()).unwrap();
    let named = root.path().join(".local/deploy/production");
    named_vars(root.path(), &named).unwrap();
    assert_eq!(
        fs::read_to_string(named.join(".dev.vars")).unwrap(),
        canonical
    );
    let reviewed = bindings("fixture-named-owner", &"e".repeat(64));
    fs::write(named.join(".dev.vars"), &reviewed).unwrap();
    fs::create_dir_all(named.join("state")).unwrap();
    fs::write(named.join("state/existing.sqlite"), b"named-state").unwrap();
    ensure(root.path()).unwrap();
    named_vars(root.path(), &named).unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join(DEV_VARS)).unwrap(),
        canonical
    );
    assert_eq!(
        fs::read_to_string(named.join(".dev.vars")).unwrap(),
        reviewed
    );
    assert_eq!(
        fs::read(named.join("state/existing.sqlite")).unwrap(),
        b"named-state"
    );
    assert_private(&named.join(".dev.vars"));
}

#[test]
fn fresh_setup_uses_only_canonical_vars_and_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    ensure(root.path()).unwrap();
    let original = fs::read(root.path().join(DEV_VARS)).unwrap();
    ensure(root.path()).unwrap();
    assert_eq!(fs::read(root.path().join(DEV_VARS)).unwrap(), original);
    assert!(!root.path().join(".dev.vars").exists());
    assert_private(&root.path().join(DEV_VARS));
}
