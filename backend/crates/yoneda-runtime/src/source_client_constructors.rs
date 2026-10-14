//! Frozen mount construction separates model-free root transport from ordinary MCP.
use super::{ApiSourceClient, http::SourceHttp};
use crate::source_client::failure;
use std::sync::Arc;
use yoneda_core::Result;
impl ApiSourceClient {
    /// Identities here come only from the trusted job.source_mounts descriptor.
    pub fn new(
        alias: &str,
        workspace: &str,
        view_digest: &str,
        read_only: bool,
    ) -> Result<Arc<Self>> {
        let client = Arc::new(Self {
            http: SourceHttp::new(alias)?,
            expected_workspace: workspace.into(),
            expected_view: view_digest.into(),
            read_only,
        });
        client.status()?;
        Ok(client)
    }
    pub fn root(
        alias: &str,
        workspace: &str,
        view_digest: &str,
        read_only: bool,
        supervisor: &str,
    ) -> Result<Arc<Self>> {
        if supervisor.is_empty() {
            return Err(failure(
                "FORBIDDEN",
                "Root source supervisor authorization missing",
            ));
        }
        let client = Arc::new(Self {
            http: SourceHttp::root(alias, supervisor)?,
            expected_workspace: workspace.into(),
            expected_view: view_digest.into(),
            read_only,
        });
        client.status()?;
        Ok(client)
    }
    #[cfg(test)]
    pub fn test_at(
        origin: &str,
        alias: &str,
        workspace: &str,
        view: &str,
        read_only: bool,
    ) -> Result<Arc<Self>> {
        let client = Arc::new(Self {
            http: SourceHttp::at(origin, alias)?,
            expected_workspace: workspace.into(),
            expected_view: view.into(),
            read_only,
        });
        client.status()?;
        Ok(client)
    }
    #[cfg(test)]
    pub fn test_root_at(
        origin: &str,
        alias: &str,
        workspace: &str,
        view: &str,
        read_only: bool,
        token: &str,
    ) -> Result<Arc<Self>> {
        let client = Arc::new(Self {
            http: SourceHttp::test_root_at(origin, alias, token)?,
            expected_workspace: workspace.into(),
            expected_view: view.into(),
            read_only,
        });
        client.status()?;
        Ok(client)
    }
}
