//! A change's instruments: what the authority knows about its last heads
//! (`repo_change_instruments`) and what the adapter measured from their diffs, turned into one
//! answer here, next to the object cache, so measuring never queues behind landings.
//! Everything here is a pure function of its input.
use crate::platform_risk;
use crate::storage::bad;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use yoneda_core::{Error, Result};

/// A change's instruments, newest head first (`GET /changes/:n/instruments`).
#[derive(Debug, Serialize, JsonSchema)]
pub struct ChangeInstruments {
    pub number: i64,
    pub heads: Vec<HeadReading>,
}

/// One head of the change's branch.
#[derive(Debug, Serialize, JsonSchema)]
pub struct HeadReading {
    pub commit: String,
    /// When the branch moved to this commit (ms since the epoch).
    pub at: i64,
    /// Checks on this commit whose evidence carries a value.
    pub checks: Vec<CheckReading>,
    /// Null when this head could not be measured.
    pub risk: Option<RiskReading>,
}

/// The newest result of one check on a commit.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CheckReading {
    pub name: String,
    pub value: CheckValue,
    pub recorded_at: i64,
}

/// The value a check's evidence names; anything else is not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CheckValue {
    Pass,
    Fail,
    Low,
    Medium,
    High,
}

/// The score (0 to 100, higher is riskier), its band and every input behind it. Informational:
/// landing never reads it.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RiskReading {
    pub score: u32,
    pub level: RiskLevel,
    /// One per input, always all four, so a reader sees what was weighed.
    pub reasons: Vec<RiskReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

/// What one input added to the score, and why.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RiskReason {
    pub input: RiskInput,
    pub points: u32,
    /// One line of why.
    pub why: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RiskInput {
    /// The commits' review classes.
    Classes,
    /// Files and lines touched.
    Size,
    /// Paths that steer the build, access or data: policy, workflows, auth, migrations, lockfiles.
    Sensitive,
    /// Unresolved line comments and withheld findings.
    Findings,
}

/// What the authority answers (`repo_change_instruments`).
#[derive(Debug, Serialize, Deserialize)]
pub struct ChangeFacts {
    pub number: i64,
    pub heads: Vec<HeadFacts>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HeadFacts {
    pub commit: String,
    pub tree: String,
    pub at: i64,
    /// What this head's diff compares against; null when the base is not known any more.
    pub compared: Option<Compared>,
    pub commits: CommitFacts,
    pub open_findings: u64,
    pub checks: Vec<CheckReading>,
}

/// The diff's old side: the merge base's tree, null for unrelated histories.
#[derive(Debug, Serialize, Deserialize)]
pub struct Compared {
    pub base_tree: Option<String>,
}

/// The review classes of the commits a head would bring onto its base.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CommitFacts {
    /// Commits per recorded class.
    pub classes: BTreeMap<String, u64>,
    /// Commits with no class recorded.
    pub unclassified: u64,
    /// Not every commit could be read: a merge, an unrecorded parent or too many commits.
    pub unread: bool,
}

/// One file of a head's diff, as the adapter measured it. No line counts: not measured
/// (binary, too large, withheld, or past the read's budget).
#[derive(Debug, Clone, Deserialize)]
pub struct FileFacts {
    pub path: String,
    pub old_path: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

/// `change_instruments {facts, files}`: `files` has one entry per head, its diff's files, or
/// null for a head that was not measured.
pub fn instruments(c: &Value) -> Result<Value> {
    let facts: ChangeFacts =
        serde_json::from_value(c["facts"].clone()).map_err(|e| bad(&format!("facts: {e}")))?;
    let files: Vec<Option<Vec<FileFacts>>> =
        serde_json::from_value(c["files"].clone()).map_err(|e| bad(&format!("files: {e}")))?;
    if files.len() != facts.heads.len() {
        return Err(bad("files must list one entry per head"));
    }
    let heads = facts
        .heads
        .into_iter()
        .zip(files)
        .map(|(head, files)| HeadReading {
            risk: files.map(|f| platform_risk::score(&head.commits, &f, head.open_findings)),
            commit: head.commit,
            at: head.at,
            checks: head.checks,
        })
        .collect();
    let answer = ChangeInstruments {
        number: facts.number,
        heads,
    };
    serde_json::to_value(answer).map_err(|e| Error::new("ENCODING", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn facts() -> Value {
        json!({"number": 3, "heads": [
            {"commit": "a", "tree": "t", "at": 2, "compared": {"base_tree": "b"},
             "commits": {"classes": {"logic": 1}, "unclassified": 0, "unread": false},
             "open_findings": 1,
             "checks": [{"name": "slop-review", "value": "low", "recorded_at": 2}]},
            {"commit": "c", "tree": "t", "at": 1, "compared": null,
             "commits": {"classes": {}, "unclassified": 1, "unread": false},
             "open_findings": 0, "checks": []},
        ]})
    }

    #[test]
    fn a_head_that_was_not_measured_has_no_score() {
        let files = json!([[{"path": "src/a.rs", "additions": 1, "deletions": 0}], null]);
        let answer = instruments(&json!({"facts": facts(), "files": files})).unwrap();
        assert_eq!(answer["number"], 3);
        assert_eq!(answer["heads"][0]["checks"][0]["value"], "low");
        assert_eq!(answer["heads"][0]["risk"]["level"], "low");
        assert_eq!(
            answer["heads"][0]["risk"]["reasons"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert_eq!(answer["heads"][1]["risk"], Value::Null);
    }

    #[test]
    fn the_same_input_gives_the_same_answer() {
        let input = json!({"facts": facts(), "files": [[{"path": "src/auth.rs"}], null]});
        assert_eq!(instruments(&input).unwrap(), instruments(&input).unwrap());
    }

    #[test]
    fn files_must_match_the_heads() {
        let input = json!({"facts": facts(), "files": [null]});
        assert_eq!(instruments(&input).unwrap_err().code, "INVALID_INPUT");
    }
}
