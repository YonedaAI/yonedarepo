use crate::process::Result;
use serde_json::Value;
fn rows<'a>(s: &'a Value, key: &str) -> Result<&'a Vec<Value>> {
    s[key]
        .as_array()
        .ok_or_else(|| format!("Missing {key}").into())
}
pub fn selected(snapshot: &Value) -> Result<(&Value, &Value)> {
    let decision = rows(snapshot, "decisions")?
        .iter()
        .filter(|d| d["status"] == "published")
        .max_by_key(|d| d["created_at"].as_i64())
        .ok_or("No verified canonical publication yet")?;
    let candidate = rows(snapshot, "candidates")?
        .iter()
        .find(|c| c["id"] == decision["candidate"])
        .ok_or("Selected source is missing")?;
    Ok((decision, candidate))
}
pub fn check(snapshot: &Value, events: &[Value], why: &Value) -> Result<()> {
    let (decision, selected) = selected(snapshot)?;
    let rid = &decision["run_id"];
    if !snapshot["repository"]["pending"].is_null()
        || snapshot["repository"]["published_commit"] != selected["revision"]["commit"]
    {
        return Err("Canonical publication is unresolved".into());
    }
    let executions = rows(snapshot, "executions")?;
    let research = executions
        .iter()
        .find(|e| {
            e["run_id"] == *rid
                && e["role"] == "research"
                && e["harness"] == "claude"
                && e["status"] == "completed"
        })
        .ok_or("Selected run has no completed Claude research")?;
    let coding: Vec<_> = executions
        .iter()
        .filter(|e| e["run_id"] == *rid && e["role"] == "coding")
        .collect();
    if coding.len() != 3 || coding.iter().any(|e| e["status"] != "completed") {
        return Err("Selected run needs three completed coding executions; research does not count as coding".into());
    }
    for (strategy, harness) in [
        ("minimal", "codex"),
        ("defensive", "claude"),
        ("maintainable", "codex"),
    ] {
        if !coding
            .iter()
            .any(|e| e["strategy"] == strategy && e["harness"] == harness)
        {
            return Err("Missing required coding approach/harness".into());
        }
    }
    let context = coding[0]["context"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or("Missing shared frozen context")?;
    if coding.iter().any(|e| e["context"] != coding[0]["context"])
        || context.iter().any(|id| {
            !snapshot["artifacts"].as_array().is_some_and(|a| {
                a.iter()
                    .any(|a| a["id"] == *id && a["producer"] == research["id"])
            })
        })
    {
        return Err(
            "Coding context differs or lacks the selected run's research provenance".into(),
        );
    }
    let policy: yoneda_core::Policy =
        serde_json::from_value(snapshot["repository"]["policy"].clone())?;
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    for execution in coding {
        let candidate = rows(snapshot, "candidates")?
            .iter()
            .find(|c| c["execution"] == execution["id"] && c["run_id"] == *rid)
            .ok_or("Coding execution has no independently captured revision")?;
        let evaluation: yoneda_core::Evaluation = serde_json::from_value(
            rows(snapshot, "evaluations")?
                .iter()
                .find(|e| e["id"] == candidate["evaluation"])
                .ok_or("Captured revision has no evaluation")?
                .clone(),
        )?;
        let revision: yoneda_core::Revision =
            serde_json::from_value(candidate["revision"].clone())?;
        let validation = yoneda_core::validate_evaluation(
            &evaluation,
            candidate["id"].as_str().ok_or("Invalid candidate ID")?,
            &revision,
            &policy,
        );
        if let Err(error) = validation
            && (error.code != "CHECKS_FAILED" || candidate["id"] == selected["id"])
        {
            return Err(error.into());
        }
        let jid = format!(
            "job:{}",
            execution["id"].as_str().ok_or("Invalid execution ID")?
        );
        let epoch = execution["epoch"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or("Missing completed attempt epoch")?;
        if context.iter().any(|id| {
            !events.iter().any(|event| {
                event["kind"] == "artifact.retrieved"
                    && event["data"]["execution"] == execution["id"]
                    && event["data"]["artifact"] == *id
                    && event["data"]["epoch"] == epoch
            })
        }) {
            return Err("Shared context was delivered but lacks successful reads by each completed coding attempt".into());
        }
        let start = events
            .iter()
            .find(|e| {
                e["kind"] == "job.progress"
                    && e["data"]["id"] == jid
                    && e["data"]["epoch"] == epoch
                    && e["data"]["progress"]["stage"] == "harness_running"
            })
            .and_then(|e| e["at"].as_i64())
            .ok_or(
                "Missing actual harness-start evidence (queue claims alone do not prove overlap)",
            )?;
        let end = events
            .iter()
            .find(|e| {
                e["data"]["id"] == jid
                    && e["data"]["epoch"] == epoch
                    && e["at"].as_i64().is_some_and(|t| t > start)
                    && ["job.completed", "job.failed", "job.recovered"]
                        .iter()
                        .any(|kind| e["kind"] == *kind)
            })
            .and_then(|e| e["at"].as_i64())
            .ok_or("Missing attempt completion/recovery evidence")?;
        starts.push(start);
        ends.push(end);
    }
    if starts.iter().max() >= ends.iter().min() {
        return Err("The selected run does not prove three overlapping harness attempts".into());
    }
    let nodes = rows(why, "nodes")?;
    let edges = rows(why, "edges")?;
    let assumption = nodes
        .iter()
        .find(|n| {
            n["kind"] == "assumption"
                && n["data"]["statement"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
        })
        .ok_or("Incident history lacks its original assumption")?;
    let incident = nodes
        .iter()
        .find(|n| n["kind"] == "observation" && n["data"]["simulated"] == true)
        .ok_or("No labelled simulated incident traverses the published source")?;
    if why["coverage"] != "recorded"
        || !nodes.iter().any(|n| n["id"] == decision["id"])
        || !nodes
            .iter()
            .any(|n| n["kind"] == "candidate" && n["id"] != selected["id"])
        || !edges.iter().any(|e| {
            e["source"] == incident["id"]
                && e["target"] == assumption["id"]
                && e["relation"] == "challenges"
        })
    {
        return Err("Incident graph does not connect the original assumption, selection and alternative approaches".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests;
