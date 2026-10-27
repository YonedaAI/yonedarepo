//! "Resolve conflict" on a deployment with sandboxes: the adapter starts an ordinary one-agent
//! sandbox run (the owner's start path) whose brief is the conflict, then links it here, so the
//! conflict shows which run is resolving it. The conflict itself is unchanged: the run's
//! candidate is checked and published like any other, on the current head.
use super::support::owner;
use super::*;

pub(super) fn link<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(c)?;
    let id = string(c, "conflict_id")?;
    let mut record = get(db, "conflicts", &id)?;
    let run_id = string(c, "run_id")?;
    let request = string(c, "request_id")?;
    let run = get(db, "runs", &run_id)?;
    if run["runtime"] != super::super::sandbox::TRANSPORT {
        return Err(bad("A conflict resolver run is a sandbox run"));
    }
    let link = json!({"run_id":run_id,"request_id":request});
    if record["sandbox_resolver"]["run_id"] == link["run_id"]
        && record["sandbox_resolver"]["request_id"] == link["request_id"]
    {
        return Ok(record);
    }
    if record["status"] != "unresolved" {
        return Err(Error::new(
            "INVALID_STATE",
            "Only unresolved conflicts can be resolved",
        ));
    }
    record["sandbox_resolver"] = json!({"run_id":run_id,"request_id":request,"started_at":now});
    save(db, "conflicts", &id, &record)?;
    event(
        db,
        "candidate.resolution_requested",
        now,
        json!({"conflict_id":id,"run_id":run_id}),
    )?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::NativeStore;

    fn conflict(db: &NativeStore, status: &str) {
        crate::execute(db, json!({"op":"init","now":1,"id":"repo","name":"Repo","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":yoneda_agents_core::Policy::default()})).unwrap();
        save(
            db,
            "conflicts",
            "conflict",
            &json!({"id":"conflict","status":status}),
        )
        .unwrap();
        save(
            db,
            "runs",
            "resolver",
            &json!({"id":"resolver","runtime":"sandbox-cli-v1"}),
        )
        .unwrap();
        save(
            db,
            "runs",
            "old",
            &json!({"id":"old","workspace_transport":"api-source-v1"}),
        )
        .unwrap();
    }

    fn link_run(db: &NativeStore, run: &str, request: &str) -> Result<Value> {
        link(
            db,
            &json!({"conflict_id":"conflict","run_id":run,"request_id":request}),
            5,
        )
    }

    #[test]
    fn links_one_sandbox_run_to_an_unresolved_conflict_once() {
        let db = NativeStore::memory().unwrap();
        conflict(&db, "unresolved");
        let linked = link_run(&db, "resolver", "r1").unwrap();
        assert_eq!(linked["sandbox_resolver"]["run_id"], "resolver");
        // A retried request is a no-op; a harness run cannot be linked.
        assert_eq!(link_run(&db, "resolver", "r1").unwrap(), linked);
        assert_eq!(
            link_run(&db, "old", "r2").unwrap_err().code,
            "INVALID_INPUT"
        );
        let forged = link(
            &db,
            &json!({"conflict_id":"conflict","run_id":"resolver","request_id":"r3","job_id":"j"}),
            5,
        );
        assert_eq!(forged.unwrap_err().code, "FORBIDDEN");
    }

    #[test]
    fn a_resolved_conflict_takes_no_resolver_run() {
        let db = NativeStore::memory().unwrap();
        conflict(&db, "clean");
        assert_eq!(
            link_run(&db, "resolver", "r1").unwrap_err().code,
            "INVALID_STATE"
        );
    }
}
