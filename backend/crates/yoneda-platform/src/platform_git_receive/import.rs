//! A whole history's pack fetched from a remote, read as an import reads it
//! (repo-import-direct.ts). Nothing here is a push: no ref command applies and no file is
//! scanned, as for an import through the mirror. The head's trees and files become the
//! writes (the mirror holds the rest of history, and its commits), and its first-parent
//! chain is listed with each commit's file-level changes, read from the pack's trees as the
//! walk reaches them.
use super::ReceiveSession;
use crate::platform_git_verify::touch;
use crate::storage::{bad, string};
use serde_json::{Value, json};
use std::collections::HashSet;
use yoneda_core::{
    Error, Result,
    git_object::{
        Commit, FileMode, ObjectId, ObjectKind, PackReader, TreeChange, Walk, decode_tree,
        diff_trees_in,
    },
};

/// Changed files one recorded commit may list: as `tree_diff` allows the mirror's path.
const MAX_FILES: usize = 10_000;
/// What a commit message keeps (`logged` in repo-import-head.ts).
const MESSAGE_CHARS: usize = 4000;

/// One commit of the chain, newest first.
pub(super) struct Link {
    id: ObjectId,
    tree: ObjectId,
    parents: Vec<ObjectId>,
}

fn read_commit(pack: &mut PackReader, id: &ObjectId) -> Result<Commit> {
    if pack.kind(id) != Some(ObjectKind::Commit) {
        return Err(Error::new(
            "NOT_FOUND",
            format!("The pack does not hold commit {id}"),
        ));
    }
    let data = pack.content(id)?;
    Commit::decode(&data).map_err(|e| Error::new(&e.code, format!("Commit {id}: {}", e.message)))
}

/// Trees and files at `tree` (each once, a nested repository's commit left out), in the
/// order they are met. A tree the pack lacks ends the read: the pack is not the whole head.
fn snapshot(pack: &mut PackReader, tree: ObjectId) -> Result<Vec<(ObjectId, ObjectKind)>> {
    let mut seen = HashSet::from([tree]);
    let mut stack = vec![tree];
    let mut out = Vec::new();
    while let Some(id) = stack.pop() {
        if pack.kind(&id) != Some(ObjectKind::Tree) {
            return Err(Error::new(
                "NOT_FOUND",
                format!("The pack does not hold tree {id}"),
            ));
        }
        out.push((id, ObjectKind::Tree));
        let data = pack.content(&id)?;
        for entry in decode_tree(&data)? {
            if entry.mode == FileMode::Gitlink || !seen.insert(entry.id) {
                continue;
            }
            if entry.mode.is_tree() {
                stack.push(entry.id);
            } else if pack.kind(&entry.id) == Some(ObjectKind::Blob) {
                out.push((entry.id, ObjectKind::Blob));
            } else {
                return Err(Error::new(
                    "NOT_FOUND",
                    format!("The pack does not hold file {}", entry.id),
                ));
            }
        }
    }
    Ok(out)
}

impl ReceiveSession {
    fn pack_held(&mut self) -> Result<&mut PackReader> {
        self.pack
            .as_mut()
            .ok_or_else(|| bad("No pack was received"))
    }

    /// `{tip}`: the head's trees and files become the writes `next_objects` hands out, trees
    /// first. Answers how many.
    pub fn import_head(&mut self, input: &Value) -> Result<Value> {
        let tip = ObjectId::parse(&string(input, "tip")?)?;
        let pack = self.pack_held()?;
        let tree = read_commit(pack, &tip)?.tree()?;
        let mut writes = snapshot(pack, tree)?;
        writes.sort_by_key(|(_, kind)| *kind == ObjectKind::Blob);
        let objects = writes.len();
        self.writes = writes;
        self.written = 0;
        Ok(json!({ "objects": objects }))
    }

