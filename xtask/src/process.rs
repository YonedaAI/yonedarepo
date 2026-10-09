use std::process::{Command, Stdio};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status()?;
    if !status.success() {
        return Err(format!("{program} {} failed ({status})", args.join(" ")).into());
    }
    Ok(())
}
pub fn token() -> Result<String> {
    Ok(std::fs::read_to_string(".local/owner-token")?.trim().into())
}
pub fn ensure_token() -> Result<()> {
    crate::local_config::ensure(std::path::Path::new("."))
}
pub fn deploy_token() -> Result<()> {
    put_secret("OWNER_TOKEN", &token()?)?;
    let existing = Command::new("pnpm")
        .args([
            "exec",
            "wrangler",
            "secret",
            "list",
            "--format",
            "json",
            "--config",
            crate::layout::PLATFORM_CONFIG,
        ])
        .output()?;
    if !existing.status.success() {
        return Err("Cannot verify deployed vault key; refusing to rotate it".into());
    }
    let secrets: serde_json::Value = serde_json::from_slice(&existing.stdout)?;
    if secrets.as_array().is_none() {
        return Err("Unexpected Worker secret inventory; refusing to rotate vault key".into());
    }
    if secrets
        .as_array()
        .is_some_and(|list| list.iter().any(|secret| secret["name"] == "VAULT_KEY"))
    {
        println!("Existing deployed vault key retained.");
        return Ok(());
    }
    put_secret(
        "VAULT_KEY",
        std::fs::read_to_string(".local/vault-key")?.trim(),
    )
}
fn put_secret(name: &str, value: &str) -> Result<()> {
    let mut child = Command::new("pnpm")
        .args([
            "exec",
            "wrangler",
            "secret",
            "put",
            name,
            "--config",
            crate::layout::PLATFORM_CONFIG,
        ])
        .stdin(Stdio::piped())
        .spawn()?;
    use std::io::Write;
    child
        .stdin
        .take()
        .ok_or("Missing secret input pipe")?
        .write_all(value.as_bytes())?;
    if !child.wait()?.success() {
        return Err(format!("Could not configure {name}").into());
    }
    Ok(())
}
