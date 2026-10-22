//! Platform commits as local commits. `/objects` serves a commit as its tree and parents
//! only, so the helper builds the local commit itself: the platform's exact tree (every
//! tree and blob is fetched by id and verified), local parents for the platform parents,
//! the platform's message, and a fixed identity dated at the landing. The same platform
//! history always becomes the same local commits.
use super::map::CommitMap;
use crate::api::Api;
use crate::error::{Error, Result};
use crate::git::Git;
use crate::snapshot;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use yoneda_core::git_object::{Commit, ObjectId, ObjectKind, Signature, write_pack};

/// Commits converted per call; older history is cut there (the oldest converted commit
/// becomes a root). Contents are unaffected; `yoneda log` reads the full history.
pub const HISTORY_LIMIT: usize = 1000;
/// The identity's email on converted commits.
const EMAIL: &str = "commits@yonedarepo.invalid";

/// What the helper knows about a platform commit.
#[derive(Debug, Clone)]
pub struct Info {
    pub tree: String,
    pub parents: Vec<String>,
    pub message: Option<String>,
    pub principal: Option<String>,
    pub landed_ms: Option<i64>,
}

impl Info {
    fn from_record(value: &Value) -> Option<Self> {
        let landed = value["landed"]["landed_at"]
            .as_i64()
            .or_else(|| value["landings"][0]["landed_at"].as_i64());
        Some(Self {
            tree: value["tree"].as_str()?.to_owned(),
            parents: value["parents"]
                .as_array()?
                .iter()
                .map(|p| p.as_str().map(str::to_owned))
                .collect::<Option<_>>()?,
            message: value["message"].as_str().map(str::to_owned),
            principal: value["principal"].as_str().map(str::to_owned),
            landed_ms: landed,
        })
    }
}

/// The local commit object for platform commit `id` with local `parents`.
pub fn local_commit(id: &str, info: &Info, parents: &[String]) -> Result<Commit> {
    let name: String = info
        .principal
        .as_deref()
        .unwrap_or("YonedaRepo")
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '\n' | '\0'))
        .collect();
    let name = match name.trim() {
        "" => "YonedaRepo".to_owned(),
        trimmed => trimmed.to_owned(),
    };
    let who = Signature {
        name,
        email: EMAIL.into(),
        seconds: info.landed_ms.unwrap_or(0) / 1000,
        offset: "+0000".into(),
    };
    let message = info.message.as_deref().unwrap_or("Platform commit");
    let message = format!("{}\n\nYoneda-Commit: {id}\n", message.trim_end());
    let parse = |hex: &str| {
        ObjectId::parse(hex).map_err(|e| Error::new(format!("bad commit id {hex}: {}", e.message)))
    };
    let parents = parents
        .iter()
        .map(|p| parse(p))
        .collect::<Result<Vec<_>>>()?;
    Commit::new(parse(&info.tree)?, &parents, &who, &who, &message)
        .map_err(|e| Error::new(format!("building the local commit for {id}: {}", e.message)))
}

pub struct Converter<'a> {
    pub api: &'a Api,
    pub git: &'a Git,
    pub map: &'a mut CommitMap,
    cache: HashMap<String, Info>,
}

impl<'a> Converter<'a> {
    pub fn new(api: &'a Api, git: &'a Git, map: &'a mut CommitMap) -> Self {
        Self {
            api,
            git,
            map,
            cache: HashMap::new(),
        }
    }

    /// Fills the cache from a branch's log (one request for up to 200 commits).
    async fn prefetch(&mut self, branch: &str) {
        let path = format!("/log?ref={}&limit=200", crate::api::encode(branch));
        if let Ok(log) = self.api.get(&path).await {
            for entry in log["commits"].as_array().into_iter().flatten() {
                if let (Some(id), Some(info)) = (entry["commit"].as_str(), Info::from_record(entry))
                {
                    self.cache.insert(id.to_owned(), info);
                }
            }
        }
    }

    pub async fn info(&mut self, id: &str) -> Result<Info> {
        if let Some(info) = self.cache.get(id) {
            return Ok(info.clone());
        }
        let info = match self.api.commit_record(id).await {
            Ok(value) => Info::from_record(&value)
                .ok_or_else(|| Error::new(format!("unexpected record for commit {id}")))?,
            // Imported history has no platform record: its object still names tree and parents.
            Err(f) if f.code == "NOT_FOUND" => {
                let shape = snapshot::commit_shapes(self.api, &[id.to_owned()])
                    .await?
                    .pop()
                    .ok_or_else(|| Error::new(format!("the platform has no commit {id}")))?;
                Info {
                    tree: shape.tree,
                    parents: shape.parents,
                    message: None,
                    principal: None,
                    landed_ms: None,
                }
            }
            Err(f) => return Err(Error::new(format!("reading commit {id}: {f}"))),
        };
        self.cache.insert(id.to_owned(), info.clone());
        Ok(info)
    }

