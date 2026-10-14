//! Current root refresh lease only; fixed input aliases, no arbitrary repository/hash selectors.
use crate::{
    source_capture_api::{PAGE_BYTES, bounded},
    source_refresh_plan::error,
};
use serde_json::{Value, json};
use yoneda_core::{Result, source_workspace::SourceRevision};
pub(crate) struct Api {
    origin: String,
    client: reqwest::Client,
}
pub(crate) struct Context {
    pub base: SourceRevision,
    pub head: SourceRevision,
    pub candidate: SourceRevision,
    pub declared: Vec<String>,
    pub declared_ref: Option<Value>,
    pub candidate_parents: Vec<String>,
    pub version: i64,
    pub branch: String,
    pub expected_head: String,
}
impl Api {
    pub fn new(origin: &str, token: &str) -> Result<Self> {
        let url = reqwest::Url::parse(origin).map_err(|_| error("Invalid refresh root origin"))?;
        if token.is_empty()
            || url.scheme() != "http"
            || !matches!(
                url.host_str(),
                Some("source.yoneda.internal" | "127.0.0.1" | "localhost")
            )
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(error("Refresh root origin outside trusted transport"));
        }
        let mut auth = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| error("Invalid private refresh authorization"))?;
        auth.set_sensitive(true);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::AUTHORIZATION, auth);
        let client = reqwest::Client::builder()
            .no_proxy()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| error("Refresh root client unavailable"))?;
        Ok(Self {
            origin: origin.trim_end_matches('/').into(),
            client,
        })
    }
    pub async fn request(&self, op: &str, args: Value) -> Result<reqwest::Response> {
        if !["context", "tree", "blob", "verify", "verify_input", "paths"].contains(&op) {
            return Err(error("Unsupported refresh operation"));
        }
        let response = self
            .client
            .post(format!("{}/v1/refresh/{op}", self.origin))
            .json(&args)
            .send()
            .await
            .map_err(|_| error("Refresh root transport interrupted"))?;
        if !response.status().is_success() {
            return Err(error("Refresh root request unavailable or fenced"));
        }
        Ok(response)
    }
    pub async fn json(&self, op: &str, args: Value) -> Result<Value> {
        serde_json::from_slice(&bounded(self.request(op, args).await?, PAGE_BYTES).await?)
            .map_err(|_| error("Invalid refresh metadata JSON"))
    }
    pub async fn context(&self) -> Result<Context> {
        let mut context = Context::decode(self.json("context", json!({})).await?)?;
        if let Some(reference) = &context.declared_ref {
            context.declared = self.paths(reference).await?;
        }
        Ok(context)
    }
    async fn paths(&self, reference: &Value) -> Result<Vec<String>> {
        let mut after = Value::Null;
        let mut paths = Vec::new();
        loop {
            let page = self
                .json(
                    "paths",
                    json!({"after":after,"limit":200,"expectedDigest":reference["digest"]}),
                )
                .await?;
            if page["version"] != 1
                || page["digest"] != reference["digest"]
                || page["total"] != reference["count"]
                || page["paths_ref"] != *reference
            {
                return Err(error("Refresh path page differs from pinned reservation"));
            }
            let rows = page["items"]
                .as_array()
                .filter(|v| v.len() <= 200)
                .ok_or_else(|| error("Refresh path page exceeds bound"))?;
            let mut previous = after.as_str().unwrap_or("").to_owned();
            for path in rows {
                let path = path
                    .as_str()
                    .ok_or_else(|| error("Invalid refresh scope entry"))?;
                yoneda_core::validate_path(path.strip_suffix('/').unwrap_or(path))?;
                if path <= previous.as_str() {
                    return Err(error("Refresh path page repeats or reverses cursor"));
                }
                paths.push(path.to_owned());
                previous = path.into();
                if paths.len() > 20000 {
                    return Err(error("Refresh scopes exceed path bound"));
                }
            }
            match page["has_more"].as_bool() {
                Some(true)
                    if !rows.is_empty()
                        && page["next_cursor"].as_str() == Some(previous.as_str()) =>
                {
                    after = json!(previous)
                }
                Some(false) if page["next_cursor"].is_null() => break,
                _ => return Err(error("Refresh pinned path cursor did not advance")),
            }
        }
        if json!(paths.len()) != reference["count"]
            || yoneda_core::fingerprint(&json!(paths))?
                != reference["digest"]
                    .as_str()
                    .ok_or_else(|| error("Refresh path digest missing"))?
        {
            return Err(error(
                "Assembled refresh paths differ from frozen digest/count",
            ));
        }
        Ok(paths)
    }
}
impl Context {
    pub fn decode(value: Value) -> Result<Self> {
        if value["version"] != 1 {
            return Err(error("Invalid refresh context version"));
        }
        let revision = |key: &str| -> Result<SourceRevision> {
            let r: SourceRevision = serde_json::from_value(value[key].clone())
                .map_err(|_| error("Invalid frozen refresh revision"))?;
            if r.repository.is_empty() {
                return Err(error("Refresh repository missing"));
            }
            for oid in [&r.commit, &r.tree] {
                crate::source_git_tree::validate_oid(oid)
                    .map_err(|_| error("Refresh requires SHA-1 Git objects"))?;
            }
            Ok(r)
        };
        let base = revision("base")?;
        let head = revision("head")?;
        let candidate = revision("candidate")?;
        let parents: Vec<String> = serde_json::from_value(value["candidateParents"].clone())
            .map_err(|_| error("Frozen candidate parents missing"))?;
        if !(1..=2).contains(&parents.len())
            || parents.first() != Some(&base.commit)
            || head.commit == candidate.commit
            || parents
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != parents.len()
        {
            return Err(error("Candidate does not retain the reserved base parent"));
        }
        for oid in &parents {
            crate::source_git_tree::validate_oid(oid)
                .map_err(|_| error("Invalid candidate parent"))?;
        }
        let declared_ref = value
            .get("declaredPathsRef")
            .filter(|v| !v.is_null())
            .cloned();
        let declared = if let Some(reference) = &declared_ref {
            let digest = reference["digest"]
                .as_str()
                .ok_or_else(|| error("Refresh compact path digest missing"))?;
            yoneda_core::source_workspace::validate_hash(digest, &[64])?;
            if reference["version"] != 1
                || reference["id"] != format!("paths:{digest}")
                || reference["count"]
                    .as_u64()
                    .is_none_or(|v| v == 0 || v > 20000)
                || value.get("declaredPaths").is_some_and(|v| !v.is_null())
            {
                return Err(error("Invalid compact refresh scope reference"));
            }
            Vec::new()
        } else {
            serde_json::from_value(value["declaredPaths"].clone())
                .map_err(|_| error("Declared refresh paths missing"))?
        };
        let version = value["targetVersion"]
            .as_i64()
            .filter(|v| *v >= 0)
            .ok_or_else(|| error("Frozen head version missing"))?;
        let branch = value["source_capture_ref"]["branch"]
            .as_str()
            .ok_or_else(|| error("Assigned refresh branch missing"))?
            .to_owned();
        crate::source_git_protocol::validate_ref(&format!("refs/heads/{branch}"))
            .map_err(|_| error("Invalid assigned refresh branch"))?;
        let expected_head = value["source_capture_ref"]["expected_head"]
            .as_str()
            .ok_or_else(|| error("Assigned fork lease missing"))?
            .to_owned();
        crate::source_git_tree::validate_oid(&expected_head)
            .map_err(|_| error("Invalid assigned fork expected head"))?;
        Ok(Self {
            base,
            head,
            candidate,
            declared,
            declared_ref,
            candidate_parents: parents,
            version,
            branch,
            expected_head,
        })
    }
}
