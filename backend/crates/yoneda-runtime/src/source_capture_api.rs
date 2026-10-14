//! Root-only, current-capture Source API client; no producer grant or source bytes in job JSON.
use crate::source_capture_context::CaptureContext;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(crate) const PAGE_BYTES: usize = 1024 * 1024;
pub(crate) struct CaptureApi {
    origin: String,
    client: reqwest::Client,
}
impl CaptureApi {
    pub fn from_root() -> Result<Self> {
        let token = std::env::var("SUPERVISOR_TOKEN")
            .map_err(|_| failure("Root capture authorization unavailable"))?;
        Self::new("http://source.yoneda.internal", &token)
    }
    pub fn new(origin: &str, token: &str) -> Result<Self> {
        let url =
            reqwest::Url::parse(origin).map_err(|_| failure("Invalid root source endpoint"))?;
        if token.is_empty()
            || url.scheme() != "http"
            || !matches!(
                url.host_str(),
                Some("source.yoneda.internal" | "127.0.0.1" | "localhost")
            )
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(failure("Source root endpoint is outside capture transport"));
        }
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| failure("Invalid root source authorization"))?;
        authorization.set_sensitive(true);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::AUTHORIZATION, authorization);
        let client = reqwest::Client::builder()
            .no_proxy()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| failure("Source capture client unavailable"))?;
        Ok(Self {
            origin: origin.trim_end_matches('/').into(),
            client,
        })
    }
    pub async fn request(&self, op: &str, args: Value) -> Result<reqwest::Response> {
        if !["context", "manifest", "tree", "blob", "verify"].contains(&op) {
            return Err(failure("Unsupported root capture operation"));
        }
        let response = self
            .client
            .post(format!("{}/v1/capture/{op}", self.origin))
            .json(&args)
            .send()
            .await
            .map_err(|_| failure("Source capture request interrupted"))?;
        if !response.status().is_success() {
            return Err(failure(
                "Source capture request was not authorized or available",
            ));
        }
        Ok(response)
    }
    pub async fn json(&self, op: &str, args: Value) -> Result<Value> {
        let bytes = bounded(self.request(op, args).await?, PAGE_BYTES).await?;
        serde_json::from_slice(&bytes).map_err(|_| failure("Invalid source capture metadata JSON"))
    }
    pub async fn context(&self) -> Result<CaptureContext> {
        CaptureContext::decode(self.json("context", json!({})).await?)
    }
    pub async fn manifest(&self, context: &CaptureContext, kind: &str) -> Result<Vec<Value>> {
        if !["changes", "overrides"].contains(&kind) {
            return Err(failure("Invalid sealed manifest section"));
        }
        let mut cursor: Option<String> = None;
        let mut items = Vec::new();
        let mut size = 0usize;
        loop {
            let page = self
                .json("manifest", json!({"kind":kind,"cursor":cursor,"limit":200}))
                .await?;
            let rows = crate::source_capture_manifest::page_items(
                &page,
                &context.digest,
                cursor.as_deref(),
            )?;
            size = size
                .checked_add(
                    serde_json::to_vec(&rows)
                        .map_err(|_| failure("Manifest page encoding failed"))?
                        .len(),
                )
                .filter(|size| *size <= crate::source_capture_manifest::MANIFEST_METADATA_LIMIT)
                .ok_or_else(|| failure("Sealed manifest exceeds bounded metadata assembly"))?;
            if items.len() + rows.len() > yoneda_core::source_workspace::MAX_FILES {
                return Err(failure("Sealed manifest exceeds source row capability"));
            }
            items.extend(rows);
            cursor = page["next_cursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(items)
    }
}
pub(crate) fn failure(message: &str) -> Error {
    Error::new("SOURCE_CAPTURE", message)
}
pub(crate) async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response.headers().contains_key("content-encoding") {
        return Err(failure("Encoded capture content is unsupported"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure("Capture content stream interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(failure("Capture response exceeds its bound"));
        }
        bytes.extend(chunk);
    }
    Ok(bytes)
}
