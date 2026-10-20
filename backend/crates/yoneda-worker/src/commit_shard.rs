//! A commit shard: records of commits built by stateless compute, chosen by commit id so
//! concurrent writers do not queue on the repository authority (yoneda_platform::commit_store).
use serde_json::{Value, json};
use std::cell::Cell;
use worker::*;
use yoneda_cloudflare::CloudStore;

#[durable_object]
pub struct CommitShard {
    state: State,
    migrated: Cell<bool>,
}

impl DurableObject for CommitShard {
    fn new(state: State, _: Env) -> Self {
        Self {
            state,
            migrated: Cell::new(false),
        }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let mut command: Value = request.json().await?;
        if !command.is_object() {
            return Response::from_json(
                &json!({"error":{"code":"INVALID_INPUT","message":"Command must be an object"}}),
            )
            .map(|r| r.with_status(400));
        }
        command["now"] = json!(Date::now().as_millis() as i64);
        let store = CloudStore::new(self.state.storage());
        let outcome = if self.migrated.get() {
            yoneda_platform::execute_commit_store(&store, command)
        } else {
            yoneda_platform::migrate_commit_store(&store).and_then(|()| {
                self.migrated.set(true);
                yoneda_platform::execute_commit_store(&store, command)
            })
        };
        match outcome {
            Ok(value) => Response::from_json(&value),
            Err(e) => Response::from_json(&json!({"error":{"code":e.code,"message":e.message}}))
                .map(|r| r.with_status(409)),
        }
    }
}
