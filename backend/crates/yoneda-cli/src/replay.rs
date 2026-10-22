//! Replaying a local commit on the platform with its own identity: the commits API takes
//! the exact author, committer (names, emails, times, zones) and message, so the commit
//! the platform builds is the same Git object as the local one, with the same id.
use crate::error::{Error, Result};
use crate::git::Git;
use serde_json::{Value, json};
use yoneda_core::git_object::{Commit, Signature};

/// The platform's limit on a commit message (and other short fields), in bytes.
const MESSAGE_LIMIT: usize = 16 * 1024;

/// What the commits API needs to rebuild a local commit byte for byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    pub author: Value,
    pub committer: Value,
    pub message: String,
}

fn signature(s: &Signature) -> Value {
    json!({ "name": s.name, "email": s.email, "time": s.seconds, "tz": s.offset })
}

fn acceptable(s: &Signature) -> bool {
    let short = |t: &str| !t.trim().is_empty() && t.len() <= MESSAGE_LIMIT;
    short(&s.name) && short(&s.email) && s.seconds >= 0
}

/// `local`'s replay, or `None` when the platform cannot rebuild it exactly: a commit with
/// other headers (a signature, `encoding`, `mergetag`), a message that is not UTF-8, lacks
/// its final newline or is too long, or an identity the platform refuses. Those commits
/// are still sent, with name and email only, and the helper maps the platform's id.
pub fn replay(git: &Git, local: &str) -> Result<Option<Replay>> {
    let raw = git.output(&["cat-file", "commit", local], None, &[])?;
    let commit = Commit::decode(&raw)
        .map_err(|e| Error::new(format!("reading commit {local}: {}", e.message)))?;
    let (Ok(tree), Ok(parents), Ok(author), Ok(committer)) = (
        commit.tree(),
        commit.parents(),
        commit.author(),
        commit.committer(),
    ) else {
        return Ok(None);
    };
    let Ok(message) = std::str::from_utf8(commit.message()) else {
        return Ok(None);
    };
    if message.trim().is_empty()
        || message.len() > MESSAGE_LIMIT
        || !acceptable(&author)
        || !acceptable(&committer)
    {
        return Ok(None);
    }
    let rebuilt = Commit::new(tree, &parents, &author, &committer, message);
    if rebuilt.map(|c| c.id().hex()).ok().as_deref() != Some(local) {
        return Ok(None);
    }
    Ok(Some(Replay {
        author: signature(&author),
        committer: signature(&committer),
        message: message.to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Repo;

    #[test]
    fn replays_ordinary_commits_with_their_exact_identity() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("a.txt", b"a\n")?;
        repo.git.run(&["add", "-A"])?;
        let env = [
            ("GIT_AUTHOR_DATE", "1700000000 +0130"),
            ("GIT_COMMITTER_NAME", "Committer"),
            ("GIT_COMMITTER_EMAIL", "c@example.com"),
            ("GIT_COMMITTER_DATE", "1700000060 -0700"),
        ];
        repo.git
            .output(&["commit", "-q", "-m", "subject", "-m", "body"], None, &env)?;
        let head = repo.git.run(&["rev-parse", "HEAD"])?;
        let replay = replay(&repo.git, &head)?.ok_or_else(|| Error::new("not replayable"))?;
        assert_eq!(replay.message, "subject\n\nbody\n");
        assert_eq!(
            replay.author,
            json!({"name": "Tester", "email": "tester@example.com", "time": 1_700_000_000, "tz": "+0130"})
        );
        assert_eq!(
            replay.committer,
            json!({"name": "Committer", "email": "c@example.com", "time": 1_700_000_060, "tz": "-0700"})
        );
        Ok(())
    }

    #[test]
    fn declines_commits_it_cannot_rebuild() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("a.txt", b"a\n")?;
        let base = repo.commit("base")?;
        let tree = repo.git.tree_of(&base)?;
        // No final newline, and an extra header: neither survives a rebuild.
        let who = "Tester <tester@example.com> 1700000000 +0000";
        for raw in [
            format!("tree {tree}\nauthor {who}\ncommitter {who}\n\nno newline"),
            format!("tree {tree}\nauthor {who}\ncommitter {who}\nencoding latin1\n\nmsg\n"),
        ] {
            let id = repo.git.output(
                &["hash-object", "-t", "commit", "-w", "--stdin"],
                Some(raw.as_bytes()),
                &[],
            )?;
            let id = String::from_utf8_lossy(&id).trim().to_owned();
            assert_eq!(replay(&repo.git, &id)?, None, "{raw}");
        }
        Ok(())
    }
}
