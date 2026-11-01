//! `admin newsletter-export --env <env> --out <file>`: writes the Flight log's confirmed
//! subscribers to a new CSV file (mode 0600) through the deployed platform's
//! `GET /api/v1/admin/newsletter` as the owner, a page at a time; the platform audits each page.
//! It needs a file so the addresses never land in a terminal's or a log's scrollback, and it
//! refuses to overwrite one. Each row carries the unsubscribe link a mail to that person needs.
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

const HEADER: &str = "email,confirmed_at,unsubscribe_url";

/// The value after `--out`.
fn out_path(args: &[String]) -> Result<PathBuf> {
    args.iter()
        .position(|a| a == "--out")
        .and_then(|at| args.get(at + 1))
        .map(PathBuf::from)
        .ok_or_else(|| "cargo xtask admin newsletter-export --env dev|prod --out <file>".into())
}

/// One CSV field, quoted when it has to be.
fn field(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// One subscriber's CSV line, or an error naming what the platform left out.
fn line(subscriber: &Value) -> Result<String> {
    let text = |name: &str| {
        subscriber[name]
            .as_str()
            .ok_or_else(|| format!("A subscriber without {name}"))
    };
    let confirmed = subscriber["confirmed_at"]
        .as_i64()
        .ok_or("A subscriber without confirmed_at")?;
    Ok(format!(
        "{},{confirmed},{}",
        field(text("email")?),
        field(text("unsubscribe_url")?)
    ))
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let out = out_path(args)?;
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(60))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(&out)
        .map_err(|error| format!("Cannot create {}: {error}", out.display()))?;
    writeln!(file, "{HEADER}")?;
    let (mut after, mut written) = (String::new(), 0);
    loop {
        let response = client
            .get(format!("{origin}/api/v1/admin/newsletter?after={after}"))
            .bearer_auth(&owner)
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("export after {after:?}: HTTP {status}: {body}").into());
        }
        for subscriber in body["subscribers"].as_array().into_iter().flatten() {
            writeln!(file, "{}", line(subscriber)?)?;
            written += 1;
        }
        match body["next"].as_str() {
            Some(next) => next.clone_into(&mut after),
            None => break,
        }
    }
    println!("{}: {written} subscribers in {}", env.name(), out.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{field, line, out_path};
    use serde_json::json;

    #[test]
    fn needs_a_file_to_write_to() {
        let args: Vec<String> = ["admin", "newsletter-export", "--env", "dev", "--out", "a.csv"]
            .map(String::from)
            .to_vec();
        assert_eq!(out_path(&args).unwrap().to_str(), Some("a.csv"));
        assert!(out_path(&args[..4]).is_err());
    }

    #[test]
    fn quotes_only_what_needs_it() {
        assert_eq!(field("a@example.com"), "a@example.com");
        assert_eq!(field("a,b\"c"), "\"a,b\"\"c\"");
    }

    #[test]
    fn writes_a_subscriber_and_refuses_a_partial_one() {
        let whole = json!({
            "email": "a@example.com",
            "confirmed_at": 7,
            "unsubscribe_url": "https://x.test/updates/unsubscribe?token=1.ab",
        });
        assert_eq!(
            line(&whole).unwrap(),
            "a@example.com,7,https://x.test/updates/unsubscribe?token=1.ab"
        );
        assert!(line(&json!({"email": "a@example.com"})).is_err());
    }
}
