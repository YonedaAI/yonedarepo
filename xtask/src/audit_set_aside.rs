//! `admin audit-set-aside --env <env> --repo <id> --seq <n> --dry-run`, then `--confirm --bytes
//! <n>`: gets one corrupt audit event out of the way, so the log and a blocked erase can move
//! on (docs/incidents.md), through the deployed platform's
//! `POST /api/v1/admin/repos/<id>/audit-set-aside`, as the owner. The authority decides: a
//! healthy event is refused whatever is asked here. `--confirm` needs the size a dry run
//! printed, so nobody gets there without one. Nothing a row held is ever sent back, and only
//! named fields are printed, so an answer can't carry it to a terminal or a shell log.
//! Repeating is safe.
use crate::erase_backfill::option;
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, PartialEq)]
struct Asked {
    repo: String,
    seq: u64,
    /// The size the dry run printed; none is a dry run.
    bytes: Option<u64>,
}

fn is_hex(text: &str, length: usize) -> bool {
    let lower = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    text.len() == length && text.bytes().all(lower)
}

fn asked(args: &[String]) -> Result<Asked> {
    let (dry_run, confirmed) = (
        args.iter().any(|a| a == "--dry-run"),
        args.iter().any(|a| a == "--confirm"),
    );
    if dry_run == confirmed {
        return Err("Pass --dry-run first, then --confirm with its --bytes".into());
    }
    let repo = option(args, "--repo").ok_or("--repo <id> is required")?;
    if !(repo.starts_with('r') && is_hex(&repo[1..], 20)) {
        return Err("--repo must be a repository id, r and 20 hex digits".into());
    }
    let seq: u64 = option(args, "--seq")
        .ok_or("--seq <n> is required")?
        .parse()
        .map_err(|_| "--seq must be an event number")?;
    if seq == 0 {
        return Err("--seq must be an event number".into());
    }
    let bytes = option(args, "--bytes").map(str::parse).transpose();
    let bytes: Option<u64> =
        bytes.map_err(|_: std::num::ParseIntError| "--bytes must be a size")?;
    if confirmed && bytes.is_none() {
        return Err("--confirm needs the --bytes its dry run printed".into());
    }
    Ok(Asked {
        repo: repo.to_owned(),
        seq,
        bytes: bytes.filter(|_| confirmed),
    })
}

fn body(asked: &Asked) -> Value {
    match asked.bytes {
        Some(bytes) => json!({ "seq": asked.seq, "bytes": bytes }),
        None => json!({ "seq": asked.seq, "dry_run": true }),
    }
}

/// What to tell the operator, from the answer's named fields alone.
fn report(env: &str, asked: &Asked, answer: &Value) -> String {
    let Asked { repo, seq, .. } = asked;
    let row = format!("{repo} event {seq}");
    let word = |key: &str| answer[key].as_str().unwrap_or("-");
    let bytes = answer["bytes"].as_u64().unwrap_or(0);
    let facts = format!("{}, {bytes} bytes", word("kind"));
    match word("state") {
        "corrupt" => format!(
            "{row} can't be read ({facts}). This replaces it with an audit.row_set_aside event, for good. To do that:\n  cargo xtask admin audit-set-aside --env {env} --repo {repo} --seq {seq} --confirm --bytes {bytes}"
        ),
        "set_aside" => format!(
            "{row} set aside ({facts}). The log moves on, and a blocked erase at its next look."
        ),
        "already" => format!("{row} is already set aside: nothing to do."),
        "absent" => format!(
            "{row} isn't waiting: nothing to do. It was settled, or that's the wrong number."
        ),
        "erased" => format!("{repo} is erased: nothing to do."),
        _ => "Unknown answer: nothing is known to have changed. Check the platform's version."
            .to_owned(),
    }
}

/// A refusal's code and message: never the whole body.
fn refused(status: u16, body: &Value) -> String {
    let error = &body["error"];
    let word = |key: &str| error[key].as_str().unwrap_or("-");
    format!("HTTP {status} {}: {}", word("code"), word("message"))
}

