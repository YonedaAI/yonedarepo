//! Opaque candidate-minus-base closure, bounded on the wire; no clone, index, checkout or Git fetch.
use crate::{
    source_capture_api::{PAGE_BYTES, bounded},
    source_refresh_plan::error,
    source_refresh_protocol::{acknowledged_prefix, request},
};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use yoneda_agents_core::Result;
pub(crate) struct Upload {
    remote: String,
    client: reqwest::Client,
}
impl Upload {
    pub fn new(remote: &str, authorization: Option<&str>) -> Result<Self> {
        let url =
            reqwest::Url::parse(remote).map_err(|_| error("Invalid scoped upload-pack origin"))?;
        if !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(
                    url.host_str(),
                    Some("git.yoneda.internal" | "localhost" | "127.0.0.1")
                ))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(error("Upload-pack origin outside trusted scope"));
        }
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(value) = authorization {
            let mut value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| error("Invalid private upload-pack authorization"))?;
            value.set_sensitive(true);
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| error("Scoped upload-pack client unavailable"))?;
        Ok(Self {
            remote: remote.trim_end_matches('/').into(),
            client,
        })
    }
    pub async fn difference(
        &self,
        candidate: &str,
        base: &str,
        destination: &Path,
        limit: u64,
    ) -> Result<()> {
        let response = self
            .client
            .get(format!("{}/info/refs?service=git-upload-pack", self.remote))
            .header("cache-control", "no-cache")
            .send()
            .await
            .map_err(|_| error("Source Git discovery interrupted"))?;
        media(&response, "application/x-git-upload-pack-advertisement")?;
        let body = request(&bounded(response, PAGE_BYTES).await?, candidate, base)?;
        let mut response = self
            .client
            .post(format!("{}/git-upload-pack", self.remote))
            .header("content-type", "application/x-git-upload-pack-request")
            .header("cache-control", "no-cache")
            .body(body)
            .send()
            .await
            .map_err(|_| error("Candidate closure negotiation interrupted"))?;
        media(&response, "application/x-git-upload-pack-result")?;
        let mut prefix = Vec::new();
        let mut output = None;
        let mut total = 0u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("Candidate closure stream interrupted"))?
        {
            if output.is_none() {
                if prefix.len().saturating_add(chunk.len()) as u64 > limit + 65536 {
                    return Err(error("Negotiated closure exceeds bound"));
                }
                prefix.extend(chunk);
                let Some(start) = acknowledged_prefix(&prefix, base)? else {
                    continue;
                };
                let mut options = tokio::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                options.mode(0o600);
                let mut file = options
                    .open(destination)
                    .await
                    .map_err(|_| error("Private closure spool unavailable"))?;
                total = (prefix.len() - start) as u64;
                if total > limit {
                    return Err(error("Candidate difference pack exceeds capability"));
                }
                file.write_all(&prefix[start..])
                    .await
                    .map_err(|_| error("Closure spool write failed"))?;
                output = Some(file);
                prefix.clear();
            } else {
                total = total
                    .checked_add(chunk.len() as u64)
                    .filter(|n| *n <= limit)
                    .ok_or_else(|| error("Candidate difference pack exceeds capability"))?;
                output
                    .as_mut()
                    .ok_or_else(|| error("Closure spool missing"))?
                    .write_all(&chunk)
                    .await
                    .map_err(|_| error("Closure spool write failed"))?;
            }
        }
        if total < 32 {
            return Err(error(
                "Candidate closure missing exact base ACK or complete pack",
            ));
        }
        output
            .as_mut()
            .ok_or_else(|| error("Exact base ACK missing"))?
            .flush()
            .await
            .map_err(|_| error("Closure spool flush failed"))?;
        Ok(())
    }
}
fn media(response: &reqwest::Response, expected: &str) -> Result<()> {
    if response.status() != 200
        || response.headers().contains_key("content-encoding")
        || response
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.split(';').next())
            != Some(expected)
    {
        return Err(error("Source refused raw smart Git negotiation"));
    }
    Ok(())
}
