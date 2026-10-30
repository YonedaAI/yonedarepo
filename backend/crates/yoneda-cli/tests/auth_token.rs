//! `yoneda auth token`: prints the credential the CLI sends, on stdout only, for scripts;
//! the platform is never contacted.
use std::path::Path;
use std::process::{Command, Output, Stdio};

const ORIGIN: &str = "https://api.example.test";

fn yoneda(config: &Path, args: &[&str], env_token: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_yoneda"));
    command
        .args(args)
        .env("XDG_CONFIG_HOME", config)
        .env("HOME", config)
        .env_remove("YONEDA_TOKEN")
        .env_remove("YONEDA_ORIGIN")
        .stdin(Stdio::null());
    if let Some(token) = env_token {
        command.env("YONEDA_TOKEN", token);
    }
    command.output().expect("yoneda runs")
}

fn store(config: &Path, token: &str) {
    let dir = config.join("yoneda");
    std::fs::create_dir_all(&dir).expect("config dir");
    let stored = format!(r#"{{"origin":"{ORIGIN}","token":"{token}"}}"#);
    std::fs::write(dir.join("credentials"), stored).expect("credentials");
}

#[test]
fn prints_the_stored_token_on_stdout_alone() {
    let config = tempfile::tempdir().expect("tempdir");
    store(config.path(), "ypat_stored");
    let out = yoneda(config.path(), &["auth", "token"], None);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "ypat_stored\n");
    assert!(!String::from_utf8_lossy(&out.stderr).contains("ypat_stored"));
}

#[test]
fn prefers_yoneda_token_like_every_other_command() {
    let config = tempfile::tempdir().expect("tempdir");
    store(config.path(), "ypat_stored");
    let out = yoneda(config.path(), &["auth", "token"], Some("ypat_env"));
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "ypat_env\n");
}

#[test]
fn says_how_to_sign_in_when_there_is_no_token() {
    let config = tempfile::tempdir().expect("tempdir");
    let out = yoneda(config.path(), &["auth", "token", "--origin", ORIGIN], None);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("yoneda login"));
}

#[test]
fn has_no_json_form() {
    let config = tempfile::tempdir().expect("tempdir");
    store(config.path(), "ypat_stored");
    let out = yoneda(config.path(), &["auth", "token", "--json"], None);
    assert!(!out.status.success());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("ypat_stored"));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("ypat_stored"));
}