    /// `{tip, max}`: walks `tip`'s first parents, at most `max` commits and the one below
    /// them (the oldest kept's changes are against its real parent). Answers how many are
    /// kept. A parent the pack lacks refuses: a fetched history is never partial.
    pub fn import_chain(&mut self, input: &Value) -> Result<Value> {
        let tip = ObjectId::parse(&string(input, "tip")?)?;
        let max = input["max"].as_u64().unwrap_or(0) as usize;
        let pack = self.pack_held()?;
        let mut chain = Vec::new();
        let mut next = Some(tip);
        while let Some(id) = next.filter(|_| chain.len() <= max) {
            let commit = read_commit(pack, &id)?;
            let parents = commit.parents()?;
            next = parents.first().copied();
            chain.push(Link {
                id,
                tree: commit.tree()?,
                parents,
            });
        }
        let kept = chain.len().min(max);
        self.chain = chain;
        self.kept = kept;
        Ok(json!({ "commits": kept }))
    }

    /// `{from, count}` of the chain: each commit as `repo_record_imported` takes it, with
    /// its generation; `touches` is null for a commit over the changed-file limit.
    pub fn import_commits(&mut self, input: &Value) -> Result<Value> {
        let from = input["from"].as_u64().unwrap_or(0) as usize;
        let count = input["count"].as_u64().unwrap_or(0) as usize;
        let total = self.kept;
        let end = total.min(from.saturating_add(count));
        let mut commits = Vec::with_capacity(end.saturating_sub(from));
        for index in from..end {
            let (id, tree, parents) = {
                let link = &self.chain[index];
                (link.id, link.tree, link.parents.clone())
            };
            let old = self.chain.get(index + 1).map(|below| below.tree);
            let Some(pack) = self.pack.as_mut() else {
                return Err(bad("No pack was received"));
            };
            let message: String = String::from_utf8_lossy(read_commit(pack, &id)?.message())
                .chars()
                .take(MESSAGE_CHARS)
                .collect();
            let mut trees = self.verifier.history_trees(pack);
            let touches = match diff_trees_in(old, Some(tree), &mut trees, MAX_FILES) {
                Ok(Walk::Done(changes)) => json!(touches(&changes)),
                Ok(Walk::Need(ids)) => {
                    return Err(Error::new(
                        "NOT_FOUND",
                        format!("The pack does not hold {} trees of {id}", ids.len()),
                    ));
                }
                Err(e) if e.code == "TOO_LARGE" => Value::Null,
                Err(e) => return Err(e),
            };
            commits.push(json!({
                "commit": id, "tree": tree, "parents": parents, "message": message,
                "generation": total - index, "touches": touches,
            }));
        }
        Ok(json!({ "commits": commits }))
    }
}

