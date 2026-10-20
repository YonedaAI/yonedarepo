//! Private RepoDO source hooks. Metadata staging never grants capture or publication.
use crate::source_workspace;
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result, source_workspace::*};
mod context;
mod registration;
mod resolution;
#[cfg(test)]
mod tests;
/// Called only by the trusted Worker dispatcher; all fields prefixed `_source` are stripped at public routes.
pub(crate) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "source_read_context" => context::read(db, c, now),
        "source_bind" => bind(db, c, now),
        "source_register_changeset" => registration::register(db, c, now),
        "source_capture_context" => registration::capture(db, c, now),
        "source_registered" => registration::registered(db, c),
        _ => Err(bad("Unknown private source operation")),
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone()).map_err(|_| bad("Invalid closed source contract"))
}
fn bind<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let mut job = active(db, c, now)?;
    let context = context::read(db, c, now)?;
    if let Some(digest) = c["_source_view_digest"].as_str() {
        validate_hash(digest, &[64])?;
        let entry = &job["source_bindings"][digest];
        let binding: SourceBinding = decode(&entry["binding"])?;
        validate_guard(db, &binding, entry, &context)?;
        return granted(&job, c, &binding, None);
    }
    let view: SourceView = decode(&c["_source_view"])?;
    let selected: SourceRevision = decode(
        &json!({"repository":view.base.repository,"commit":view.base.commit,"tree":view.base.tree}),
    )?;
    if !context["inputs"]
        .as_array()
        .is_some_and(|a| a.contains(&json!(selected)))
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Source view is outside approved immutable inputs",
        ));
    }
    let readonly =
        context["access"] == "read_only" || selected != decode::<SourceRevision>(&context["base"])?;
    let overrides: Vec<BaselineOverride> =
        decode(c.get("_source_baseline_overrides").unwrap_or(&json!([])))?;
    context::validate_overrides(db, &job, &context, &overrides, readonly)?;
    let merged = merged_baseline(&view, &overrides)?;
    let role: SourceRole = decode(&context["role"])?;
    let digest = view_digest(&view, &overrides)?;
    let b = SourceBinding {
        version: 1,
        transport: TRANSPORT.into(),
        workspace_id: workspace_id(
            &string(&context, "repo_id")?,
            &string(&context, "job_id")?,
            number(&context, "epoch")?,
            &digest,
        )?,
        repo_id: string(&context, "repo_id")?,
        run_id: string(&context, "run_id")?,
        job_id: string(&context, "job_id")?,
        epoch: number(&context, "epoch")?,
        execution_id: string(&context, "execution_id")?,
        role: decode(&context["role"])?,
        access: if readonly {
            SourceAccess::ReadOnly
        } else {
            SourceAccess::ReadWrite
        },
        view_digest: digest.clone(),
        baseline_overrides_digest: yoneda_agents_core::fingerprint(&json!(overrides))?,
        base: selected.clone(),
        parents: if selected == decode::<SourceRevision>(&context["base"])? {
            decode(&context["parents"])?
        } else {
            vec![selected.commit.clone()]
        },
        policy_digest: string(&context, "policy_digest")?,
        intent_digest: string(&context, "intent_digest")?,
        write_paths: if readonly {
            vec![]
        } else {
            decode(&context["write_paths"])?
        },
        protected_paths: decode(&context["protected_paths"])?,
        scratch_paths: if selected != decode::<SourceRevision>(&context["base"])? {
            vec![]
        } else {
            scratch_paths_for(&merged, role)
        },
        inputs: decode(&context["inputs"])?,
        repo_base_version: number(&context, "repo_base_version")?,
        working_branch_id: decode(&context["working_branch_id"])?,
        working_branch_version: decode(&context["working_branch_version"])?,
    };
    b.validate()?;
    let old = job["source_bindings"][&digest].clone();
    let guard = json!({"binding":b,"plan_version":context["plan_version"],"task_version":context["task_version"],"producer_epoch":job["epoch"]});
    if old.is_null() {
        job["source_bindings"][&digest] = guard;
        save(db, "jobs", &string(&job, "id")?, &job)?;
    } else if old["binding"] != json!(b) {
        return Err(Error::new(
            "FENCED",
            "Source approval changed after first binding",
        ));
    }
    validate_guard(db, &b, &job["source_bindings"][&digest], &context)?;
    granted(&job, c, &b, Some(overrides))
}
fn granted(
    job: &Value,
    c: &Value,
    b: &SourceBinding,
    overrides: Option<Vec<BaselineOverride>>,
) -> Result<Value> {
    let expiry = number(job, "lease_until")?.min(number(job, "attempt_deadline")?);
    let purpose = if c["_supervisor"] == true {
        ActorPurpose::Supervisor
    } else {
        ActorPurpose::Source
    };
    let key = string(c, "_source_signing_key")?;
    let actor = if c["_read_only"] == true {
        source_workspace::sign_read_actor(b, expiry, purpose, &key)?
    } else {
        source_workspace::sign_actor(b, expiry, purpose, &key)?
    };
    let mut result = json!({"version":1,"binding":b,"actor_grant":actor});
    if let Some(overrides) = overrides {
        result["baseline_overrides"] = json!(overrides);
    }
    Ok(result)
}

fn validate_guard<S: SqlStore>(
    db: &S,
    b: &SourceBinding,
    entry: &Value,
    context: &Value,
) -> Result<()> {
    let expected_write = if b.access == SourceAccess::ReadOnly {
        json!([])
    } else {
        context["write_paths"].clone()
    };
    if entry["producer_epoch"] != context["epoch"]
        || entry["task_version"] != context["task_version"]
        || !plan_current(db, b, entry, context)?
        || json!(b.policy_digest) != context["policy_digest"]
        || json!(b.intent_digest) != context["intent_digest"]
        || json!(b.write_paths) != expected_write
        || !context["inputs"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(b.base)))
    {
        return Err(Error::new(
            "FENCED",
            "Source policy, task, plan, or input authority changed",
        ));
    }
    Ok(())
}

/// Specialists are fenced by task revision instead. A read-only coordinator keeps reading only
/// across plan revisions that it authored itself through `repair_team`; any other change fences.
fn plan_current<S: SqlStore>(
    db: &S,
    b: &SourceBinding,
    entry: &Value,
    context: &Value,
) -> Result<bool> {
    if entry["plan_version"] == context["plan_version"] || b.role == SourceRole::Specialist {
        return Ok(true);
    }
    let (Some(mut revision), Some(current)) = (
        entry["plan_version"].as_i64(),
        context["plan_version"].as_i64(),
    ) else {
        return Ok(false);
    };
    if b.role != SourceRole::Coordinator || b.access != SourceAccess::ReadOnly {
        return Ok(false);
    }
    let run = get(db, "runs", &b.run_id)?;
    let amendments = run["team_plan_amendments"].as_array();
    while revision < current {
        let Some(next) = amendments
            .into_iter()
            .flatten()
            .find(|a| a["supersedes_revision"] == revision)
            .filter(|a| {
                a["approved_by"] == "run_autonomy_policy" && a["execution_id"] == b.execution_id
            })
            .and_then(|a| a["plan_revision"].as_i64())
            .filter(|next| *next > revision)
        else {
            return Ok(false);
        };
        revision = next;
    }
    Ok(revision == current)
}

/// Internal lineage readback; no grants are minted for application-domain validation.
pub(crate) fn capture_record<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    registration::capture_record(db, c, now)
}
