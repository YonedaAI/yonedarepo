//! Publication of uploaded branch and tag refs, individually or as one atomic batch.
use super::super::list;
use super::super::tags::{TAGS, tag_update};
use super::super::upload::Uploaded;
use super::super::{Session, say};
use super::Ready;
use serde_json::{Value, json};

pub(super) async fn set_branch(
    session: &Session,
    item: &Ready,
    done: &Uploaded,
) -> std::result::Result<(), String> {
    let body = json!({ "ref": item.spec.dst, "commit": done.tip, "expected": item.current });
    match session.api.post_idempotent("/branches", &body).await {
        Ok(moved) => {
            list::observe_write(session, &moved)?;
            change_hint(&item.spec.dst, &moved);
            Ok(())
        }
        Err(f) if f.code == "STALE_HEAD" => {
            Err("fetch first: the branch moved on the platform".into())
        }
        Err(f) => Err(f.to_string()),
    }
}

/// After a branch moved: its open change, or how to open one (the same lines a smart-HTTP
/// push prints).
fn change_hint(dst: &str, moved: &Value) {
    let branch = dst.strip_prefix("refs/heads/").unwrap_or(dst);
    match moved.get("change") {
        Some(Value::Null) => say(&format!("open a change: yoneda change create {branch}")),
        Some(number) => say(&format!("change #{number} now at this push")),
        None => {}
    }
}

/// One all-or-none move of every uploaded ref. On refusal, the error maps a ref to its
/// status-line message.
pub(super) async fn batch(
    session: &Session,
    uploaded: &[(Ready, Uploaded)],
) -> std::result::Result<(), Box<dyn Fn(&str) -> String>> {
    let mut updates: Vec<Value> = Vec::new();
    for (item, done) in uploaded {
        updates.push(if item.spec.dst.starts_with(TAGS) {
            match tag_update(session, &item.spec.src, &item.spec.dst, done) {
                Ok(update) => update,
                Err(e) => {
                    let text = e.message;
                    return Err(Box::new(move |_: &str| text.clone()));
                }
            }
        } else {
            json!({ "ref": item.spec.dst, "commit": done.tip, "expected": item.current })
        });
    }
    match session
        .api
        .post("/refs/batch", &json!({ "updates": updates }))
        .await
    {
        Ok(moved) => list::observe_write(session, &moved).map_err(|message| {
            Box::new(move |_: &str| message.clone()) as Box<dyn Fn(&str) -> String>
        }),
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
    use super::full_ref;

    #[test]
    fn expands_a_short_branch_name() {
        assert_eq!(full_ref("x"), "refs/heads/x");
    }
}