    /// The local commit for platform commit `head`, converting its unmapped ancestry.
    /// `branch` names a branch at `head` (for a faster history read); `version` > 0
    /// records `head` as main's head at that version.
    pub async fn convert(
        &mut self,
        head: &str,
        branch: Option<&str>,
        version: u64,
    ) -> Result<String> {
        if let Some(local) = self.map.local(head).map(str::to_owned) {
            if version > self.map.version(head) {
                self.map
                    .record(&[(head.to_owned(), local.clone(), version)])?;
            }
            return Ok(local);
        }
        if let Some(branch) = branch {
            self.prefetch(branch).await;
        }
        let order = self.ancestry(head).await?;
        let trees: Vec<String> = order.iter().map(|(_, info)| info.tree.clone()).collect();
        snapshot::fetch_trees(self.api, self.git, &trees).await?;
        let mut built: HashMap<String, String> = HashMap::new();
        let mut objects = Vec::new();
        for (id, info) in &order {
            let parents: Vec<String> = info
                .parents
                .iter()
                .filter_map(|p| {
                    built
                        .get(p)
                        .cloned()
                        .or_else(|| self.map.local(p).map(str::to_owned))
                })
                .collect();
            let commit = local_commit(id, info, &parents)?;
            built.insert(id.clone(), commit.id().hex());
            objects.push(commit.encode());
        }
        self.write(&objects)?;
        let entries: Vec<(String, String, u64)> = order
            .iter()
            .map(|(id, _)| {
                let v = if id == head { version } else { 0 };
                (id.clone(), built[id].clone(), v)
            })
            .collect();
        self.map.record(&entries)?;
        Ok(built[head].clone())
    }

    /// Unmapped commits reachable from `head`, parents before children, cut at
    /// [`HISTORY_LIMIT`] commits.
    async fn ancestry(&mut self, head: &str) -> Result<Vec<(String, Info)>> {
        let mut order = Vec::new();
        let mut seen = HashSet::from([head.to_owned()]);
        let mut stack = vec![(head.to_owned(), None::<Info>)];
        let mut expanded = 0usize;
        while let Some((id, info)) = stack.pop() {
            if let Some(info) = info {
                order.push((id, info));
                continue;
            }
            let mut info = self.info(&id).await?;
            expanded += 1;
            if expanded >= HISTORY_LIMIT {
                info.parents.retain(|p| self.map.local(p).is_some());
            }
            let parents = info.parents.clone();
            stack.push((id, Some(info)));
            for parent in parents.iter().rev() {
                if self.map.local(parent).is_none() && seen.insert(parent.clone()) {
                    stack.push((parent.clone(), None));
                }
            }
        }
        Ok(order)
    }

    /// Records platform commit `head` (a landing that merged `ours` with concurrent
    /// work) as a local merge of its converted parents and `ours`, so the local branch
    /// fast-forwards to it on the next pull.
    pub async fn convert_landing(
        &mut self,
        head: &str,
        ours: &str,
        version: u64,
    ) -> Result<String> {
        let info = self.info(head).await?;
        let mut parents = Vec::new();
        for parent in &info.parents {
            let local = Box::pin(self.convert(parent, None, 0)).await?;
            if !parents.contains(&local) {
                parents.push(local);
            }
        }
        if !parents.iter().any(|p| p == ours) {
            parents.push(ours.to_owned());
        }
        snapshot::fetch_tree(self.api, self.git, &info.tree).await?;
        let commit = local_commit(head, &info, &parents)?;
        self.write(&[commit.encode()])?;
        let local = commit.id().hex();
        self.map
            .record(&[(head.to_owned(), local.clone(), version)])?;
        Ok(local)
    }

    fn write(&self, commits: &[Vec<u8>]) -> Result<()> {
        if commits.is_empty() {
            return Ok(());
        }
        let objects: Vec<(ObjectKind, &[u8])> = commits
            .iter()
            .map(|c| (ObjectKind::Commit, c.as_slice()))
            .collect();
        let pack = write_pack(&objects)
            .map_err(|e| Error::new(format!("building a pack: {}", e.message)))?;
        self.git.unpack(&pack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> Info {
        Info {
            tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904".into(),
            parents: vec![],
            message: Some("add <x>\n".into()),
            principal: Some("user:<alice>\n".into()),
            landed_ms: Some(1_700_000_000_123),
        }
    }

    #[test]
    fn builds_a_stable_commit_with_a_traceable_message() -> Result<()> {
        let a = local_commit("c".repeat(40).as_str(), &info(), &[])?;
        let b = local_commit("c".repeat(40).as_str(), &info(), &[])?;
        assert_eq!(a.id(), b.id());
        let text = String::from_utf8_lossy(&a.encode()).into_owned();
        assert!(text.contains("author user:alice <commits@yonedarepo.invalid> 1700000000 +0000"));
        assert!(text.ends_with(&format!("add <x>\n\nYoneda-Commit: {}\n", "c".repeat(40))));
        let mut bare = info();
        bare.principal = Some(" ".into());
        bare.landed_ms = None;
        let text = String::from_utf8_lossy(&local_commit("d", &bare, &[])?.encode()).into_owned();
        assert!(text.contains("author YonedaRepo <commits@yonedarepo.invalid> 0 +0000"));
        Ok(())
    }

    #[test]
    fn reads_log_entries_and_commit_records() {
        let log = serde_json::json!({"commit":"c","tree":"t","parents":["p"],"message":"m",
            "principal":"user:a","landed":{"version":3,"landed_at":5000}});
        let info = Info::from_record(&log);
        assert_eq!(info.as_ref().and_then(|i| i.landed_ms), Some(5000));
        let record = serde_json::json!({"commit":"c","tree":"t","parents":[],"landings":[]});
        assert!(Info::from_record(&record).is_some_and(|i| i.landed_ms.is_none()));
        assert!(Info::from_record(&serde_json::json!({"tree":"t"})).is_none());
    }
}
