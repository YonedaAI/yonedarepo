//! Platform commits into the local repository, byte for byte: `/objects` with `raw`
//! serves each commit's exact Git content, which is verified against its id and written
//! as is, so a `yoneda::` clone has the platform's commit ids (the same as `GET refs`,
//! `yoneda log` and the Artifacts clone). The whole missing history is fetched: a commit
//! is written only with its parents, never cut off.
//!
//! History the platform holds as tree and parents only (imported into its object store)
//! cannot be written exactly, and neither can anything built on it (its parents' ids
//! would be missing), so such a head is converted instead (`convert`, recorded in the
//! commit map).
//!
//! What trees and blobs come with them is the session's `Filter`: in a lazy clone, the
//! trees only (`snapshot::walk`).
use super::convert::Converter;
use super::map::CommitMap;
use crate::api::Api;
use crate::error::{Error, Result};
use crate::git::Git;
use crate::snapshot::{self, Filter, Served};
use std::collections::HashSet;
use yoneda_core::git_object::{Commit, ObjectKind};

pub struct Fetcher<'a> {
    pub api: &'a Api,
    pub git: &'a Git,
    pub map: &'a mut CommitMap,
    pub filter: &'a Filter,
}

impl<'a> Fetcher<'a> {
    pub fn new(api: &'a Api, git: &'a Git, map: &'a mut CommitMap, filter: &'a Filter) -> Self {
        Self {
            api,
            git,
            map,
            filter,
        }
    }

    fn has(&self, id: &str) -> Result<bool> {
        Ok(self.git.missing(&[id.to_owned()])?.is_empty())
    }

    /// The local commit for platform commit `head`: `head` itself, fetched with whatever
    /// of its history the local repository lacks (or its converted stand-in). `branch`
    /// names a branch at `head`, whose log lists most of that history in one request.
    pub async fn local(&mut self, head: &str, branch: Option<&str>) -> Result<String> {
        if let Some(local) = self.map.local(head).map(str::to_owned)
            && self.has(&local)?
        {
            return Ok(local);
        }
        if self.has(head)? {
            return Ok(head.to_owned());
        }
        let Some(commits) = self.walk(head, branch).await? else {
            return Converter::new(self.api, self.git, self.map, self.filter)
                .convert(head, branch)
                .await;
        };
        let trees: Vec<String> = commits.iter().map(|(_, tree, _)| tree.clone()).collect();
        snapshot::fetch_trees(self.api, self.git, &trees, self.filter).await?;
        // Commits last, in one pack: a commit present locally always has its history.
        let objects = commits
            .into_iter()
            .map(|(_, _, bytes)| (ObjectKind::Commit, bytes))
            .collect();
        snapshot::write_objects(self.git, objects, self.filter)?;
        Ok(head.to_owned())
    }

    /// Every commit reachable from `head` that the local repository lacks, as (id, tree,
    /// exact bytes); `None` when one is served as tree and parents only.
    async fn walk(
        &self,
        head: &str,
        branch: Option<&str>,
    ) -> Result<Option<Vec<(String, String, Vec<u8>)>>> {
        let mut seen: HashSet<String> = HashSet::from([head.to_owned()]);
        let mut wanted = vec![head.to_owned()];
        if let Some(branch) = branch {
            wanted.extend(
                self.logged(branch)
                    .await
                    .into_iter()
                    .filter(|id| seen.insert(id.clone())),
            );
        }
        let mut found = Vec::new();
        while !wanted.is_empty() {
            let absent = self.git.missing(&wanted)?;
            let mut next = Vec::new();
            for (id, served) in snapshot::commits(self.api, &absent).await? {
                let Served::Exact(bytes) = served else {
                    return Ok(None);
                };
                let commit = Commit::decode(&bytes)
                    .map_err(|e| Error::new(format!("commit {id}: {}", e.message)))?;
                let bad = |e: yoneda_core::Error| Error::new(format!("commit {id}: {}", e.message));
                for parent in commit.parents().map_err(bad)? {
                    if seen.insert(parent.hex()) {
                        next.push(parent.hex());
                    }
                }
                found.push((id.clone(), commit.tree().map_err(bad)?.hex(), bytes));
            }
            wanted = next;
        }
        Ok(Some(found))
    }

    /// The commits on `branch`'s first-parent chain the log lists (one request; a
    /// failure only costs extra rounds).
    async fn logged(&self, branch: &str) -> Vec<String> {
        let path = format!("/log?ref={}&limit=200", crate::api::encode(branch));
        let Ok(log) = self.api.get(&path).await else {
            return Vec::new();
        };
        log["commits"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c["commit"].as_str().map(str::to_owned))
            .collect()
    }
}
