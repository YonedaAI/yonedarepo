use super::*;
pub(crate) fn freeze<S: SqlStore>(db: &S, c: &Value, run: &mut Value) -> Result<()> {
    if c.get("guided").is_some() || c.get("guide").is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Guided bindings are server-derived",
        ));
    }
    let Some(binding) = c.get("_guided_binding") else {
        return Ok(());
    };
    owner(c)?;
    let session = load(db, &string(binding, "session_id")?)?;
    let step = string(binding, "step_id")?;
    let ordinal = run["id"]
        .as_str()
        .and_then(|id| {
            session["steps"]
                .as_array()?
                .iter()
                .find(|s| s["id"] == step)?["run_ids"]
                .as_array()?
                .iter()
                .position(|rid| rid == id)
        })
        .ok_or_else(|| Error::new("FORBIDDEN", "Run is outside the authoritative guided step"))?;
    let expected = make(&session, &step, ordinal)?;
    if *binding != expected
        || run["mode"] != "collaborate"
        || run["working_branch_id"] != session["working_branch_id"]
        || yoneda_core::fingerprint(&run["policy"])? != session["policy_digest"]
    {
        return Err(Error::new(
            "FENCED",
            "Guided run binding differs from session authority",
        ));
    }
    run["guided"] = expected;
    Ok(())
}
pub(super) fn make(session: &Value, step: &str, ordinal: usize) -> Result<Value> {
    let phase = match step {
        "build" => "build",
        "extend" => "extend",
        "concurrent" => "parallel",
        _ => return Err(bad("Review creates no coding job")),
    };
    let mut binding = json!({"session_id":session["session_id"],"profile_id":PROFILE,"version":session["version"],"step_id":step,"check_phase":phase});
    if step == "concurrent" {
        binding["variant"] = json!(match ordinal {
            0 => "filter",
            1 => "sort",
            _ => return Err(bad("Invalid parallel ordinal")),
        });
    }
    Ok(binding)
}
pub(crate) fn evaluation_binding<S: SqlStore>(db: &S, candidate: &Value) -> Result<Option<Value>> {
    let Some(id) = candidate["run_id"].as_str() else {
        return Ok(None);
    };
    let run = match get(db, "runs", id) {
        Ok(run) => run,
        Err(e) if e.code == "NOT_FOUND" => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(guide) = run.get("guided") else {
        return Ok(None);
    };
    let mut guide = guide.clone();
    if guide["step_id"] == "concurrent" {
        let stored = get(db, "candidates", &string(candidate, "id")?)?;
        if stored["revision"] != candidate["revision"]
            || stored["execution"] != candidate["execution"]
        {
            return Err(Error::new("FENCED", "Guided evaluator candidate changed"));
        }
        let execution = get(db, "executions", &string(candidate, "execution")?)?;
        for record in all(db, "conflicts")? {
            let resolver = record["resolver_candidate_id"] == candidate["id"]
                && record["resolver_execution_id"] == execution["id"]
                && execution["conflict_id"] == record["id"]
                && record["candidate"]["run_id"] == run["id"];
            if resolver || registered_refresh(db, candidate, &record)? {
                guide["check_phase"] = json!("final");
                guide
                    .as_object_mut()
                    .ok_or_else(|| bad("Invalid guided binding"))?
                    .remove("variant");
                break;
            }
        }
    }
    Ok(Some(guide))
}
fn registered_refresh<S: SqlStore>(db: &S, candidate: &Value, record: &Value) -> Result<bool> {
    if record["refreshed_candidate_id"] != candidate["id"] {
        return Ok(false);
    }
    let capture = get(db, "jobs", &string(candidate, "capture_job")?)?;
    Ok(record["status"] == "clean"
        && record["candidate"]["run_id"] == candidate["run_id"]
        && record["candidate"]["execution"] == candidate["execution"]
        && record["candidate_id"] == candidate["refresh_of"]
        && record["target_revision"] == candidate["base"]
        && record["merge_commit"] == candidate["revision"]["commit"]
        && record["expected_version"] == candidate["refresh_expected_version"]
        && candidate["approved_parents"]
            == json!([record["head_commit"], record["candidate_revision"]])
        && capture["id"] == record["job_id"]
        && capture["kind"] == "capture"
        && capture["status"] == "done"
        && capture["payload"]["capture_subtype"] == "refresh_candidate"
        && capture["payload"]["conflict_id"] == record["id"])
}
pub(crate) fn validate_report(job: &Value, report: &Value) -> Result<()> {
    let Some(guide) = job["payload"].get("guided") else {
        return Ok(());
    };
    let object = guide.as_object();
    let phase = guide["check_phase"].as_str();
    if object.is_none()
        || object.is_some_and(|object| {
            object.keys().any(|key| {
                ![
                    "session_id",
                    "profile_id",
                    "version",
                    "step_id",
                    "check_phase",
                    "variant",
                ]
                .contains(&key.as_str())
            })
        })
        || guide["session_id"]
            .as_str()
            .is_none_or(|id| !id.starts_with("guide-session:"))
        || guide["profile_id"] != PROFILE
        || !yoneda_core::guided::supported_version(&guide["version"])
        || !matches!(
            (guide["step_id"].as_str(), phase),
            (Some("build"), Some("build"))
                | (Some("extend"), Some("extend"))
                | (Some("concurrent"), Some("parallel" | "final"))
        )
        || report["guided_check_phase"] != guide["check_phase"]
        || report["guided_check_variant"] != guide["variant"]
        || if phase == Some("parallel") {
            !["filter", "sort"]
                .iter()
                .any(|variant| guide["variant"] == *variant)
        } else {
            guide.get("variant").is_some()
        }
    {
        return Err(Error::new(
            "GUIDED_CHECK_MISMATCH",
            "Guided report differs from the frozen evaluator phase",
        ));
    }
    Ok(())
}
