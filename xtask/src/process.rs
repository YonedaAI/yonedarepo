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
    std::fs::create_dir_all(".local")?;
    if !std::path::Path::new(".local/owner-token").exists() {
        let value = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        std::fs::write(".local/owner-token", &value)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(".local/owner-token", std::fs::Permissions::from_mode(0o600))?;
        }
    }
    let value = token()?;
    if !std::path::Path::new(".dev.vars").exists() {
        std::fs::write(".dev.vars", format!("OWNER_TOKEN={value}\n"))?;
    }
    let mut vars = std::fs::read_to_string(".dev.vars")?;
    if !std::path::Path::new(".local/vault-key").exists() {
        let existing = vars
            .lines()
            .find_map(|line| line.strip_prefix("VAULT_KEY="));
        let key = existing.map(str::to_owned).unwrap_or_else(|| {
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
        });
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("VAULT_KEY must contain 64 hexadecimal characters".into());
        }
        std::fs::write(".local/vault-key", key)?;
    }
    if !vars.lines().any(|line| line.starts_with("VAULT_KEY=")) {
        if !vars.ends_with('\n') {
            vars.push('\n');
        }
        vars.push_str(&format!(
            "VAULT_KEY={}\n",
            std::fs::read_to_string(".local/vault-key")?.trim()
        ));
        std::fs::write(".dev.vars", vars)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [".local/owner-token", ".local/vault-key", ".dev.vars"] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(())
}
pub fn deploy_token() -> Result<()> {
    put_secret("OWNER_TOKEN", &token()?)?;
    let existing = Command::new("pnpm")
        .args(["exec", "wrangler", "secret", "list", "--format", "json"])
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
        .args(["exec", "wrangler", "secret", "put", name])
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
