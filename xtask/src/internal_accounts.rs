//! `admin internal --env <env> [--off] <account>...`: flags accounts as ours, so they stay out of
//! every figure from then on, through the deployed platform's `POST /api/v1/admin/accounts/<a>/
//! internal` as the owner. Audited per account. Repeating it changes nothing. A flag reaches
//! every isolate within ten minutes.
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

/// The account names on the command line: everything that isn't a flag or a flag's value.
fn accounts(args: &[String]) -> Vec<&str> {
    let mut named = Vec::new();
    let mut rest = args.iter().skip(2);
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--env" => {
                rest.next();
            }
            "--off" => {}
            name => named.push(name),
        }
    }
    named
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let names = accounts(args);
    if names.is_empty() {
        return Err("cargo xtask admin internal --env dev|prod [--off] <account>...".into());
    }
    let internal = !args.iter().any(|a| a == "--off");
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(30))?;
    for name in names {
        let response = client
            .post(format!("{origin}/api/v1/admin/accounts/{name}/internal"))
            .bearer_auth(&owner)
            .json(&json!({ "internal": internal }))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("{name}: HTTP {status}: {body}").into());
        }
        println!("{name}: internal = {internal}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::accounts;

    #[test]
    fn takes_every_name_but_no_flag_or_flag_value() {
        let args: Vec<String> = [
            "admin", "internal", "--env", "dev", "--off", "team", "tester",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(accounts(&args), ["team", "tester"]);
    }
}
