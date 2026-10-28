//! The prod cutover: the new prod spec, retired names (orphans and prune), host moves and
//! not-yet-created D1 databases.
use super::hosts;
use super::inventory::{self, Deployable};
use super::live::Live;
use super::plan::{Action, effective_lock};
use super::prune::{deletions, refusal};
use super::retired::{Kind, Retired, declared, orphans};
use super::spec::{Lock, PENDING_D1, Spec};
use serde_json::json;
use std::collections::BTreeSet;

const DEV: &str = include_str!("../../../infra/envs/dev.json");
const DEV_LOCK: &str = include_str!("../../../infra/envs/dev.lock.json");
const PROD: &str = include_str!("../../../infra/envs/prod.json");
const PROD_LOCK: &str = include_str!("../../../infra/envs/prod.lock.json");

fn workers(spec: &str, lock: &str) -> (Spec, Vec<Deployable>) {
    let spec = Spec::parse(spec).unwrap();
    let lock: Lock = serde_json::from_str(lock).unwrap();
    let workers = inventory::deployables(&spec, &lock).unwrap();
    (spec, workers)
}
fn prod() -> (Spec, Vec<Deployable>) {
    workers(PROD, PROD_LOCK)
}
fn dev() -> (Spec, Vec<Deployable>) {
    workers(DEV, DEV_LOCK)
}
fn role<'a>(workers: &'a [Deployable], role: &str) -> &'a Deployable {
    workers.iter().find(|w| w.role == role).unwrap()
}
fn hosts_of(worker: &Deployable) -> Vec<(String, bool)> {
    inventory::routes(&worker.config)
        .into_iter()
        .map(|r| (r.pattern, r.custom_domain))
        .collect()
}
fn every_declared() -> BTreeSet<(Kind, String)> {
    let mut all = declared(&prod().1);
    all.extend(declared(&dev().1));
    all
}

