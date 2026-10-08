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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [".local/owner-token", ".dev.vars"] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(())
}
pub fn deploy_token() -> Result<()> {
    let value = token()?;
    let mut child = Command::new("pnpm")
        .args(["exec", "wrangler", "secret", "put", "OWNER_TOKEN"])
        .stdin(Stdio::piped())
        .spawn()?;
    use std::io::Write;
    child
        .stdin
        .take()
        .ok_or("Missing secret input pipe")?
        .write_all(value.as_bytes())?;
    if !child.wait()?.success() {
        return Err("Could not configure owner authentication".into());
    }
    Ok(())
}
