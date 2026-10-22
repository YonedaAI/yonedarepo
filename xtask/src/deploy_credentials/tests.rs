use super::*;

const SECRET: &str = "cf-secret-value-123";
const ACCOUNT: &str = "f011d0ee02b23cad26b4b38151b204ad";

fn token_file(body: &str, mode: u32) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("deploy-dev.env");
    std::fs::write(&file, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = mode;
    (dir, file)
}

fn error(result: Result<(Option<Token>, Origin)>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn the_environment_wins_and_the_file_is_not_read() {
    let missing = Path::new("/nonexistent/deploy-dev.env");
    assert_eq!(
        resolve(Some("from-env".into()), missing, ACCOUNT).unwrap(),
        (None, Origin::Environment)
    );
    let (_dir, file) = token_file(&format!("{TOKEN_VAR}={SECRET}\n"), 0o600);
    assert_eq!(
        resolve(Some("from-env".into()), &file, ACCOUNT).unwrap().1,
        Origin::Environment
    );
}

#[test]
fn an_empty_variable_falls_back_to_the_file() {
    let (_dir, file) = token_file(
        &format!(
            "# dev deploy\nexport_ignored=1\n{TOKEN_VAR}=\"{SECRET}\"\n{ACCOUNT_VAR}={ACCOUNT}\n"
        ),
        0o600,
    );
    let (token, origin) = resolve(Some("  ".into()), &file, ACCOUNT).unwrap();
    assert_eq!(token, Some(Token(SECRET.into())));
    assert_eq!(origin, Origin::File(file));
}

#[test]
fn a_missing_file_is_a_clear_error() {
    let message = error(resolve(
        None,
        Path::new("/nonexistent/deploy-dev.env"),
        ACCOUNT,
    ));
    assert!(message.contains("No Cloudflare API token"), "{message}");
    assert!(message.contains("/nonexistent/deploy-dev.env"), "{message}");
    assert!(message.contains(TOKEN_VAR), "{message}");
}

#[test]
fn nothing_reveals_the_token() {
    let (_dir, file) = token_file(&format!("{TOKEN_VAR}={SECRET}\n"), 0o600);
    let resolved = resolve(None, &file, ACCOUNT).unwrap();
    assert!(!format!("{resolved:?}").contains(SECRET));
    // Failures name the file and the key, never the value.
    let (_d1, wrong_account) = token_file(
        &format!("{TOKEN_VAR}={SECRET}\n{ACCOUNT_VAR}=other\n"),
        0o600,
    );
    let (_d2, no_token) = token_file(&format!("OTHER={SECRET}\n"), 0o600);
    for message in [
        error(resolve(None, &wrong_account, ACCOUNT)),
        error(resolve(None, &no_token, ACCOUNT)),
    ] {
        assert!(!message.contains(SECRET), "{message}");
    }
}

#[test]
fn a_file_for_another_account_or_without_a_token_is_refused() {
    let (_d1, file) = token_file(
        &format!("{TOKEN_VAR}={SECRET}\n{ACCOUNT_VAR}=other\n"),
        0o600,
    );
    assert!(error(resolve(None, &file, ACCOUNT)).contains("names account other"));
    let (_d2, file) = token_file(&format!("{ACCOUNT_VAR}={ACCOUNT}\n"), 0o600);
    assert!(error(resolve(None, &file, ACCOUNT)).contains("has no CLOUDFLARE_API_TOKEN"));
}

#[cfg(unix)]
#[test]
fn a_token_file_others_can_read_is_refused() {
    let (_dir, file) = token_file(&format!("{TOKEN_VAR}={SECRET}\n"), 0o644);
    let message = error(resolve(None, &file, ACCOUNT));
    assert!(message.contains("chmod 600"), "{message}");
    assert!(!message.contains(SECRET));
}
