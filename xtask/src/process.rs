use std::process::Command;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status()?;
    if !status.success() {
        return Err(format!("{program} {} failed ({status})", args.join(" ")).into());
    }
    Ok(())
}
pub fn ensure_token() -> Result<()> {
    crate::local_config::ensure(std::path::Path::new("."))
}
