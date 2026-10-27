//! `push`: every ref's commits are uploaded first; then one compare-and-swap per branch
//! (one batch for `--atomic`), one landing for main, or one creation per new lightweight
//! tag publishes them (tags never move or disappear). A push killed
//! before that leaves every ref as it was: uploaded commits stay unreferenced and the
//! platform's vacuum removes them.
use super::list::{MAIN, branches};
use super::tags::{TAGS, create_tag, tag_refusal};
use super::upload::{self, Uploaded};
use super::{Session, declared, land, say};
use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// One `push [+]<src>:<dst>` line.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Spec {
    pub force: bool,
    pub src: String,
    pub dst: String,
}

impl Spec {
    pub fn parse(spec: &str) -> Result<Self> {
        let (force, spec) = match spec.strip_prefix('+') {
            Some(rest) => (true, rest),
            None => (false, spec),
        };
        let (src, dst) = spec
            .split_once(':')
            .ok_or_else(|| Error::new(format!("malformed push spec {spec:?}")))?;
        Ok(Self {
            force,
            src: src.to_owned(),
            dst: dst.to_owned(),
        })
    }
}

/// A ref whose push goes ahead: its local commit and the platform head it replaces.
struct Ready {
    spec: Spec,
    local: String,
    current: Option<String>,
}

/// Why a ref is refused before anything is uploaded (`None`: nothing to do, or go).
fn refusal(session: &Session, spec: &Spec, local: &str, current: Option<&str>) -> Option<String> {
    if spec.dst.starts_with(TAGS) {
        return tag_refusal(session, &spec.src, local, current);
    }
    if !spec.dst.starts_with("refs/heads/") {
        return Some("only branches (refs/heads/*) and tags (refs/tags/*) can be pushed".into());
    }
    if spec.dst == MAIN {
        return spec
            .force
            .then(|| "main moves only by landing; it cannot be force-pushed".into());
    }
    let current = current?;
    if spec.force {
        return None;
    }
    match session.held(current) {
        Some(known) if session.git.is_ancestor(&known, local) => None,
        _ => Some("non-fast-forward".into()),
    }
}

fn line(dst: &str, outcome: &std::result::Result<(), String>) -> String {
    match outcome {
        Ok(()) => format!("ok {dst}\n"),
        Err(why) => format!("error {dst} {why}\n"),
    }
}

/// Pushes `specs`; returns Git's status lines (without the final blank line).
pub async fn push(session: &mut Session, specs: Vec<Spec>) -> String {
    let mut outcomes: BTreeMap<String, std::result::Result<(), String>> = BTreeMap::new();
    let (_, heads) = match branches(session).await {
        Ok(found) => found,
        Err(e) => {
            return specs
                .iter()
                .map(|s| line(&s.dst, &Err(e.message.clone())))
                .collect();
        }
    };
    let mut ready = Vec::new();
    for spec in &specs {
        if spec.src.is_empty() {
            let why = if spec.dst.starts_with(TAGS) {
                "tags are immutable and cannot be deleted"
            } else {
                "deleting branches is not supported"
            };
            outcomes.insert(spec.dst.clone(), Err(why.into()));
            continue;
        }
        let local = match session.git.commit_of(&spec.src) {
            Ok(local) => local,
            Err(e) => {
                outcomes.insert(spec.dst.clone(), Err(e.message));
                continue;
            }
        };
        let current = heads.get(&spec.dst).cloned();
        let outcome = match refusal(session, spec, &local, current.as_deref()) {
            Some(why) => Err(why),
            None => Ok(()),
        };
        let up_to_date = current
            .as_deref()
            .and_then(|c| session.held(c))
            .is_some_and(|known| known == local);
        if outcome.is_ok() && !up_to_date {
            ready.push(Ready {
                spec: spec.clone(),
                local,
                current,
            });
        }
        outcomes.insert(spec.dst.clone(), outcome);
    }
    let atomic = session.options.atomic && specs.len() > 1;
    if atomic && outcomes.values().any(|o| o.is_err()) {
        // All or none: one refused ref refuses the push.
        refuse_rest(&mut outcomes, "atomic push refused");
        ready.clear();
    }
    if atomic && ready.iter().any(|r| r.spec.dst == MAIN) {
        refuse_rest(
            &mut outcomes,
            "an atomic push cannot include main (main moves by landing)",
        );
        ready.clear();
    }
    if !session.options.dry_run && !ready.is_empty() {
        match declared::reads(session) {
            Ok(reads) => {
                let tips = publish(session, ready, atomic, &reads, &mut outcomes).await;
                if outcomes.values().all(|o| o.is_ok()) {
                    declared::spent(session, &tips, &reads);
                }
            }
            Err(e) => refuse_rest(&mut outcomes, &e.message),
        }
    }
    specs
        .iter()
        .map(|s| line(&s.dst, &outcomes[&s.dst]))
        .collect()
}

