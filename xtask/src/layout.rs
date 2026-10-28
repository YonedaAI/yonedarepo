//! Paths are relative to the workspace root, including persistent local state.
use std::path::{Path, PathBuf};

pub(crate) const PLATFORM_CONFIG: &str = "cloudflare/wrangler.jsonc";
pub(crate) const DEV_VARS: &str = "cloudflare/.dev.vars";
pub(crate) const FRONTEND: &str = "frontend";
pub(crate) const WORKER_CRATE: &str = "backend/crates/yoneda-worker";

pub(crate) struct DevelopmentPaths {
    pub platform: PathBuf,
    pub state: PathBuf,
}
impl DevelopmentPaths {
    pub fn new(deployment: Option<&Path>) -> Self {
        match deployment {
            Some(dir) => Self {
                platform: dir.join("platform.json"),
                state: dir.join("state"),
            },
            None => Self {
                platform: PLATFORM_CONFIG.into(),
                state: ".wrangler/state".into(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_relocation_does_not_relocate_default_or_named_state() {
        let default = DevelopmentPaths::new(None);
        assert_eq!(default.platform, Path::new("cloudflare/wrangler.jsonc"));
        assert_eq!(default.state, Path::new(".wrangler/state"));
        let named = DevelopmentPaths::new(Some(Path::new(".local/deploy/production")));
        assert_eq!(
            named.platform,
            Path::new(".local/deploy/production/platform.json")
        );
        assert_eq!(named.state, Path::new(".local/deploy/production/state"));
    }
}
