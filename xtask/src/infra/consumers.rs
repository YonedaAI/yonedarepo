//! Stale queue consumers: a queue the live Worker still consumes but its new config no longer
//! declares makes the deploy fail (`Queue handler is missing [code: 11001]`). They are
//! detached right before that Worker's deploy, printed like host moves; a dry run only says
//! what it would detach.
use super::inventory::{self, Deployable};
use super::live::Client;
use super::spec::Spec;
use crate::process::Result;
use serde_json::Value;

/// One Worker consumer of one queue, as the Queues API lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Consumer {
    pub queue: String,
    pub queue_id: String,
    pub consumer_id: String,
    pub script: String,
}

impl Consumer {
    pub(crate) fn describe(&self) -> String {
        format!("consumer {} of {}", self.script, self.queue)
    }
}

/// Worker consumers of every listed queue (`GET /accounts/:id/queues` results). HTTP pull
/// consumers name no script and are left out.
pub(crate) fn parse(queues: &[Value]) -> Vec<Consumer> {
    let mut out = Vec::new();
    for queue in queues {
        let (Some(name), Some(queue_id)) =
            (queue["queue_name"].as_str(), queue["queue_id"].as_str())
        else {
            continue;
        };
        for consumer in queue["consumers"].as_array().into_iter().flatten() {
            let script = consumer["script"].as_str().or(consumer["service"].as_str());
            if let (Some(script), Some(id)) = (script, consumer["consumer_id"].as_str()) {
                out.push(Consumer {
                    queue: name.into(),
                    queue_id: queue_id.into(),
                    consumer_id: id.into(),
                    script: script.into(),
                });
            }
        }
    }
    out
}

/// The live consumers of `worker` whose queue its config no longer consumes.
pub(crate) fn plan(worker: &Deployable, live: &[Consumer]) -> Vec<Consumer> {
    let declared = inventory::consumers(&worker.config);
    live.iter()
        .filter(|c| c.script == worker.name && !declared.contains(&c.queue))
        .cloned()
        .collect()
}

/// Reads the account's queues, then detaches `worker`'s stale consumers (a dry run only
/// prints them).
pub(crate) async fn detach(
    spec: &Spec,
    token: &str,
    worker: &Deployable,
    dry_run: bool,
) -> Result<Vec<Consumer>> {
    let client = Client::new(token.to_owned());
    let account = format!("/accounts/{}", spec.account_id);
    let queues = client
        .list(&format!("{account}/queues"))
        .await
        .map_err(|error| format!("Reading queue consumers: {error}"))?;
    let stale = plan(worker, &parse(&queues));
    for c in &stale {
        if dry_run {
            println!("Queue consumer: {} (would detach)", c.describe());
            continue;
        }
        println!("Queue consumer: {} (detaching)", c.describe());
        client
            .send(
                reqwest::Method::DELETE,
                &format!(
                    "{account}/queues/{}/consumers/{}",
                    c.queue_id, c.consumer_id
                ),
            )
            .await
            .map_err(|error| format!("Detaching {}: {error}", c.describe()))?;
    }
    Ok(stale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::spec::Lock;
    use serde_json::json;

    fn prod() -> Vec<Deployable> {
        let spec = Spec::parse(include_str!("../../../infra/envs/prod.json")).unwrap();
        let lock: Lock =
            serde_json::from_str(include_str!("../../../infra/envs/prod.lock.json")).unwrap();
        inventory::deployables(&spec, &lock).unwrap()
    }

    #[test]
    fn only_the_workers_own_undeclared_consumers_are_detached() {
        let queue = |name: &str, consumers: serde_json::Value| json!({"queue_name": name, "queue_id": format!("id-{name}"), "consumers": consumers});
        let live = parse(&[
            // Left from the agent layer: the front Worker still consumes its old queues.
            queue(
                "yonedarepo-prod-agents-agent",
                json!([{"script": "yonedarepo-prod-agents", "consumer_id": "c-agent"}]),
            ),
            queue(
                "yonedarepo-prod-agents-capture",
                json!([{"service": "yonedarepo-prod-agents", "consumer_id": "c-capture"}]),
            ),
            // The platform's own declared consumer stays.
            queue(
                "yonedarepo-prod-platform-jobs",
                json!([{"script": "yonedarepo-prod-platform", "consumer_id": "c-jobs"}]),
            ),
            // HTTP pull consumers name no script.
            queue(
                "yonedarepo-prod-platform-checks",
                json!([{"type": "http_pull", "consumer_id": "c-pull"}]),
            ),
            json!({"queue_name": "no-id", "consumers": [{"script": "yonedarepo-prod-agents", "consumer_id": "x"}]}),
        ]);
        assert_eq!(live.len(), 3, "{live:?}");
        let workers = prod();
        let by_role = |role: &str| workers.iter().find(|w| w.role == role).unwrap();
        let stale = plan(by_role("agents"), &live);
        assert_eq!(
            stale
                .iter()
                .map(|c| (c.queue_id.as_str(), c.consumer_id.as_str()))
                .collect::<Vec<_>>(),
            [
                ("id-yonedarepo-prod-agents-agent", "c-agent"),
                ("id-yonedarepo-prod-agents-capture", "c-capture"),
            ]
        );
        assert_eq!(
            stale[0].describe(),
            "consumer yonedarepo-prod-agents of yonedarepo-prod-agents-agent"
        );
        assert!(plan(by_role("platform"), &live).is_empty());
        assert!(plan(by_role("superfan"), &live).is_empty());
    }
}