/// Turns every ref still going ahead into a refusal (an atomic push failing as a whole).
fn refuse_rest(outcomes: &mut BTreeMap<String, std::result::Result<(), String>>, why: &str) {
    for outcome in outcomes.values_mut().filter(|o| o.is_ok()) {
        *outcome = Err(why.to_owned());
    }
}

/// Uploads every ready ref, each tip declaring `reads`, then publishes them; returns the
/// published tips.
async fn publish(
    session: &mut Session,
    ready: Vec<Ready>,
    atomic: bool,
    reads: &[String],
    outcomes: &mut BTreeMap<String, std::result::Result<(), String>>,
) -> Vec<String> {
    let mut uploaded = Vec::new();
    let mut tips = Vec::new();
    for item in ready {
        let creates = item.current.is_none();
        let result = match upload::plan_for(session, &item.local, creates).await {
            Ok(plan) => upload::upload(session, plan, reads).await,
            Err(e) => Err(e),
        };
        match result {
            Ok(done) => uploaded.push((item, done)),
            Err(e) => {
                outcomes.insert(item.spec.dst.clone(), Err(e.message));
            }
        }
    }
    if atomic {
        if outcomes.values().any(|o| o.is_err()) {
            refuse_rest(outcomes, "atomic push refused");
            return tips;
        }
        let result = batch(session, &uploaded).await;
        for (item, done) in &uploaded {
            let outcome = result.as_ref().map_err(|stale| stale(&item.spec.dst));
            if outcome.is_ok() {
                remember(session, done);
                tips.push(done.tip.clone());
            }
            outcomes.insert(item.spec.dst.clone(), outcome.map(|_| ()));
        }
        return tips;
    }
    for (item, done) in uploaded {
        let outcome = if item.spec.dst == MAIN {
            land::land(session, &item.local, &done).await
        } else if item.spec.dst.starts_with(TAGS) {
            create_tag(session, &item.spec.dst, &done).await
        } else {
            set_branch(session, &item, &done).await
        };
        if outcome.is_ok() {
            remember(session, &done);
            tips.push(done.tip.clone());
        }
        outcomes.insert(item.spec.dst.clone(), outcome);
    }
    tips
}

/// Maps the published commits whose platform id differs from the local one (most match).
fn remember(session: &mut Session, done: &Uploaded) {
    if let Err(e) = session.map.record(&done.made) {
        say(&format!(
            "published, but recording the commit map failed: {e}"
        ));
    }
}

async fn set_branch(
    session: &Session,
    item: &Ready,
    done: &Uploaded,
) -> std::result::Result<(), String> {
    let body = json!({ "ref": item.spec.dst, "commit": done.tip, "expected": item.current });
    match session.api.post("/branches", &body).await {
        Ok(_) => Ok(()),
        Err(f) if f.code == "STALE_HEAD" => {
            Err("fetch first: the branch moved on the platform".into())
        }
        Err(f) => Err(f.to_string()),
    }
}

/// One all-or-none move of every uploaded ref. On refusal, the error maps a ref to its
/// status-line message.
async fn batch(
    session: &Session,
    uploaded: &[(Ready, Uploaded)],
) -> std::result::Result<(), Box<dyn Fn(&str) -> String>> {
    let updates: Vec<Value> = uploaded
        .iter()
        .map(|(item, done)| json!({ "ref": item.spec.dst, "commit": done.tip, "expected": item.current }))
        .collect();
    match session
        .api
        .post("/refs/batch", &json!({ "updates": updates }))
        .await
    {
        Ok(_) => Ok(()),
        Err(f) if f.code == "STALE_HEAD" => {
            let stale: Vec<String> = f.details["stale"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r.as_str().map(full_ref))
                .collect();
            say(&format!(
                "atomic push refused: {} moved on the platform",
                stale.join(", ")
            ));
            Err(Box::new(move |dst: &str| {
                if stale.iter().any(|s| s == dst) {
                    "fetch first: the branch moved on the platform".to_owned()
                } else {
                    "atomic push refused".to_owned()
                }
            }))
        }
        Err(f) => {
            let text = f.to_string();
            Err(Box::new(move |_: &str| text.clone()))
        }
    }
}

fn full_ref(name: &str) -> String {
    if name.starts_with("refs/") {
        name.to_owned()
    } else {
        format!("refs/heads/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_push_specs() -> Result<()> {
        let spec = Spec::parse("refs/heads/a:refs/heads/b")?;
        assert!(!spec.force && spec.src == "refs/heads/a" && spec.dst == "refs/heads/b");
        assert!(Spec::parse("+HEAD:refs/heads/x")?.force);
        assert_eq!(Spec::parse(":refs/heads/gone")?.src, "");
        assert!(Spec::parse("nocolon").is_err());
        assert_eq!(full_ref("x"), "refs/heads/x");
        Ok(())
    }
}
