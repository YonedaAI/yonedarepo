//! `yoneda-local credential get`: Git's credential helper for the service's loopback origin.
//! It reads Git's request on stdin and answers the local token only for this clone's own
//! host and port, so the token never sits in a URL, an argument or Git's config.
use crate::layout::Layout;
use std::io::Read;
use std::path::Path;
use yoneda_core::Result;

pub fn answer(cwd: &Path, action: &str) -> Result<String> {
    let mut request = String::new();
    let _ = std::io::stdin().read_to_string(&mut request);
    if action != "get" {
        return Ok(String::new());
    }
    let layout = Layout::find(cwd)?;
    let config = layout.config()?;
    let field = |name: &str| {
        request
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}=")))
            .unwrap_or_default()
            .to_owned()
    };
    let ours = field("protocol") == "http" && field("host") == format!("127.0.0.1:{}", config.port);
    if !ours {
        return Ok(String::new());
    }
    Ok(format!(
        "username=local\npassword={}\n",
        layout.read_token()?
    ))
}