async fn send(client: &reqwest::Client, origin: &str, owner: &str, asked: &Asked) -> Result<Value> {
    let response = client
        .post(format!(
            "{origin}/api/v1/admin/repos/{}/audit-set-aside",
            asked.repo
        ))
        .bearer_auth(owner)
        .json(&body(asked))
        .send()
        .await?;
    let status = response.status();
    let answer: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(refused(status.as_u16(), &answer).into());
    }
    Ok(answer)
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let asked = asked(args)?;
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(60))?;
    let answer = send(&client, &origin, &owner, &asked).await?;
    println!("{}", report(&env.name(), &asked, &answer));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const REPO: &str = "r0123456789abcdef0123";

    fn args(rest: &[&str]) -> Vec<String> {
        ["admin", "audit-set-aside", "--repo", REPO]
            .iter()
            .chain(rest)
            .map(|a| (*a).to_owned())
            .collect()
    }
    fn refusal(rest: &[&str]) -> String {
        asked(&args(rest)).unwrap_err().to_string()
    }

    #[test]
    fn a_dry_run_is_the_way_in_and_a_confirm_needs_what_it_printed() {
        let dry = asked(&args(&["--seq", "42", "--dry-run"])).unwrap();
        assert_eq!(dry.bytes, None);
        assert_eq!(body(&dry), json!({"seq":42,"dry_run":true}));
        let real = asked(&args(&["--seq", "42", "--confirm", "--bytes", "17"])).unwrap();
        assert_eq!(body(&real), json!({"seq":42,"bytes":17}));
        // A size on a dry run does nothing: a dry run stays a dry run.
        let both = asked(&args(&["--seq", "42", "--dry-run", "--bytes", "17"])).unwrap();
        assert_eq!(body(&both), json!({"seq":42,"dry_run":true}));
    }

    #[test]
    fn it_refuses_anything_short_of_one_named_row() {
        assert!(refusal(&["--seq", "42"]).contains("--dry-run"));
        assert!(refusal(&["--seq", "42", "--dry-run", "--confirm"]).contains("--dry-run"));
        assert!(refusal(&["--seq", "42", "--confirm"]).contains("--bytes"));
        assert!(refusal(&["--seq", "42", "--confirm", "--bytes", "abc"]).contains("--bytes"));
        assert!(refusal(&["--dry-run"]).contains("--seq"));
        assert!(refusal(&["--seq", "0", "--dry-run"]).contains("--seq"));
        assert!(refusal(&["--seq", "-1", "--dry-run"]).contains("--seq"));
        assert!(refusal(&["--seq", "all", "--dry-run"]).contains("--seq"));
        let no_repo: Vec<String> = ["--seq", "1", "--dry-run"].map(str::to_owned).to_vec();
        assert!(asked(&no_repo).unwrap_err().to_string().contains("--repo"));
        let wrong: Vec<String> = ["--repo", "demo", "--seq", "1", "--dry-run"]
            .map(str::to_owned)
            .to_vec();
        assert!(asked(&wrong).unwrap_err().to_string().contains("--repo"));
    }

    #[test]
    fn it_prints_named_fields_and_nothing_else_an_answer_holds() {
        let row = Asked {
            repo: REPO.to_owned(),
            seq: 42,
            bytes: None,
        };
        let answer = json!({"state":"corrupt","seq":42,"kind":"repo.renamed","bytes":17,
            "payload":"hunter2","error":"hunter2"});
        let text = report("dev", &row, &answer);
        assert!(text.contains(&format!(
            "{REPO} event 42 can't be read (repo.renamed, 17 bytes)"
        )));
        assert!(text.contains(&format!(
            "--env dev --repo {REPO} --seq 42 --confirm --bytes 17"
        )));
        assert!(!text.contains("hunter2"));
        for state in ["set_aside", "already", "absent", "erased", "new_state"] {
            let answer = json!({"state":state,"payload":"hunter2"});
            let text = report("dev", &row, &answer);
            assert!(!text.is_empty() && !text.contains("hunter2"), "{state}");
        }
        assert!(report("dev", &row, &json!({"state":"already"})).contains("nothing to do"));
        let unknown = report("dev", &row, &json!({"state":"new_state"}));
        assert!(unknown.contains("nothing is known to have changed"));
    }

    #[test]
    fn a_refusal_is_its_code_and_message_alone() {
        let body = json!({"error":{"code":"CONFLICT","message":"That event is healthy"},
            "payload":"hunter2"});
        let text = refused(409, &body);
        assert_eq!(text, "HTTP 409 CONFLICT: That event is healthy");
    }

    /// One request to a local listener, answered with `status` and `body`: what it received.
    async fn served(status: &str, body: &str) -> (tokio::task::JoinHandle<String>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                seen.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&seen);
                let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .and_then(|l| l.parse::<usize>().ok());
                if length.is_some_and(|length| rest.len() >= length) {
                    break;
                }
            }
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        (task, origin)
    }

    #[tokio::test]
    async fn it_calls_the_platforms_route_as_the_owner() {
        let (task, origin) = served("200 OK", r#"{"state":"already","seq":42}"#).await;
        let row = Asked {
            repo: REPO.to_owned(),
            seq: 42,
            bytes: Some(17),
        };
        let answer = send(&reqwest::Client::new(), &origin, "owner-token", &row)
            .await
            .unwrap();
        assert_eq!(answer["state"], "already");
        let seen = task.await.unwrap();
        assert!(seen.starts_with(&format!("POST /api/v1/admin/repos/{REPO}/audit-set-aside ")));
        assert!(
            seen.to_ascii_lowercase()
                .contains("authorization: bearer owner-token")
        );
        assert!(seen.ends_with(&json!({"seq":42,"bytes":17}).to_string()));
    }

    #[tokio::test]
    async fn a_refused_row_fails_the_command() {
        let body = r#"{"error":{"code":"CONFLICT","message":"That event is healthy"}}"#;
        let (task, origin) = served("409 Conflict", body).await;
        let row = Asked {
            repo: REPO.to_owned(),
            seq: 42,
            bytes: None,
        };
        let e = send(&reqwest::Client::new(), &origin, "owner-token", &row)
            .await
            .unwrap_err();
        assert_eq!(e.to_string(), "HTTP 409 CONFLICT: That event is healthy");
        task.await.unwrap();
    }
}
