use super::{Step, steps};
use crate::deploy_guard::{self as guard, Facts, Options};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use serde_json::json;

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";
const OTHER: &str = "fedcba9876543210fedcba9876543210fedcba98";

fn spec(text: &str) -> Spec {
    Spec::parse(text).unwrap()
}
fn dev() -> Spec {
    spec(include_str!("../../../infra/envs/dev.json"))
}
fn prod() -> Spec {
    spec(include_str!("../../../infra/envs/prod.json"))
}
fn workers(spec: &Spec, lock: &str) -> Vec<Deployable> {
    inventory::deployables(spec, &serde_json::from_str::<Lock>(lock).unwrap()).unwrap()
}
fn dev_workers() -> Vec<Deployable> {
    workers(&dev(), include_str!("../../../infra/envs/dev.lock.json"))
}
fn prod_workers() -> Vec<Deployable> {
    workers(&prod(), include_str!("../../../infra/envs/prod.lock.json"))
}
fn evidence(revision: &str, status: &str) -> serde_json::Value {
    json!({"items": [
        {"id": "0", "title": "Live revisions", "status": "pass", "metrics": {"front": revision, "platform": revision}},
        {"id": "1", "title": "Create project", "status": status, "metrics": {}}
    ]})
}
fn good_prod() -> Facts {
    Facts {
        head: HEAD.into(),
        clean: true,
        ref_tips: vec![],
        dev_revisions: vec![("yonedarepo-staging-platform".into(), Some(HEAD.into()))],
        evidence: Some(evidence(HEAD, "pass")),
    }
}
fn confirmed() -> Options {
    Options {
        confirm: true,
        ..Options::default()
    }
}
fn refused(env: &Env, spec: &Spec, facts: &Facts, options: &Options, needle: &str) {
    let error = guard::preflight(env, spec, facts, options)
        .unwrap_err()
        .to_string();
    assert!(error.contains(needle), "expected {needle:?} in {error:?}");
}

#[test]
fn dry_runs_change_nothing_remote() {
    for (env, list) in [(Env::Dev, dev_workers()), (Env::Prod, prod_workers())] {
        let plan = steps(&env, &list, true);
        assert!(
            plan.iter().all(|s| !s.mutates_remote()),
            "{env:?}: {plan:?}"
        );
        let deploys = plan
            .iter()
            .filter(|s| matches!(s, Step::Deploy { dry_run: true, .. }))
            .count();
        assert_eq!(deploys, list.len(), "every Worker is dry-run deployed");
        assert!(!plan.iter().any(|s| matches!(
            s,
            Step::Migrate { .. } | Step::Secrets { .. } | Step::Health { .. }
        )));
    }
}