fn touches(changes: &[TreeChange]) -> Vec<yoneda_core::txlog::PathTouch> {
    changes.iter().map(touch).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use yoneda_core::git_object::{TreeEntry, encode_tree, hash_object, write_pack};

    struct History {
        pack: Vec<u8>,
        tips: Vec<ObjectId>,
    }

    fn tree_of(files: &[(&str, ObjectId)]) -> Vec<u8> {
        let entries: Vec<TreeEntry> = files
            .iter()
            .map(|(name, id)| TreeEntry {
                mode: FileMode::Blob,
                name: (*name).to_owned(),
                id: *id,
            })
            .collect();
        encode_tree(&entries).expect("a tree")
    }

    fn commit_of(tree: ObjectId, parent: Option<ObjectId>, message: &str) -> Vec<u8> {
        let parent = parent.map_or(String::new(), |p| format!("parent {p}\n"));
        let who = "A <a@example.com> 1700000000 +0000";
        format!("tree {tree}\n{parent}author {who}\ncommitter {who}\n\n{message}\n").into_bytes()
    }

    /// Three commits: `a.txt` added, changed, then `b.txt` added.
    fn history() -> History {
        let blobs: Vec<Vec<u8>> = vec![b"one\n".to_vec(), b"two\n".to_vec(), b"b\n".to_vec()];
        let id = |data: &[u8]| hash_object(ObjectKind::Blob, data);
        let trees = [
            tree_of(&[("a.txt", id(&blobs[0]))]),
            tree_of(&[("a.txt", id(&blobs[1]))]),
            tree_of(&[("a.txt", id(&blobs[1])), ("b.txt", id(&blobs[2]))]),
        ];
        let mut parent = None;
        let mut commits = Vec::new();
        let mut tips = Vec::new();
        for (n, tree) in trees.iter().enumerate() {
            let tree = hash_object(ObjectKind::Tree, tree);
            let bytes = commit_of(tree, parent, &format!("change {n}"));
            let commit = hash_object(ObjectKind::Commit, &bytes);
            parent = Some(commit);
            tips.push(commit);
            commits.push(bytes);
        }
        let mut objects: Vec<(ObjectKind, &[u8])> = Vec::new();
        objects.extend(commits.iter().map(|c| (ObjectKind::Commit, c.as_slice())));
        objects.extend(trees.iter().map(|t| (ObjectKind::Tree, t.as_slice())));
        objects.extend(blobs.iter().map(|b| (ObjectKind::Blob, b.as_slice())));
        History {
            pack: write_pack(&objects).expect("a pack"),
            tips,
        }
    }

    fn session(history: &History) -> ReceiveSession {
        let tip = history.tips.last().expect("a tip");
        let line = format!("{} {tip} refs/yoneda/copy\0report-status\n", "0".repeat(40));
        let mut head = format!("{:04x}{line}0000", line.len() + 4).into_bytes();
        head.extend_from_slice(&history.pack);
        let mut session = ReceiveSession::new();
        session.feed(&head).expect("the pack");
        session.finish().expect("a whole pack");
        session
    }

    #[test]
    fn head_writes_hold_only_what_the_head_needs() {
        let history = history();
        let mut session = session(&history);
        let tip = history.tips[2];
        let answer = session
            .import_head(&json!({ "tip": tip }))
            .expect("the head");
        // Its one tree and its two files; not the first version of a.txt, and no commit.
        assert_eq!(answer["objects"], 3);
        let frames = session.next_objects(1 << 20).expect("frames");
        assert_eq!(frames[0], 2, "the tree comes first");
        assert!(session.next_objects(1 << 20).expect("frames").is_empty());
    }

    #[test]
    fn chain_lists_changes_newest_first_with_generations() {
        let history = history();
        let mut session = session(&history);
        let tip = history.tips[2];
        let chain = session
            .import_chain(&json!({ "tip": tip, "max": 10 }))
            .expect("a chain");
        assert_eq!(chain["commits"], 3);
        let page = session
            .import_commits(&json!({ "from": 0, "count": 3 }))
            .expect("a page");
        let commits = page["commits"].as_array().expect("a list");
        assert_eq!(commits[0]["generation"], 3);
        assert_eq!(commits[0]["touches"][0]["path"], "b.txt");
        assert_eq!(commits[1]["touches"][0]["op"], "modify");
        assert_eq!(commits[2]["generation"], 1);
        assert_eq!(commits[2]["touches"][0]["op"], "add");
        assert_eq!(commits[2]["parents"], json!([]));
    }

    #[test]
    fn a_capped_chain_diffs_its_oldest_against_its_real_parent() {
        let history = history();
        let mut session = session(&history);
        let chain = session
            .import_chain(&json!({ "tip": history.tips[2], "max": 2 }))
            .expect("a chain");
        assert_eq!(chain["commits"], 2);
        let page = session
            .import_commits(&json!({ "from": 1, "count": 9 }))
            .expect("a page");
        let commits = page["commits"].as_array().expect("a list");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0]["generation"], 1);
        assert_eq!(commits[0]["touches"][0]["op"], "modify");
        assert_eq!(commits[0]["parents"], json!([history.tips[0]]));
    }

    #[test]
    fn a_commit_the_pack_lacks_refuses() {
        let history = history();
        let mut session = session(&history);
        let absent = ObjectId::parse(&"a".repeat(40)).expect("an id");
        assert_eq!(
            session
                .import_chain(&json!({ "tip": absent, "max": 2 }))
                .err()
                .map(|e| e.code),
            Some("NOT_FOUND".to_owned())
        );
    }
}
