use super::*;
#[path = "proofs.rs"]
mod proofs;
/// Run statuses after which a run no longer makes progress on its own.
pub(super) const TERMINAL: [&str; 6] = [
    "failed",
    "cancelled",
    "ready",
    "accepted",
    "rejected",
    "needs_attention",
];
pub(super) fn view<S: SqlStore>(db: &S, session: &Value) -> Result<Value> {
    let r = repo(db)?;
    let mut steps = Vec::new();
    let mut unlocked = yoneda_core::fingerprint(&r["policy"])? == session["policy_digest"];
    let mut next = Value::Null;
    let mut choice = None;
    let mut lineage = Vec::new();
    let mut previous: Option<Value> = None;
    for (index, id) in STEPS.iter().enumerate() {
        let saved = &session["steps"][index];
        let ids = saved["run_ids"].as_array().cloned().unwrap_or_default();
        let runs = ids
            .iter()
            .map(|id| {
                get(
                    db,
                    "runs",
                    id.as_str().ok_or_else(|| bad("Invalid guided run"))?,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let phase = match *id {
            "build" => "build",
            "extend" => "extend",
            _ => "final",
        };
        let candidate = if *id == "review" {
            previous.clone()
        } else {
            proofs::candidate(db, &ids, phase)?
        };
        let mut evidence = Vec::new();
        let mut complete = false;
        if let Some(candidate) = &candidate {
            evidence.push(json!({"kind":"checked_source","label":"Captured source independently checked for this phase","verified":true,"candidate_id":candidate["id"],"revision":candidate["revision"]["commit"]}));
            match *id {
                "build" => {
                    let run = get(db, "runs", &string(candidate, "run_id")?)?;
                    let contract = run["team_plan"]["contract"]
                        .as_str()
                        .is_some_and(|contract| !contract.trim().is_empty());
                    evidence.push(json!({"kind":"shared_contract","label":"Recorded shared contract with captured specialist inputs","verified":contract,"authority":"frozen_platform_plan"}));
                    let collaboration = proofs::collaboration(db, candidate)?;
                    evidence.push(json!({"kind":"collaboration","label":"Captured specialists with overlapping trusted harness windows","verified":collaboration}));
                    let qualifying = proofs::choices(db, candidate)?;
                    choice = qualifying.first().cloned();
                    lineage.clear();
                    for record in &qualifying {
                        for id in proofs::lineage(db, candidate, record)? {
                            if !lineage.contains(&id) {
                                lineage.push(id);
                            }
                        }
                    }
                    if let Some(record) = &choice {
                        evidence.push(json!({"kind":"design_choice","label":format!("Recorded design choice: {}",record["label"].as_str().unwrap_or_default()),"verified":true,"record_id":record["id"],"author":record["author"],"authority":"assertion","source_association_verified":true}));
                    }
                    complete = contract && collaboration && choice.is_some();
                }
                "extend" => {
                    let cited = choice.is_some() && proofs::continuation(db, candidate, &lineage)?;
                    evidence.push(json!({"kind":"context_continuation","label":"Earlier design choice opened and cited by this continuation","verified":cited}));
                    complete = cited;
                }
                "concurrent" => {
                    complete = proofs::resolved(db, &ids, candidate)?;
                    evidence.push(json!({"kind":"scoped_resolution","label":"Real overlapping conflict resolved and freshly checked with both enhancements","verified":complete}));
                    // An owner rejection keeps the result as history and reopens this step for
                    // an explicit retry from the pre-concurrency checkpoint.
                    if let Some(rejection) = candidate["owner_rejection"].as_object() {
                        complete = false;
                        evidence.push(json!({"kind":"owner_rejection","label":"Owner rejected this integrated result","verified":false,"decision_id":rejection.get("decision_id"),"reason":rejection.get("reason")}));
                    }
                }
                "review" => {
                    complete = all(db, "decisions")?.iter().any(|decision| {
                        decision["candidate"] == candidate["id"]
                            && decision["status"] == "published"
                            && decision["target"] == candidate["revision"]
                            && r["published_commit"] == candidate["revision"]["commit"]
                    });
                    evidence.push(json!({"kind":"publication_readback","label":"Owner publication with authoritative readback","verified":complete}));
                }
                _ => {}
            }
        }
        let active = runs
            .iter()
            .any(|run| !TERMINAL.contains(&run["status"].as_str().unwrap_or_default()));
        let status = if !unlocked {
            "locked"
        } else if complete {
            "complete"
        } else if runs.is_empty() && saved["started"] != true {
            "ready"
        } else if active || *id == "review" {
            "running"
        } else {
            "needs_attention"
        };
        if next.is_null() && status != "complete" {
            next = json!(id);
        }
        steps.push(json!({"id":id,"status":status,"run_ids":ids,"attempt":super::retry::attempt(saved),"previous_run_ids":saved["previous_run_ids"].as_array().cloned().unwrap_or_default(),"candidate_id":candidate.as_ref().map(|c|&c["id"]),"revision":candidate.as_ref().map(|c|&c["revision"]),"evidence":evidence,"next_action":if status=="ready"{Some("start")}else if *id=="review"&&!complete&&unlocked{Some("review_and_publish")}else{None}}));
        if candidate.is_some() {
            previous = candidate;
        }
        unlocked = unlocked && complete;
    }
    let (revision, version) = match get(
        db,
        "working_branches",
        &string(session, "working_branch_id")?,
    ) {
        Ok(branch) => (
            branch["working_revision"].clone(),
            branch["version"].clone(),
        ),
        Err(e) if e.code == "NOT_FOUND" => (
            json!({"repository":format!("{}/{}",string(&r["remote"],"namespace")?,string(&r["remote"],"name")?),"commit":r["published_commit"]}),
            r["version"].clone(),
        ),
        Err(e) => return Err(e),
    };
    Ok(
        json!({"session_id":session["session_id"],"profile_id":PROFILE,"version":session["version"],"working_branch_id":session["working_branch_id"],"working_revision":revision,"working_version":version,"steps":steps,"next_step":next}),
    )
}
