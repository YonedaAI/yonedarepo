//! Incremental receive-pack through the scoped Worker Git proxy; no Git fetch.
use crate::source_git_protocol::{
    advertisement_input, advertisement_ref, command_input, command_ref, successful_input_report,
    successful_ref_report,
};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
};
use std::{io, path::Path, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub(crate) struct SourceGitHttp {
    remote: String,
    client: Client,
}
#[derive(Debug)]
pub(crate) struct RefReadback {
    pub recovered_ack: bool,
    pub uploaded: bool,
}
impl SourceGitHttp {
    pub fn new(remote: &str, authorization: Option<&str>) -> io::Result<Self> {
        let url = Url::parse(remote).map_err(|_| io::Error::other("Invalid scoped Git proxy"))?;
        let internal = url.host_str().is_some_and(|host| {
            matches!(
                host,
                "127.0.0.1" | "localhost" | "[::1]" | "git.yoneda.internal"
            )
        });
        if !(url.scheme() == "https" || url.scheme() == "http" && internal)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(io::Error::other(
                "Git proxy URL is outside trusted transport constraints",
            ));
        }
        let mut headers = HeaderMap::new();
        if let Some(value) = authorization {
            let mut value = HeaderValue::from_str(value)
                .map_err(|_| io::Error::other("Invalid private Git authorization"))?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        let client = Client::builder()
            .no_proxy()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| io::Error::other("Git proxy client unavailable"))?;
        Ok(Self {
            remote: remote.trim_end_matches('/').into(),
            client,
        })
    }

    async fn head(&self, reference: &str, is_input: bool) -> io::Result<String> {
        let response = self
            .client
            .get(format!(
                "{}/info/refs?service=git-receive-pack",
                self.remote
            ))
            .header("cache-control", "no-cache")
            .send()
            .await
            .map_err(|_| io::Error::other("Git proxy discovery unavailable"))?;
        if response.status() != 200
            || media_type(&response) != "application/x-git-receive-pack-advertisement"
        {
            return Err(io::Error::other("Git proxy refused smart ref discovery"));
        }
        let bytes = bounded_response(response).await?;
        if is_input {
            advertisement_input(&bytes, reference)
        } else {
            advertisement_ref(&bytes, reference)
        }
    }

    #[cfg(test)]
    pub async fn push(
        &self,
        old: &str,
        new: &str,
        pack: &Path,
        max_bytes: u64,
    ) -> io::Result<RefReadback> {
        self.push_ref("refs/heads/main", old, new, pack, max_bytes)
            .await
    }

    /// Ref readback alone is not capture authority: caller must verify exact remote tree and ordered parents.
    pub async fn push_ref(
        &self,
        reference: &str,
        old: &str,
        new: &str,
        pack: &Path,
        max_bytes: u64,
    ) -> io::Result<RefReadback> {
        self.push_target(reference, old, new, pack, max_bytes, false)
            .await
    }
    /// Root-only closure preload: an exact private job hash ref, create-only expected-old zero.
    pub async fn push_input_ref(
        &self,
        reference: &str,
        new: &str,
        pack: &Path,
        max_bytes: u64,
    ) -> io::Result<RefReadback> {
        self.push_target(reference, &"0".repeat(40), new, pack, max_bytes, true)
            .await
    }
    async fn push_target(
        &self,
        reference: &str,
        old: &str,
        new: &str,
        pack: &Path,
        max_bytes: u64,
        is_input: bool,
    ) -> io::Result<RefReadback> {
        let prefix = if is_input {
            command_input(reference, new)?
        } else {
            command_ref(reference, old, new)?
        };
        let head = self.head(reference, is_input).await?;
        if head == new {
            return Ok(RefReadback {
                recovered_ack: true,
                uploaded: false,
            });
        }
        if head != old {
            return Err(io::Error::other(
                "Git capture fork differs from frozen expected fork head",
            ));
        }
        let metadata = tokio::fs::symlink_metadata(pack).await?;
        if !metadata.file_type().is_file() || metadata.len() > max_bytes || metadata.len() < 32 {
            return Err(io::Error::other(
                "Explicit pack is outside frozen size capability",
            ));
        }
        let request = pack.with_extension("receive.request");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut body = options.open(&request).await?;
        body.write_all(&prefix).await?;
        let mut input = tokio::fs::File::open(pack).await?.take(metadata.len() + 1);
        let copied = tokio::io::copy(&mut input, &mut body).await?;
        body.flush().await?;
        drop(body);
        if copied != metadata.len() {
            tokio::fs::remove_file(&request).await?;
            return Err(io::Error::other(
                "Explicit pack changed during request construction",
            ));
        }
        let input = tokio::fs::File::open(&request).await?;
        let response = self
            .client
            .post(format!("{}/git-receive-pack", self.remote))
            .header("content-type", "application/x-git-receive-pack-request")
            .header("content-length", prefix.len() as u64 + metadata.len())
            .header("cache-control", "no-cache")
            .body(reqwest::Body::from(input))
            .send()
            .await;
        let acknowledged = match response {
            Ok(response)
                if response.status() == 200
                    && media_type(&response) == "application/x-git-receive-pack-result" =>
            {
                bounded_response(response).await.is_ok_and(|bytes| {
                    if is_input {
                        successful_input_report(&bytes, reference).is_ok()
                    } else {
                        successful_ref_report(&bytes, reference).is_ok()
                    }
                })
            }
            _ => false,
        };
        tokio::fs::remove_file(&request).await?;
        if self.head(reference, is_input).await? != new {
            return Err(io::Error::other("Git proxy capture ref readback differs"));
        }
        Ok(RefReadback {
            recovered_ack: !acknowledged,
            uploaded: true,
        })
    }
}

fn media_type(response: &reqwest::Response) -> &str {
    response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
}

async fn bounded_response(mut response: reqwest::Response) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| io::Error::other("Git metadata response interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > 1024 * 1024 {
            return Err(io::Error::other("Git metadata response exceeds bound"));
        }
        bytes.extend(chunk);
    }
    Ok(bytes)
}
