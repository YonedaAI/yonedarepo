use super::*;
/// The newest evaluated result for this phase with whether its required checks passed. When
/// `require_pass` (version 1) only passing results count; otherwise checks are reported only.
pub(super) fn candidate<S: SqlStore>(
    db: &S,
    ids: &[Value],
    phase: &str,
    require_pass: bool,
) -> Result<Option<(Value, bool)>> {
    for candidate in all(db, "candidates")?
        .into_iter()
        .rev()
        .filter(|candidate| {
            ids.contains(&candidate["run_id"])
                && (candidate["status"] == "eligible"
                    || (!require_pass && candidate["status"] == "rejected"))
        })
    {
        let evaluation = get(db, "evaluations", &string(&candidate, "evaluation")?)?;
        let capture = get(db, "jobs", &string(&candidate, "capture_job")?)?;
        let expected = binding::evaluation_binding(db, &candidate)?;
        if expected.as_ref().is_none_or(|binding| {
            binding["check_phase"] != phase || evaluation["guided"] != *binding
        }) || evaluation["revision"] != candidate["revision"]
            || evaluation["candidate"] != candidate["id"]
            || evaluation["policy"] != repo(db)?["policy"]["version"]
            || capture["status"] != "done"
            || capture["kind"] != "capture"
            || capture["result"]["revision"] != candidate["revision"]
        {
            continue;
        }
        let policy: yoneda_core::Policy =
            serde_json::from_value(repo(db)?["policy"].clone()).map_err(|e| bad(&e.to_string()))?;
        let passed = evaluation["checks"].as_array().is_some_and(|checks| {
            policy.required_checks.iter().all(|name| {
                checks
                    .iter()
                    .any(|check| check["name"] == *name && check["status"] == "pass")
            })
        });
        if passed || !require_pass {
            return Ok(Some((candidate, passed)));
        }
    }
    Ok(None)
}
fn handoffs<S: SqlStore>(db: &S, candidate: &Value) -> Result<Vec<Value>> {
    let run = get(db, "runs", &string(candidate, "run_id")?)?;
    let mut result = Vec::new();
    for input in candidate["integration_manifest"]["inputs"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let handoff = get(db, "team_handoffs", &string(input, "handoff_id")?)?;
        let execution = get(db, "executions", &string(&handoff, "execution_id")?)?;
        let task_id = execution["team_task"]
            .as_str()
            .unwrap_or(execution["id"].as_str().unwrap_or_default());
        let task = get(db, "team_tasks", task_id)?;
        let capture = get(db, "jobs", &string(&handoff["output"], "capture_job")?)?;
        if candidate["integration_manifest"]["plan_revision"] == run["team_plan_revision"]
            && handoff["run_id"] == run["id"]
            && handoff["authority"] == "captured_revision"
            && execution["team_role"] == "worker"
            && task["revision"] == handoff["output"]["task_revision"]
            && input["revision"] == handoff["output"]["revision"]
            && capture["status"] == "done"
            && capture["kind"] == "capture"
            && capture["result"]["revision"] == input["revision"]
        {
            result.push(handoff);
        }
    }
    Ok(result)
}
pub(super) fn collaboration<S: SqlStore>(db: &S, candidate: &Value) -> Result<bool> {
    let mut intervals = Vec::new();
    for handoff in handoffs(db, candidate)? {
        let eid = string(&handoff, "execution_id")?;
        let rows=db.query("SELECT MIN(CASE WHEN kind='job.progress' AND json_extract(data,'$.progress.stage')='harness_running' THEN at END) AS start,MIN(CASE WHEN kind='execution.transcript' THEN at END) AS end FROM events WHERE json_extract(data,'$.epoch')=? AND ((kind='job.progress' AND json_extract(data,'$.execution_id')=?) OR (kind='execution.transcript' AND json_extract(data,'$.id')=?))",&[handoff["epoch"].clone(),json!(eid),json!(eid)])?;
        if let (Some(start), Some(end)) = (rows[0]["start"].as_i64(), rows[0]["end"].as_i64())
            && start < end
        {
            intervals.push((eid, start, end));
        }
    }
    Ok(intervals
        .iter()
        .enumerate()
        .any(|(index, (id, start, end))| {
            intervals
                .iter()
                .skip(index + 1)
                .any(|(other, left, right)| id != other && (*start).max(*left) < (*end).min(*right))
        }))
}
/// Every captured specialist record that states the stable-identity choice, decisions first.
/// Several can qualify (a UI summary may mention stable IDs); a continuation may cite any of them.
pub(super) fn choices<S: SqlStore>(db: &S, candidate: &Value) -> Result<Vec<Value>> {
    let mut found = Vec::new();
    let sources = handoffs(db, candidate)?;
    for record in all(db, "nodes")?.into_iter().filter(|node| {
        ["proposed_decision", "finding"]
            .iter()
            .any(|kind| node["kind"] == *kind)
            && node["data"]["intent_id"]
                == format!(
                    "intent:{}",
                    candidate["run_id"].as_str().unwrap_or_default()
                )
    }) {
        let statement = record["label"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if statement.contains("stable")
            && statement.contains("id")
            && sources.iter().any(|handoff| {
                handoff["execution_id"] == record["author"]
                    && handoff["epoch"] == record["data"]["epoch"]
            })
        {
            found.push(record);
        }
    }
    found.sort_by_key(|record| record["kind"] != "proposed_decision");
    Ok(found)
}
/// The selected choice plus records that transitively and explicitly supersede it, each authored
/// in the build intent by a captured specialist or by the integrator whose capture is the candidate.
pub(super) fn lineage<S: SqlStore>(
    db: &S,
    candidate: &Value,
    record: &Value,
) -> Result<Vec<Value>> {
    let mut authors = handoffs(db, candidate)?
        .into_iter()
        .map(|handoff| (handoff["execution_id"].clone(), handoff["epoch"].clone()))
        .collect::<Vec<_>>();
    let producer = &get(db, "jobs", &string(candidate, "capture_job")?)?["payload"]["execution"];
    if producer["id"] == candidate["execution"] && producer["epoch"].is_u64() {
        authors.push((producer["id"].clone(), producer["epoch"].clone()));
    }
    let intent = json!(format!("intent:{}", string(candidate, "run_id")?));
    let nodes = all(db, "nodes")?;
    let mut ids = vec![record["id"].clone()];
    while let Some(next) = nodes.iter().find(|node| {
        !ids.contains(&node["id"])
            && ["proposed_decision", "finding"]
                .iter()
                .any(|kind| node["kind"] == *kind)
            && node["data"]["intent_id"] == intent
            && authors
                .iter()
                .any(|(id, epoch)| node["author"] == *id && node["data"]["epoch"] == *epoch)
            && node["data"]["links"].as_array().is_some_and(|links| {
                links
                    .iter()
                    .any(|link| link["relation"] == "supersedes" && ids.contains(&link["target"]))
            })
    }) {
        ids.push(next["id"].clone());
    }
    Ok(ids)
}
/// A continuation specialist must open and cite the same record from the choice's lineage.
pub(super) fn continuation<S: SqlStore>(
    db: &S,
    candidate: &Value,
    lineage: &[Value],
) -> Result<bool> {
    for handoff in handoffs(db, candidate)? {
        let reads = db.query(
            "SELECT data FROM context_access WHERE execution_id=? AND epoch=? AND run_id=? AND stage='opened'",
            &[handoff["execution_id"].clone(), handoff["epoch"].clone(), candidate["run_id"].clone()],
        )?;
        let opened = |id: &Value| {
            reads.iter().any(|row| {
                serde_json::from_str::<Value>(row["data"].as_str().unwrap_or_default()).is_ok_and(
                    |read| {
                        read["targets"]
                            .as_array()
                            .is_some_and(|targets| targets.iter().any(|target| target["id"] == *id))
                    },
                )
            })
        };
        let nodes = all(db, "nodes")?;
        let intent = format!(
            "intent:{}",
            candidate["run_id"].as_str().unwrap_or_default()
        );
        // A task handoff is the agent's own recorded finding; it carries no intent tag, so it
        // belongs to this run only through its team handoff row.
        let in_run = |node: &Value| {
            node["data"]["intent_id"] == intent
                || (node["data"]["authority"] == "assertion"
                    && get(db, "team_handoffs", node["id"].as_str().unwrap_or_default())
                        .is_ok_and(|row| row["run_id"] == candidate["run_id"]))
        };
        let cited = |id: &Value| {
            nodes.iter().any(|node| {
                node["author"] == handoff["execution_id"]
                    && node["data"]["epoch"] == handoff["epoch"]
                    && in_run(node)
                    && ["finding", "proposed_decision"]
                        .iter()
                        .any(|kind| node["kind"] == *kind)
                    && node["data"]["links"]
                        .as_array()
                        .is_some_and(|links| links.iter().any(|link| link["target"] == *id))
            })
        };
        if lineage.iter().any(|id| opened(id) && cited(id)) {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn resolved<S: SqlStore>(db: &S, ids: &[Value], candidate: &Value) -> Result<bool> {
    if ids.len() != 2 {
        return Ok(false);
    }
    let first = get(
        db,
        "runs",
        ids[0].as_str().ok_or_else(|| bad("Invalid guide run"))?,
    )?;
    let second = get(
        db,
        "runs",
        ids[1].as_str().ok_or_else(|| bad("Invalid guide run"))?,
    )?;
    if first["base"] != second["base"]
        || first["guided"]["variant"] != "filter"
        || second["guided"]["variant"] != "sort"
    {
        return Ok(false);
    }
    for conflict in all(db, "conflicts")? {
        if conflict["resolver_candidate_id"] == candidate["id"]
            && conflict["status"] == "resolved"
            && conflict["resolver_evaluation"] == "eligible"
            && ids.contains(&conflict["candidate"]["run_id"])
        {
            let paths = crate::path_lists::load(db, &conflict, "conflict_paths")?;
            let overlaps = crate::path_lists::load(db, &conflict["evidence"], "overlapping_paths")?;
            let other_ids = ids
                .iter()
                .filter(|id| **id != conflict["candidate"]["run_id"])
                .cloned()
                .collect::<Vec<_>>();
            let Some((other, _)) = self::candidate(db, &other_ids, "parallel", true)? else {
                return Ok(false);
            };
            let Some((original, _)) = self::candidate(
                db,
                &[conflict["candidate"]["run_id"].clone()],
                "parallel",
                true,
            )?
            else {
                return Ok(false);
            };
            let branch = get(
                db,
                "working_branches",
                &string(&first, "working_branch_id")?,
            )?;
            let execution = get(db, "executions", &string(candidate, "execution")?)?;
            let capture = get(db, "jobs", &string(candidate, "capture_job")?)?;
            let delta = capture["result"]["resolver_delta_paths"].as_array();
            return Ok(!paths.is_empty()
                && paths.iter().all(|path| overlaps.contains(path))
                && other["revision"]["commit"] == conflict["head_commit"]
                && original["id"] == conflict["candidate_id"]
                && original["revision"]["commit"] == conflict["candidate_revision"]
                && first["base"]["commit"] == conflict["evidence"]["base_commit"]
                && branch["working_revision"] == candidate["revision"]
                && branch["latest_candidate_id"] == candidate["id"]
                && execution["conflict_id"] == conflict["id"]
                && delta.is_some_and(|delta| {
                    !delta.is_empty()
                        && delta.iter().all(|path| {
                            path.as_str()
                                .is_some_and(|path| paths.iter().any(|allowed| allowed == path))
                        })
                }));
        }
    }
    Ok(false)
}