#[test]
fn real_runs_build_migrate_then_deploy_verify_in_cutover_order() {
    let plan = steps(&Env::Dev, &dev_workers(), false);
    assert_eq!(plan[..2], [Step::BuildWasm, Step::BuildFrontend]);
    let migrations: Vec<&str> = plan
        .iter()
        .filter_map(|s| match s {
            Step::Migrate { database, .. } => Some(database.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        migrations,
        [
            "yonedarepo-staging-platform-index",
            "yonedarepo-staging-agents-index"
        ]
    );
    let first_deploy = plan
        .iter()
        .position(|s| matches!(s, Step::Deploy { .. }))
        .unwrap();
    assert!(
        plan[..first_deploy]
            .iter()
            .any(|s| matches!(s, Step::Migrate { .. }))
    );
    let tail: Vec<Step> = plan[first_deploy..].to_vec();
    assert_eq!(
        tail,
        [
            Step::Deploy {
                worker: 0,
                dry_run: false
            },
            Step::Secrets { worker: 0 },
            Step::Health { worker: 0 },
            Step::Deploy {
                worker: 1,
                dry_run: false
            },
            Step::Secrets { worker: 1 },
            Step::Health { worker: 1 },
            Step::Deploy {
                worker: 2,
                dry_run: false
            },
        ]
    );
    assert!(
        !plan.iter().any(|s| matches!(s, Step::ActiveGate { .. })),
        "dev has no active-run gate"
    );
}

#[test]
fn prod_checks_active_runs_right_before_each_container_rollout() {
    let plan = steps(&Env::Prod, &prod_workers(), false);
    let gate = plan
        .iter()
        .position(|s| *s == Step::ActiveGate { worker: 0 })
        .unwrap();
    assert_eq!(
        plan[gate + 1],
        Step::Deploy {
            worker: 0,
            dry_run: false
        }
    );
    assert!(
        !plan.contains(&Step::ActiveGate { worker: 1 }),
        "sites has no containers"
    );
}

#[test]
fn dirty_tree_and_wrong_ref_are_refused() {
    let dev = dev();
    let facts = Facts {
        head: HEAD.into(),
        clean: false,
        ref_tips: vec![HEAD.into()],
        ..Facts::default()
    };
    refused(
        &Env::Dev,
        &dev,
        &facts,
        &Options::default(),
        "uncommitted changes",
    );
    let facts = Facts {
        clean: true,
        ref_tips: vec![OTHER.into()],
        ..facts
    };
    refused(
        &Env::Dev,
        &dev,
        &facts,
        &Options::default(),
        "is not the tip of dev",
    );
    let facts = Facts {
        ref_tips: vec![],
        ..facts
    };
    refused(
        &Env::Dev,
        &dev,
        &facts,
        &Options::default(),
        "is not the tip of dev",
    );
    let facts = Facts {
        ref_tips: vec![OTHER.into(), HEAD.into()],
        ..facts
    };
    guard::preflight(&Env::Dev, &dev, &facts, &Options::default()).unwrap();
}

#[test]
fn prod_needs_confirm_dev_at_head_and_passing_kit_evidence() {
    let prod = prod();
    guard::preflight(&Env::Prod, &prod, &good_prod(), &confirmed()).unwrap();
    refused(
        &Env::Prod,
        &prod,
        &good_prod(),
        &Options::default(),
        "without --confirm",
    );
    let stale = Facts {
        dev_revisions: vec![("yonedarepo-staging-agents".into(), Some(OTHER.into()))],
        ..good_prod()
    };
    refused(&Env::Prod, &prod, &stale, &confirmed(), "deploy --env dev");
    let down = Facts {
        dev_revisions: vec![("yonedarepo-staging-agents".into(), None)],
        ..good_prod()
    };
    refused(&Env::Prod, &prod, &down, &confirmed(), "nothing reachable");
    let none = Facts {
        dev_revisions: vec![],
        ..good_prod()
    };
    refused(&Env::Prod, &prod, &none, &confirmed(), "no dev Worker");
    let missing = Facts {
        evidence: None,
        ..good_prod()
    };
    refused(
        &Env::Prod,
        &prod,
        &missing,
        &confirmed(),
        "no real-world kit evidence",
    );
    let other_sha = Facts {
        evidence: Some(evidence(OTHER, "pass")),
        ..good_prod()
    };
    refused(
        &Env::Prod,
        &prod,
        &other_sha,
        &confirmed(),
        "not recorded against HEAD",
    );
    let failing = Facts {
        evidence: Some(evidence(HEAD, "fail")),
        ..good_prod()
    };
    refused(
        &Env::Prod,
        &prod,
        &failing,
        &confirmed(),
        "is fail, not pass",
    );
    let skipped = Facts {
        evidence: Some(evidence(HEAD, "skip")),
        ..good_prod()
    };
    refused(
        &Env::Prod,
        &prod,
        &skipped,
        &confirmed(),
        "is skip, not pass",
    );
    let dirty = Facts {
        clean: false,
        ..good_prod()
    };
    refused(
        &Env::Prod,
        &prod,
        &dirty,
        &confirmed(),
        "uncommitted changes",
    );
}

#[test]
fn busy_containers_stop_prod_unless_allowed() {
    let error = guard::active_gate(&Env::Prod, "yonedarepo-dev", 2, &confirmed()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("2 container instance(s) are busy")
    );
    guard::active_gate(&Env::Prod, "yonedarepo-dev", 0, &confirmed()).unwrap();
    let allow = Options {
        allow_active: true,
        ..confirmed()
    };
    guard::active_gate(&Env::Prod, "yonedarepo-dev", 2, &allow).unwrap();
    guard::active_gate(
        &Env::Dev,
        "yonedarepo-staging-agents",
        2,
        &Options::default(),
    )
    .unwrap();
}

#[test]
fn a_revision_mismatch_stops_the_rollout() {
    guard::revision_gate("w", HEAD, Some(HEAD)).unwrap();
    let error = guard::revision_gate("w", HEAD, Some(OTHER))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("expected HEAD 0123456789ab")
            && error.contains("Later Workers were not deployed")
    );
    assert!(
        guard::revision_gate("w", HEAD, None)
            .unwrap_err()
            .to_string()
            .contains("no revision")
    );
}

#[test]
fn options_come_from_flags() {
    let args: Vec<String> = ["deploy", "--env", "prod", "--dry-run", "--confirm"]
        .map(String::from)
        .to_vec();
    let options = Options::from_args(&args);
    assert!(options.dry_run && options.confirm && !options.allow_active);
}
