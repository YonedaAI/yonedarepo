//! `yoneda-local credential get`: Git's credential helper for the service's loopback origin.
//! It reads Git's request on stdin and answers the local token only for this clone's own
//! host and port, so the token never sits in a URL, an argument or Git's config.
use crate::layout::Layout;
use std::io::Read;
use std::path::Path;
use yoneda_core::Result;

pub fn answer(cwd: &Path, action: &str, cloud_action: &str) -> Result<String> {
    let mut request = String::new();
    let _ = std::io::stdin().read_to_string(&mut request);
    let field = |name: &str| {
        request
            .lines()
            .find_map(|l| l.strip_prefix(&format!("{name}=")))
            .unwrap_or_default()
            .to_owned()
    };
    if action == "cloud" {
        return Ok(cloud(cloud_action, &field("protocol"), &field("host")));
    }
    if action != "get" {
        return Ok(String::new());
    }
    let layout = Layout::find(cwd)?;
    let config = layout.config()?;
    let ours = field("protocol") == "http" && field("host") == format!("127.0.0.1:{}", config.port);
    if !ours {
        return Ok(String::new());
    }
    Ok(format!(
        "username=local\npassword={}\n",
        layout.read_token()?
    ))
}

/// The cloud credential, only for the origin sync named and only on `get`.
fn cloud(action: &str, protocol: &str, host: &str) -> String {
    let Ok(origin) = std::env::var(crate::cloud::CLOUD_ENV) else {
        return String::new();
    };
    if action != "get" || origin != format!("{protocol}://{host}") {
        return String::new();
    }
    crate::cloud::token_for(&origin)
        .map(|t| format!("username=yoneda\npassword={t}\n"))
        .unwrap_or_default()
}
