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
        .env_remove("YONEDA_AGENT")
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

fn as_agent(config: &Path, agent: &str, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_yoneda"));
    command
        .args(args)
        .env("XDG_CONFIG_HOME", config)
        .env("HOME", config)
        .env("YONEDA_AGENT", agent)
        .env_remove("YONEDA_TOKEN")
        .env_remove("YONEDA_ORIGIN")
        .stdin(Stdio::null());
    command.output().expect("yoneda runs")
}

fn store_agent(config: &Path, agent: &str, token: &str) {
    let dir = config.join("yoneda").join("agents").join(agent);
    std::fs::create_dir_all(&dir).expect("slot dir");
    let stored = format!(r#"{{"origin":"{ORIGIN}","token":"{token}"}}"#);
    std::fs::write(dir.join("credentials"), stored).expect("credentials");
}

#[test]
fn a_run_reads_the_person_or_the_agent_it_names_and_never_crosses() {
    let config = tempfile::tempdir().expect("tempdir");
    store(config.path(), "ypat_person");
    store_agent(config.path(), "bot", "ypat_bot");
    let token = ["auth", "token"];
    let printed = |out: Output| String::from_utf8_lossy(&out.stdout).into_owned();
    assert_eq!(
        printed(yoneda(config.path(), &token, None)),
        "ypat_person\n"
    );
    assert_eq!(
        printed(as_agent(config.path(), "bot", &token)),
        "ypat_bot\n"
    );
    // An empty name is no name, as for YONEDA_TOKEN.
    assert_eq!(
        printed(as_agent(config.path(), "", &token)),
        "ypat_person\n"
    );
    // Nobody borrows the person's login, and a name stays inside the store.
    for agent in ["other", "../..", "a/b"] {
        let out = as_agent(config.path(), agent, &token);
        assert!(!out.status.success(), "{agent}");
        assert!(out.stdout.is_empty(), "{agent}");
    }
    let unknown = as_agent(config.path(), "other", &token);
    assert!(String::from_utf8_lossy(&unknown.stderr).contains("yoneda login --agent other"));
}

#[test]
fn logging_one_out_leaves_the_other_signed_in() {
    let config = tempfile::tempdir().expect("tempdir");
    store(config.path(), "ypat_person");
    store_agent(config.path(), "bot", "ypat_bot");
    let out = yoneda(config.path(), &["logout", "--agent", "bot"], None);
    assert!(out.status.success());
    let person = yoneda(config.path(), &["auth", "token"], None);
    assert_eq!(String::from_utf8_lossy(&person.stdout), "ypat_person\n");
    assert!(
        !as_agent(config.path(), "bot", &["auth", "token"])
            .status
            .success()
    );

    store_agent(config.path(), "bot", "ypat_bot");
    assert!(yoneda(config.path(), &["logout"], None).status.success());
    assert!(
        !yoneda(config.path(), &["auth", "token", "--origin", ORIGIN], None)
            .status
            .success()
    );
    let agent = as_agent(config.path(), "bot", &["auth", "token"]);
    assert_eq!(String::from_utf8_lossy(&agent.stdout), "ypat_bot\n");
}

#[test]
fn a_token_on_stdin_is_never_an_agents() {
    let config = tempfile::tempdir().expect("tempdir");
    let out = as_agent(
        config.path(),
        "bot",
        &["login", "--with-token", "--origin", ORIGIN],
    );
    assert!(!out.status.success());
    assert!(!config.path().join("yoneda").exists());
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
