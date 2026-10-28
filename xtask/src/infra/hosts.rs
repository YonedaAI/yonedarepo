//! Host moves: a hostname (Custom Domain) or zone route the spec gives a Worker but another
//! Worker holds is detached right before the deploy that attaches it, since wrangler refuses
//! to take a host from another Worker. `infra up` is the only caller (deploy_env::run).
use super::inventory::{self, Deployable};
use super::live::{Client, Live};
use super::spec::Spec;
use crate::process::Result;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Move {
    /// "domain" (Custom Domain) or "route".
    pub kind: &'static str,
    pub host: String,
    pub from: String,
    pub to: String,
    /// The custom domain or route id to delete.
    pub id: String,
}

impl Move {
    pub(crate) fn describe(&self) -> String {
        format!("{} {}: {} -> {}", self.kind, self.host, self.from, self.to)
    }
}

/// The hosts `worker` declares that another Worker holds in `live`. Fails when a held host
/// has no id to detach it by, or when the hosts section was unreadable.
pub(crate) fn plan(worker: &Deployable, live: &Live) -> Result<Vec<Move>> {
    let mut moves = Vec::new();
    for route in inventory::routes(&worker.config) {
        let (kind, section, holders, ids) = if route.custom_domain {
            ("domain", "Custom domains", &live.domains, &live.domain_ids)
        } else {
            ("route", "Routes", &live.routes, &live.route_ids)
        };
        if live.errors.iter().any(|e| e.starts_with(section)) {
            return Err(format!(
                "Cannot read {section}, so {} cannot be moved",
                route.pattern
            )
            .into());
        }
        let Some(from) = holders.get(&route.pattern).filter(|h| **h != worker.name) else {
            continue;
        };
        let id = ids
            .get(&route.pattern)
            .ok_or_else(|| format!("{kind} {} is held by {from} but has no id", route.pattern))?;
        moves.push(Move {
            kind,
            host: route.pattern.clone(),
            from: from.clone(),
            to: worker.name.clone(),
            id: id.clone(),
        });
    }
    Ok(moves)
}

/// Reads the hosts fresh, then detaches the ones another Worker holds from it. Prints each
/// move; the deploy that follows attaches them.
pub(crate) async fn detach(spec: &Spec, token: &str, worker: &Deployable) -> Result<Vec<Move>> {
    let mut live = Live::default();
    read(&Client::new(token.to_owned()), spec, &mut live).await;
    let moves = plan(worker, &live)?;
    for m in &moves {
        let path = match m.kind {
            "domain" => format!("/accounts/{}/workers/domains/{}", spec.account_id, m.id),
            _ => format!(
                "/zones/{}/workers/routes/{}",
                live.zone_id.as_deref().ok_or("zone id unknown")?,
                m.id
            ),
        };
        println!("Host move: {} (detaching)", m.describe());
        Client::new(token.to_owned())
            .send(reqwest::Method::DELETE, &path)
            .await
            .map_err(|error| format!("Detaching {}: {error}", m.describe()))?;
    }
    Ok(moves)
}

/// Custom domains of the account and routes of the spec's zone, with their ids.
pub(crate) async fn read(client: &Client, spec: &Spec, live: &mut Live) {
    let account = format!("/accounts/{}", spec.account_id);
    let domains = async {
        for domain in client.list(&format!("{account}/workers/domains")).await? {
            if let (Some(host), Some(service)) =
                (domain["hostname"].as_str(), domain["service"].as_str())
            {
                live.domains.insert(host.into(), service.into());
                if let Some(id) = domain["id"].as_str() {
                    live.domain_ids.insert(host.into(), id.into());
                }
            }
        }
        Result::Ok(())
    }
    .await;
    if let Err(error) = domains {
        live.errors.push(format!("Custom domains: {error}"));
    }
    let routes = async {
        let zones = client.get(&format!("/zones?name={}", spec.zone)).await?;
        let zone = zones["result"][0]["id"]
            .as_str()
            .ok_or("zone not found")?
            .to_owned();
        for route in client.get(&format!("/zones/{zone}/workers/routes")).await?["result"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(pattern) = route["pattern"].as_str() {
                let script = route["script"].as_str().unwrap_or("").to_owned();
                live.routes.insert(pattern.into(), script);
                if let Some(id) = route["id"].as_str() {
                    live.route_ids.insert(pattern.into(), id.into());
                }
            }
        }
        live.zone_id = Some(zone);
        Result::Ok(())
    }
    .await;
    if let Err(error) = routes {
        live.errors.push(format!("Routes: {error}"));
    }
}
