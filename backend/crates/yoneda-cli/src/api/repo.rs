//! Repository operations over the API: commits, branches, landing and file reads.
use super::{Api, CommitInfo, Failure, encode, malformed, text};
use serde_json::{Value, json};

impl Api {
    /// The current log version and the branch's Git commit at it (the platform waits
    /// for landed changesets to be projected before answering).
    pub async fn branch_at_latest(
        &self,
        branch: &str,
    ) -> std::result::Result<(u64, String), Failure> {
        let refs = self.get("/refs").await?;
        let version = refs["version"]
            .as_u64()
            .ok_or_else(|| malformed("missing version"))?;
        let commit = refs["refs"][format!("refs/heads/{branch}")]
            .as_str()
            .ok_or_else(|| malformed(&format!("no branch {branch}")))?;
        Ok((version, commit.to_owned()))
    }

    pub async fn commit(&self, id: &str) -> std::result::Result<CommitInfo, Failure> {
        commit_info(&self.commit_record(id).await?)
    }

    /// A recorded commit with its message, principal and landings.
    pub async fn commit_record(&self, id: &str) -> std::result::Result<Value, Failure> {
        self.get(&format!("/commits/{id}")).await
    }

    /// Records a commit on `parent` (empty: a root commit) with extra merge parents (a local
    /// merge commit) and the files it read (`read_set`, validated when it lands). `author`
    /// may carry `time` and `tz`; with a `committer` too, the platform rebuilds the local
    /// commit exactly.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_merge_commit(
        &self,
        parent: &str,
        base_version: u64,
        changes: Vec<Value>,
        message: &str,
        author: &Value,
        committer: Option<&Value>,
        merge_parents: &[String],
        read_set: &[String],
    ) -> std::result::Result<CommitInfo, Failure> {
        let parent = Some(parent).filter(|p| !p.is_empty());
        let mut body = json!({
            "parent": parent, "base_version": base_version, "changes": changes,
            "message": message, "author": author,
        });
        if let Some(committer) = committer {
            body["committer"] = committer.clone();
        }
        if !merge_parents.is_empty() {
            body["merge_parents"] = json!(merge_parents);
        }
        if !read_set.is_empty() {
            body["read_set"] = json!(read_set);
        }
        commit_info(&self.post_idempotent("/commits", &body).await?)
    }

    /// Repository status: log version, refs table and projections (no projection wait).
    pub async fn status(&self) -> std::result::Result<Value, Failure> {
        self.get("/").await
    }

    /// A working branch's head from the refs table, or `None` when it does not exist.
    pub async fn branch_head(&self, branch: &str) -> std::result::Result<Option<String>, Failure> {
        let status = self.status().await?;
        let name = format!("refs/heads/{branch}");
        Ok(status["refs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["name"] == name.as_str())
            .and_then(|r| r["commit_id"].as_str().map(str::to_owned)))
    }

    /// Records a commit on `parent`, pinned to `base_version` for landing's path checks.
    pub async fn create_commit(
        &self,
        parent: &str,
        base_version: u64,
        changes: Vec<Value>,
        message: &str,
        author: &Value,
        committer: Option<&Value>,
    ) -> std::result::Result<CommitInfo, Failure> {
        self.create_merge_commit(
            parent,
            base_version,
            changes,
            message,
            author,
            committer,
            &[],
            &[],
        )
        .await
    }

    /// Moves a working branch by compare-and-swap on its expected old head.
    pub async fn set_branch(
        &self,
        branch: &str,
        commit: &str,
        expected: Option<&str>,
    ) -> std::result::Result<(), Failure> {
        let body = json!({ "ref": branch, "commit": commit, "expected": expected });
        self.post_idempotent("/branches", &body).await.map(|_| ())
    }

    /// Lands `commit` on `branch`; a landing still settling is submitted again.
    pub async fn land(&self, branch: &str, commit: &str) -> std::result::Result<Value, Failure> {
        let body = json!({ "ref": branch, "commit": commit });
        let mut attempt = 0;
        loop {
            match self.post_idempotent("/land", &body).await {
                Err(f) if f.code == "TIMEOUT" && attempt < 3 => attempt += 1,
                other => return other,
            }
        }
    }

    /// A file on the branch's latest version: `Ok(None)` when it does not exist.
    pub async fn file(
        &self,
        branch: &str,
        path: &str,
    ) -> std::result::Result<Option<Vec<u8>>, Failure> {
        let query = format!("/blob?ref={}&path={}", encode(branch), encode(path));
        match self.get(&query).await {
            Ok(value) => decode_file(&value).map(Some),
            Err(f) if f.code == "NOT_FOUND" => Ok(None),
            Err(f) => Err(f),
        }
    }
}

fn commit_info(value: &Value) -> std::result::Result<CommitInfo, Failure> {
    let parents = value["parents"]
        .as_array()
        .ok_or_else(|| malformed("missing parents"))?
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_owned)
                .ok_or_else(|| malformed("bad parent"))
        })
        .collect::<std::result::Result<_, _>>()?;
    Ok(CommitInfo {
        commit: text(value, "commit")?,
        tree: text(value, "tree")?,
        parents,
    })
}

fn decode_file(value: &Value) -> std::result::Result<Vec<u8>, Failure> {
    use base64::Engine;
    let content = value["content"]
        .as_str()
        .ok_or_else(|| malformed("missing content"))?;
    match value["encoding"].as_str() {
        Some("base64") => base64::engine::general_purpose::STANDARD
            .decode(content)
            .map_err(|_| malformed("bad base64 content")),
        _ => Ok(content.as_bytes().to_vec()),
    }
}
