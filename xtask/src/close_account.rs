//! `admin close-account --env <env> --account <name> --dry-run|--confirm`: deletes one account,
//! as its owner would from Settings, through the deployed platform's
//! `POST /api/v1/admin/accounts/<name>/close` as the owner. The same refusals apply, and a run
//! that died is finished by running it again. `--dry-run` says what would go and what refuses.
//! There is no undo: its repositories can't be restored, and its name is free at once.
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Map, Value, json};
use std::time::Duration;

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let at = args.iter().position(|a| a == name)?;
    args.get(at + 1).map(String::as_str)
}

/// The request's body: a dry run names nothing to confirm.
fn body(account: &str, confirm: bool) -> Value {
    let mut asked = Map::new();
    if confirm {
        asked.insert("confirm".into(), json!(account));
    }
    Value::Object(asked)
}

/// The account as a URL's path segment: a name may be an address.
fn segment(account: &str) -> String {
    account
        .replace('%', "%25")
        .replace('@', "%40")
        .replace('/', "%2F")
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let usage =
        "cargo xtask admin close-account --env dev|prod --account <name> --dry-run|--confirm";
    let account = option(args, "--account").ok_or(usage)?;
    let (dry_run, confirm) = (
        args.iter().any(|a| a == "--dry-run"),
        args.iter().any(|a| a == "--confirm"),
    );
    if dry_run == confirm {
        return Err(usage.into());
    }
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(600))?;
    let url = format!("{origin}/api/v1/admin/accounts/{}/close", segment(account));
    let response = client
        .post(url)
        .bearer_auth(&owner)
        .json(&body(account, confirm))
        .send()
        .await?;
    let status = response.status();
    let answer: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("{account}: HTTP {status}: {answer}").into());
    }
    println!("{answer}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{body, segment};
    use serde_json::json;

    #[test]
    fn only_confirm_names_the_account() {
        assert_eq!(body("ada", false), json!({}));
        assert_eq!(body("ada", true), json!({"confirm":"ada"}));
    }

    #[test]
    fn an_address_fits_in_a_path() {
        assert_eq!(segment("ada@example.com"), "ada%40example.com");
    }
}
