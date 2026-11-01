//! `YONEDA_OWN_TRAFFIC=1` marks what the CLI sends, so our own tools stay out of the platform's
//! analytics; without it the CLI sends nothing of the kind.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const MARK: &str = "x-yoneda-own-traffic: 1";

/// The head of the first request `yoneda repo list` sends to a server that refuses it.
fn request_head(mark: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    let (sent, heard) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut bytes = [0u8; 8192];
        let read = stream.read(&mut bytes).expect("read");
        sent.send(String::from_utf8_lossy(&bytes[..read]).to_lowercase())
            .expect("send");
        let refused =
            "HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}";
        stream.write_all(refused.as_bytes()).expect("answer");
    });
    let config = tempfile::tempdir().expect("tempdir");
    let mut command = Command::new(env!("CARGO_BIN_EXE_yoneda"));
    command
        .args(["repo", "list"])
        .env("XDG_CONFIG_HOME", config.path())
        .env("HOME", config.path())
        .env("YONEDA_ORIGIN", &origin)
        .env("YONEDA_TOKEN", "ypat_test")
        .env_remove("YONEDA_OWN_TRAFFIC")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if mark {
        command.env("YONEDA_OWN_TRAFFIC", "1");
    }
    command.status().expect("yoneda runs");
    heard
        .recv_timeout(Duration::from_secs(10))
        .expect("the CLI called the server")
}

#[test]
fn the_environment_variable_marks_a_request() {
    assert!(request_head(true).contains(MARK));
}

#[test]
fn a_person_running_the_cli_sends_no_mark() {
    assert!(!request_head(false).contains(MARK));
}
