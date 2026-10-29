//! `yoneda-pack-builder`: serves its Worker on LISTEN (default 0.0.0.0:8080). Environment:
//! PACK_TOKEN (the bearer secret of this start), MIRROR_URL and PLATFORM_URL (the Git
//! remotes the Worker answers for), WORK (the bare repository's path, default /work/repo).
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use yoneda_pack_builder::{git, server::Server};

fn required(name: &str) -> String {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => value,
        _ => {
            git::log("pack.stopped", &format!(r#""error":"{name} is not set""#));
            std::process::exit(2);
        }
    }
}

fn main() {
    let token = required("PACK_TOKEN");
    let builder = git::Builder::new(
        &PathBuf::from(std::env::var("WORK").unwrap_or_else(|_| "/work/repo".into())),
        &required("MIRROR_URL"),
        &required("PLATFORM_URL"),
    );
    let listen = std::env::var("LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = match TcpListener::bind(&listen) {
        Ok(listener) => listener,
        Err(e) => {
            git::log(
                "pack.stopped",
                &format!(r#""error":{}"#, git::quote(&e.to_string())),
            );
            std::process::exit(1);
        }
    };
    git::log(
        "pack.listening",
        &format!(r#""listen":{}"#, git::quote(&listen)),
    );
    let server = Arc::new(Server::new(token, builder));
    for stream in listener.incoming().flatten() {
        let server = Arc::clone(&server);
        std::thread::spawn(move || server.serve(stream));
    }
}