#[test]
fn prod_runs_the_dev_layout_on_the_production_hosts() {
    let (spec, workers) = prod();
    assert_eq!(spec.prefix, "yonedarepo-prod");
    assert_eq!(spec.git_ref.as_deref(), Some("main"));
    assert_eq!(spec.secrets_file, "~/.config/yonedarepo/prod.env");
    let host = |p: &str, domain: bool| (p.to_owned(), domain);
    assert_eq!(
        hosts_of(role(&workers, "platform")),
        [
            host("api.yonedarepo.com", true),
            host("https://api.yonedarepo.com/*", false)
        ]
    );
    assert_eq!(
        hosts_of(role(&workers, "agents")),
        [
            host("yonedarepo.com", true),
            host("www.yonedarepo.com", true),
            host("https://www.yonedarepo.com/*", false)
        ]
    );
    assert_eq!(
        hosts_of(role(&workers, "sites")),
        [
            host("apps.yonedarepo.com", true),
            host("https://*.yonedarepo.com/*", false)
        ]
    );
    assert!(hosts_of(role(&workers, "superfan")).is_empty());
    assert!(
        !workers.iter().any(|w| w.role == "bench"),
        "no bench in prod"
    );

    let platform = &role(&workers, "platform").config;
    assert_eq!(platform["vars"]["LAND_MODE"], "batch");
    assert_eq!(platform["vars"]["WEB_ORIGIN"], "https://yonedarepo.com");
    assert_eq!(platform["ratelimits"][0]["namespace_id"], "1001");
    assert_eq!(platform["placement"]["region"], "aws:us-east-1");
    assert_eq!(
        platform["secrets_store_secrets"],
        json!([{"binding": "REVIEW_MODEL_KEY", "store_id": "3d9115d4fe864c54a792bcb790a763e3", "secret_name": "ZAI"}])
    );
    let check = &platform["containers"][0];
    assert_eq!(check["class_name"], "CheckContainer");
    assert_eq!(check["max_instances"], 4);
    assert_eq!(check["constraints"]["regions"], json!(["ENAM"]));

    let agents = &role(&workers, "agents").config;
    let vars = &agents["vars"];
    assert_eq!(vars["PUBLIC_APP_ORIGIN"], "https://yonedarepo.com");
    assert_eq!(vars["SITE_ORIGIN"], "https://apps.yonedarepo.com");
    assert_eq!(
        vars["SANDBOX_AI_GATEWAY"],
        "f011d0ee02b23cad26b4b38151b204ad/yonedarepo-prod"
    );
    assert_eq!(vars["MANAGED_PROVIDER_KEYS"], "secrets-store");
    assert!(
        vars.get("APP_ORIGIN").is_none() && vars.get("GUIDED_TASK_BOARD_STARTER_REPO").is_none()
    );
    let keys: Vec<&str> = agents["secrets_store_secrets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["secret_name"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["MiMo", "ZAI"], "Claude and Codex stay off in prod");
    assert_eq!(agents["containers"][0]["class_name"], "AgentSandbox");
    assert_eq!(agents["ratelimits"][0]["namespace_id"], "1001");
    assert_eq!(
        role(&workers, "agents").health,
        Some(("https://yonedarepo.com".into(), "yonedarepo".into()))
    );
    assert_eq!(
        role(&workers, "platform").health,
        Some((
            "https://api.yonedarepo.com".into(),
            "yonedarepo-platform".into()
        ))
    );
}

#[test]
fn prod_retired_names_are_exact_and_never_match_a_declared_name() {
    let (spec, _) = prod();
    let retired = &spec.retired;
    assert_eq!(
        retired.prefix, None,
        "the dev env takes over yonedarepo-dev-*"
    );
    for (kind, name) in [
        (Kind::Worker, "yonedarepo-dev"),
        (Kind::Worker, "yonedarepo-apps-dev"),
        (Kind::Worker, "yonedarepo-sites-dev"),
        (Kind::Container, "yonedarepo-dev-executioncontainer"),
        (Kind::Queue, "yoneda-dev-agent"),
        (Kind::Queue, "yoneda-dev-dead-letter"),
        (Kind::D1, "yonedarepo-dev-index"),
        (Kind::R2, "yonedarepo-dev-objects"),
        (Kind::Artifacts, "yoneda-dev"),
    ] {
        assert!(retired.matches(kind, name), "{name}");
    }
    // The dev env after its rename, and kinds other than the listed one.
    for (kind, name) in [
        (Kind::Worker, "yonedarepo-dev-platform"),
        (Kind::Worker, "yonedarepo-dev-agents"),
        (Kind::Container, "yonedarepo-dev-platform-checkcontainer"),
        (Kind::Queue, "yonedarepo-dev-platform-jobs"),
        (Kind::D1, "yonedarepo-dev-platform-index"),
        (Kind::R2, "yonedarepo-dev-agents-objects"),
        (Kind::Workflow, "yonedarepo-dev-platform-import"),
        (Kind::Artifacts, "yonedarepo-dev"),
        (Kind::R2, "yonedarepo-dev"),
    ] {
        assert!(!retired.matches(kind, name), "{name} must stay");
    }
    for (kind, name) in every_declared() {
        assert!(
            !retired.matches(kind, &name),
            "prod retires a declared {name}"
        );
        assert!(
            !dev().0.retired.matches(kind, &name),
            "dev retires a declared {name}"
        );
    }
}

#[test]
fn a_retired_prefix_matches_the_name_and_its_dash_children_only() {
    let retired = Retired {
        prefix: Some("yonedarepo-staging".into()),
        ..Retired::default()
    };
    for name in [
        "yonedarepo-staging",
        "yonedarepo-staging-platform",
        "yonedarepo-staging-agents-dead-letter",
    ] {
        assert!(retired.matches(Kind::Queue, name), "{name}");
    }
    for name in [
        "yonedarepo-stagingx",
        "yonedarepo-dev-platform",
        "yonedarepo-staging2-a",
    ] {
        assert!(!retired.matches(Kind::Worker, name), "{name}");
    }
}

/// The account mid-cutover: old prod, the new prod Workers and dev under its new names.
fn cutover_account() -> Live {
    let mut live = Live::default();
    for name in [
        "yonedarepo-dev",
        "yonedarepo-apps-dev",
        "yonedarepo-sites-dev",
        "yonedarepo-prod-platform",
        "yonedarepo-dev-platform",
        "yonedarepo-platform-dev",
    ] {
        live.workers.insert(name.into(), Default::default());
    }
    live.containers.insert(
        "yonedarepo-dev-executioncontainer".into(),
        json!({"id": "app-old"}),
    );
    live.containers.insert(
        "yonedarepo-dev-platform-checkcontainer".into(),
        json!({"id": "app-dev"}),
    );
    for (queue, consumer) in [
        ("yoneda-dev-agent", "yonedarepo-dev"),
        ("yoneda-dev-dead-letter", ""),
        ("yonedarepo-dev-platform-jobs", "yonedarepo-dev-platform"),
    ] {
        let scripts = live.queues.entry(queue.into()).or_default();
        if !consumer.is_empty() {
            scripts.insert(consumer.into());
        }
    }
    live.d1.insert("yonedarepo-dev-index".into(), "182c".into());
    live.d1
        .insert("yonedarepo-dev-platform-index".into(), "aaaa".into());
    live.r2.insert("yonedarepo-dev-objects".into());
    live.r2.insert("yonedarepo-dev-platform-objects".into());
    live.workflows
        .insert("yonedarepo-dev-platform-import".into());
    live.artifacts
        .insert("yoneda-dev".into(), vec!["r1".into(), "r2".into()]);
    live
}

#[test]
fn orphans_are_exactly_the_old_prod_resources() {
    let (spec, _) = prod();
    let rows = orphans(&spec.retired, &every_declared(), &cutover_account());
    let found: Vec<(&str, &str)> = rows.iter().map(|r| (r.kind, r.name.as_str())).collect();
    assert_eq!(
        found,
        [
            ("worker", "yonedarepo-apps-dev"),
            ("worker", "yonedarepo-dev"),
            ("worker", "yonedarepo-sites-dev"),
            ("container", "yonedarepo-dev-executioncontainer"),
            ("queue", "yoneda-dev-agent"),
            ("queue", "yoneda-dev-dead-letter"),
            ("d1", "yonedarepo-dev-index"),
            ("r2", "yonedarepo-dev-objects"),
            ("artifacts", "yoneda-dev"),
        ]
    );
    assert!(rows.iter().all(|r| r.action == Action::Orphan));
    let worker = rows.iter().find(|r| r.name == "yonedarepo-dev").unwrap();
    assert_eq!(worker.detail, "consumes yoneda-dev-agent");

    // An emptied Artifacts namespace is no longer an orphan.
    let mut emptied = cutover_account();
    emptied.artifacts.insert("yoneda-dev".into(), vec![]);
    let rows = orphans(&spec.retired, &every_declared(), &emptied);
    assert!(!rows.iter().any(|r| r.kind == "artifacts"));
}

#[test]
fn prune_deletes_in_dependency_order_and_refuses_bound_or_unread_rows() {
    let (spec, _) = prod();
    let live = cutover_account();
    let protected = every_declared();
    let rows = orphans(&spec.retired, &protected, &live);
    assert_eq!(refusal(&rows, &protected, &live), None);
    let steps: Vec<String> = deletions(&rows, &live)
        .into_iter()
        .map(|(_, args)| args.join(" "))
        .collect();
    assert_eq!(
        steps,
        [
            "queues consumer remove yoneda-dev-agent yonedarepo-dev",
            "delete yonedarepo-apps-dev --force",
            "delete yonedarepo-dev --force",
            "delete yonedarepo-sites-dev --force",
            "containers delete app-old",
            "artifacts repos delete r1 --namespace yoneda-dev --force",
            "artifacts repos delete r2 --namespace yoneda-dev --force",
            "queues delete yoneda-dev-agent",
            "queues delete yoneda-dev-dead-letter",
            "d1 delete yonedarepo-dev-index --skip-confirmation",
            "r2 bucket delete yonedarepo-dev-objects",
        ]
    );
    assert!(
        !steps.iter().any(|s| s.contains("yonedarepo-dev-platform")
            || s.contains("yonedarepo-prod")
            || s.contains("yonedarepo-platform-dev")),
        "{steps:?}"
    );

    // A retired name that a current spec binds is never deleted.
    let mut bound = protected.clone();
    bound.insert((Kind::R2, "yonedarepo-dev-objects".into()));
    let rows = orphans(&spec.retired, &bound, &live);
    let row = rows
        .iter()
        .find(|r| r.name == "yonedarepo-dev-objects")
        .unwrap();
    assert_eq!(row.action, Action::Drift);
    let reason = refusal(&rows, &bound, &live).unwrap();
    assert!(reason.contains("r2 yonedarepo-dev-objects"), "{reason}");

    let mut unread = live.clone();
    unread.errors.push("Queues: HTTP 403".into());
    let rows = orphans(&spec.retired, &protected, &unread);
    assert!(
        refusal(&rows, &protected, &unread)
            .unwrap()
            .contains("cannot read")
    );
}

fn holding(live: &mut Live, host: &str, holder: &str, domain: bool, id: &str) {
    let (holders, ids) = if domain {
        (&mut live.domains, &mut live.domain_ids)
    } else {
        (&mut live.routes, &mut live.route_ids)
    };
    holders.insert(host.into(), holder.into());
    ids.insert(host.into(), id.into());
}

#[test]
fn hosts_held_by_old_workers_are_moved_and_own_hosts_are_left_alone() {
    let (_, workers) = prod();
    let mut live = Live::default();
    holding(
        &mut live,
        "yonedarepo.com",
        "yonedarepo-dev",
        true,
        "d-apex",
    );
    holding(
        &mut live,
        "www.yonedarepo.com",
        "yonedarepo-dev",
        true,
        "d-www",
    );
    holding(
        &mut live,
        "https://www.yonedarepo.com/*",
        "yonedarepo-dev",
        false,
        "r-www",
    );
    holding(
        &mut live,
        "api.yonedarepo.com",
        "yonedarepo-prod-platform",
        true,
        "d-api",
    );
    holding(
        &mut live,
        "apps.yonedarepo.com",
        "yonedarepo-apps-dev",
        true,
        "d-apps",
    );
    holding(
        &mut live,
        "https://*.yonedarepo.com/*",
        "yonedarepo-apps-dev",
        false,
        "r-wild",
    );
    holding(
        &mut live,
        "https://dev.yonedarepo.com/*",
        "yonedarepo-staging-agents",
        false,
        "r-dev",
    );

    let moves = |role_name: &str| -> Vec<String> {
        hosts::plan(role(&workers, role_name), &live)
            .unwrap()
            .iter()
            .map(|m| format!("{} {}", m.describe(), m.id))
            .collect()
    };
    assert_eq!(
        moves("agents"),
        [
            "domain yonedarepo.com: yonedarepo-dev -> yonedarepo-prod-agents d-apex",
            "domain www.yonedarepo.com: yonedarepo-dev -> yonedarepo-prod-agents d-www",
            "route https://www.yonedarepo.com/*: yonedarepo-dev -> yonedarepo-prod-agents r-www",
        ]
    );
    assert_eq!(
        moves("platform"),
        Vec::<String>::new(),
        "api is already held by the new platform; its unheld route is simply attached"
    );
    assert_eq!(
        moves("sites"),
        [
            "domain apps.yonedarepo.com: yonedarepo-apps-dev -> yonedarepo-prod-sites d-apps",
            "route https://*.yonedarepo.com/*: yonedarepo-apps-dev -> yonedarepo-prod-sites r-wild",
        ]
    );
    assert!(moves("superfan").is_empty());

    let mut no_id = live.clone();
    no_id.domain_ids.remove("yonedarepo.com");
    assert!(hosts::plan(role(&workers, "agents"), &no_id).is_err());
    let mut unread = live.clone();
    unread.errors.push("Routes: HTTP 403".into());
    assert!(hosts::plan(role(&workers, "sites"), &unread).is_err());
}

#[test]
fn pending_d1_entries_generate_but_count_as_not_created() {
    // The lock as it is before the first `infra up` records the real D1 ids.
    let mut pending: serde_json::Value = serde_json::from_str(PROD_LOCK).unwrap();
    for id in pending["d1"].as_object_mut().unwrap().values_mut() {
        *id = json!(PENDING_D1);
    }
    let (spec, workers) = workers(PROD, &pending.to_string());
    let lock: Lock = serde_json::from_value(pending).unwrap();
    let platform = role(&workers, "platform");
    assert_eq!(
        platform.config["d1_databases"][0]["database_id"],
        PENDING_D1
    );
    let mut live = Live::default();
    live.d1
        .insert("yonedarepo-prod-platform-index".into(), "real-id".into());
    let effective = effective_lock(&spec, &lock, &live).unwrap();
    assert_eq!(effective.d1["yonedarepo-prod-platform-index"], "real-id");
    assert_eq!(effective.d1["yonedarepo-prod-agents-index"], "");
    let error = crate::deploy_guard::refuse_pending(&super::spec::Env::Prod, &lock)
        .unwrap_err()
        .to_string();
    assert!(error.contains("infra up --env prod"), "{error}");
    crate::deploy_guard::refuse_pending(&super::spec::Env::Prod, &effective).unwrap();
}

#[test]
fn declared_names_cover_bindings_and_resources() {
    let (_, workers) = prod();
    let names = declared(&workers);
    for (kind, name) in [
        (Kind::Worker, "yonedarepo-prod-superfan"),
        (Kind::Container, "yonedarepo-prod-platform-checkcontainer"),
        (Kind::Container, "yonedarepo-prod-agents-agentsandbox"),
        (Kind::Workflow, "yonedarepo-prod-platform-import"),
        (Kind::Queue, "yonedarepo-prod-platform-dead-letter"),
        (Kind::D1, "yonedarepo-prod-agents-index"),
        (Kind::R2, "yonedarepo-prod-agents-objects"),
        (Kind::Artifacts, "yonedarepo-prod"),
    ] {
        assert!(names.contains(&(kind, name.to_owned())), "{name}");
    }
}

#[test]
fn an_empty_2xx_answer_counts_as_success() {
    use reqwest::StatusCode;
    use serde_json::json;
    let ok = super::live::succeeded;
    // DELETE /workers/domains/:id answers 200 with no body.
    assert!(ok(StatusCode::OK, &serde_json::Value::Null));
    assert!(ok(StatusCode::OK, &json!({"success": true})));
    assert!(!ok(StatusCode::OK, &json!({"success": false})));
    assert!(!ok(StatusCode::NOT_FOUND, &serde_json::Value::Null));
    assert!(!ok(StatusCode::FORBIDDEN, &json!({"success": true})));
}
