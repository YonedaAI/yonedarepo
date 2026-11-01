//! A commit shard: records of commits built by stateless compute, chosen by commit id so
//! concurrent writers do not queue on the repository authority (yoneda_platform::commit_store).
//!
//! `store_erase` empties a deleted repository's shard for good. A shard has no tombstone of
//! its own and `git_status` wakes all 64 on every read, even of a deleted repository, so
//! without a seal the next wake would migrate an empty schema back, and a commit begun before
//! the deletion could still be recorded. The seal is one storage key (a repository's shards
//! are all migrated at creation, so it replaces more than it adds), read once per instance
//! before any migration.
use serde_json::{Value, json};
use std::cell::Cell;
use std::time::Duration;
use worker::*;
use yoneda_cloudflare::CloudStore;

const SEAL: &str = "erased";

#[durable_object]
pub struct CommitShard {
    state: State,
    migrated: Cell<bool>,
    /// Requests this instance is serving now (a request that finds others waits on them).
    serving: Cell<u32>,
}

impl DurableObject for CommitShard {
    fn new(state: State, _: Env) -> Self {
        Self {
            state,
            migrated: Cell::new(false),
            serving: Cell::new(0),
        }
    }

    async fn fetch(&self, request: Request) -> Result<Response> {
        // The adapter's path, never client input, asked only with REGION_HINT_TEST on.
        if request.path() == "/where" {
            return yoneda_cloudflare::colo_trace().await;
        }
        let others = self.serving.get();
        self.serving.set(others + 1);
        let response = self.serve(request, others).await;
        self.serving.set(self.serving.get().saturating_sub(1));
        response
    }
}

impl CommitShard {
    async fn serve(&self, mut request: Request, others: u32) -> Result<Response> {
        let received_at = Date::now().as_millis();
        // The first request of this instance pays its start (and the migration check).
        let fresh = !self.migrated.get();
        let mut command: Value = request.json().await?;
        let read_at = Date::now().as_millis();
        if !command.is_object() {
            return Response::from_json(
                &json!({"error":{"code":"INVALID_INPUT","message":"Command must be an object"}}),
            )
            .map(|r| r.with_status(400));
        }
        if command["op"] == "store_erase" && command["_system"] == "commits" {
            return match yoneda_platform::require_free_to_erase(&command) {
                Ok(()) => self.erase().await,
                Err(e) => {
                    Response::from_json(&json!({"error":{"code":e.code,"message":e.message}}))
                        .map(|r| r.with_status(409))
                }
            };
        }
        if fresh && self.state.storage().get::<bool>(SEAL).await?.is_some() {
            return Response::from_json(
                &json!({"error":{"code":"GONE","message":"Repository was deleted"}}),
            )
            .map(|r| r.with_status(409));
        }
        let timing = command["timing"] == true;
        command["now"] = json!(read_at as i64);
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
            Ok(mut value) => {
                if timing {
                    value["timing"] = self.timing(received_at, read_at, fresh, others).await?;
                }
                Response::from_json(&value)
            }
            Err(e) => Response::from_json(&json!({"error":{"code":e.code,"message":e.message}}))
                .map(|r| r.with_status(409)),
        }
    }

    /// Empties this shard and seals it (repeatable; see the module comment). All of its
    /// storage goes in one call, atomically: nothing here keeps a tombstone.
    async fn erase(&self) -> Result<Response> {
        let storage = self.state.storage();
        storage.delete_all().await?;
        storage.put(SEAL, true).await?;
        self.migrated.set(false);
        Response::from_json(&json!({ "erased": true }))
    }

    /// Where this request's time went, in this instance's clock. A Worker's clock moves only
    /// across I/O, so a zero timer closes the SQL work (and anything this isolate ran
    /// meanwhile) before `sync` waits for the transaction to be durable: the reply waits on
    /// that anyway (the output gate), so waiting here only makes it visible.
    async fn timing(
        &self,
        received_at: u64,
        read_at: u64,
        fresh: bool,
        others: u32,
    ) -> Result<Value> {
        Delay::from(Duration::ZERO).await;
        let sql_at = Date::now().as_millis();
        self.state.storage().sync().await?;
        let replied_at = Date::now().as_millis();
        Ok(json!({
            "received_at": received_at,
            "body_ms": read_at.saturating_sub(received_at),
            "sql_ms": sql_at.saturating_sub(read_at),
            "sync_ms": replied_at.saturating_sub(sql_at),
            "replied_at": replied_at,
            "fresh": fresh,
            "inflight": others,
        }))
    }
}
