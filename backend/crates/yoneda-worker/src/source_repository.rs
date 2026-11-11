//! The source platform's authority for one repository: commits, refs, the transaction log,
//! checks, reviews and landing. Independent of runs and agents (RepositoryAuthority).
use serde_json::{Value, json};
use std::cell::Cell;
use worker::*;
use yoneda_cloudflare::CloudStore;

#[durable_object]
pub struct SourceRepository {
    state: State,
    migrated: Cell<bool>,
}

impl DurableObject for SourceRepository {
    fn new(state: State, _: Env) -> Self {
        Self {
            state,
            migrated: Cell::new(false),
        }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        // The adapter's path, never client input, asked only with REGION_HINT_TEST on.
        if request.path() == "/where" {
            return yoneda_cloudflare::colo_trace().await;
        }
        let body: Value = request.json().await?;
        crate::telemetry::serving(&request);
        let observation = crate::operation_observation::CommandObservation::from_request(
            &request,
            !self.migrated.get(),
        );
        let store = CloudStore::new(self.state.storage());
        // Schema digests are verified once per instance, not on every request.
        if !self.migrated.get() {
            if let Err(e) = yoneda_platform::migrate_repo_store(&store) {
                return Response::from_json(&failure(&e)).map(|r| r.with_status(409));
            }
            self.migrated.set(true);
        }
        // `/batch`: several commands, each with its own credentials and transaction, in one
        // round trip (the adapter's path, never client input). Each result stands alone.
        if request.path() == "/batch" {
            let Value::Array(commands) = body else {
                return invalid("A batch must be a list of commands");
            };
            let results: Vec<Value> = commands
                .into_iter()
                .map(|command| run(&store, command, &observation).unwrap_or_else(|e| failure(&e)))
                .collect();
            return Response::from_json(&results);
        }
        if !body.is_object() {
            return invalid("Command must be an object");
        }
        match run(&store, body, &observation) {
            Ok(value) => Response::from_json(&value),
            Err(e) => Response::from_json(&failure(&e)).map(|r| r.with_status(409)),
        }
    }
}

/// `_principal` and `_workspace` come from the authenticating adapter; time is ours.
fn run(
    store: &CloudStore,
    mut command: Value,
    observation: &crate::operation_observation::CommandObservation,
) -> yoneda_core::Result<Value> {
    if !command.is_object() {
        return Err(yoneda_core::Error::new(
            "INVALID_INPUT",
            "Command must be an object",
        ));
    }
    command["now"] = json!(Date::now().as_millis() as i64);
    let operation = command
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let result = yoneda_platform::execute_migrated(store, command)
        .inspect_err(crate::telemetry::command_failed);
    observation.completed(&operation, result.as_ref().err());
    result
}

fn failure(e: &yoneda_core::Error) -> Value {
    json!({"error":{"code":e.code,"message":e.message}})
}

fn invalid(message: &str) -> Result<Response> {
    Response::from_json(&json!({"error":{"code":"INVALID_INPUT","message":message}}))
        .map(|r| r.with_status(400))
}
