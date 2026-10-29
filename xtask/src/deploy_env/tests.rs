use super::{Source, Step, steps, with_consumer_detach, with_host_moves};
use crate::deploy_guard::{self as guard, Facts, Options};
use crate::deploy_image::ImagePlan;
use crate::deploy_live::rollouts;
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use serde_json::json;
use std::collections::BTreeMap;

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
        dirty: vec![],
        ref_tips: vec![HEAD.into()],
        dev_revisions: vec![("yonedarepo-dev-platform".into(), Some(HEAD.into()))],
        evidence: Some(evidence(HEAD, "pass")),
    }
}
fn confirmed() -> Options {
    Options {
        confirm: true,
        ..Options::default()
    }
}
const CHECK: &str = "yonedarepo-dev-platform-checkcontainer";
const EXECUTION: &str = "yonedarepo-dev-agents-executioncontainer";
fn reuse(rollouts: &[&str]) -> Source {
    Source::Local(ImagePlan::Reuse {
        image: "registry.cloudflare.com/acct/yonedarepo-dev-runtime:ef9d08f6e761484c".into(),
        rollouts: rollouts.iter().map(|a| (*a).to_owned()).collect(),
    })
}
fn build() -> Source {
    Source::Local(ImagePlan::Build {
        reason: "runtime inputs changed".into(),
        rollouts: vec![EXECUTION.into(), CHECK.into()],
    })
}
fn refused(env: &Env, spec: &Spec, facts: &Facts, options: &Options, needle: &str) {
    let error = guard::preflight(env, spec, facts, options)
        .unwrap_err()
        .to_string();
    assert!(error.contains(needle), "expected {needle:?} in {error:?}");
}

#[test]
fn dry_runs_change_nothing_remote() {
    let cases = [
        (Env::Dev, dev_workers(), Source::Dockerfile),
        (Env::Dev, dev_workers(), Source::Prebuilt),
        (Env::Dev, dev_workers(), reuse(&[])),
        (Env::Dev, dev_workers(), reuse(&[CHECK])),
        (Env::Dev, dev_workers(), build()),
        (Env::Prod, prod_workers(), Source::Dockerfile),
        (Env::Prod, prod_workers(), Source::Prebuilt),
    ];
    for (env, list, source) in cases {
        let plan = steps(&env, &list, true, &source);
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
fn prebuilt_runs_install_push_and_record_instead_of_building() {
    let plan = steps(&Env::Dev, &dev_workers(), false, &Source::Prebuilt);
    assert_eq!(
        plan[..3],
        [Step::InstallPrebuilt, Step::PushImage, Step::RecordImage]
    );
    assert!(
        !plan
            .iter()
            .any(|s| matches!(s, Step::BuildWasm | Step::BuildFrontend))
    );
    let built = steps(&Env::Dev, &dev_workers(), false, &Source::Dockerfile);
    assert_eq!(plan[3..], built[2..], "the rest of the plan is unchanged");

    let dry = steps(&Env::Dev, &dev_workers(), true, &Source::Prebuilt);
    assert_eq!(dry[0], Step::InstallPrebuilt);
    assert!(dry.iter().all(|s| !s.mutates_remote()), "{dry:?}");
}

#[test]
fn prebuilt_runs_without_containers_push_nothing() {
    let plain: Vec<Deployable> = dev_workers()
        .into_iter()
        .filter(|w| !w.has_containers)
        .collect();
    let plan = steps(&Env::Dev, &plain, false, &Source::Prebuilt);
    assert!(!plan.contains(&Step::PushImage) && !plan.contains(&Step::RecordImage));
}

#[test]
fn real_runs_build_migrate_then_deploy_verify_in_cutover_order() {
    let plan = steps(&Env::Dev, &dev_workers(), false, &Source::Dockerfile);
    assert_eq!(plan[..2], [Step::BuildWasm, Step::BuildFrontend]);
    let migrations: Vec<&str> = plan
        .iter()
        .filter_map(|s| match s {
            Step::Migrate { database, .. } => Some(database.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(migrations, ["yonedarepo-dev-platform-index"]);
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
    let d = |worker| Step::Deploy {
        worker,
        dry_run: false,
    };
    assert_eq!(
        tail,
        [
            d(0),
            Step::Secrets { worker: 0 },
            d(1),
            Step::Secrets { worker: 1 },
            Step::Health { worker: 1 },
            d(2),
            Step::Secrets { worker: 2 },
            Step::Health { worker: 2 },
            d(3),
            Step::Secrets { worker: 3 },
            Step::Health { worker: 3 },
            d(4),
            Step::Secrets { worker: 4 },
        ],
        "superfan (no /health), platform, agents-managed (optional secrets), agents, bench (BENCH_KEY, no /health)"
    );
    assert!(
        !plan.iter().any(|s| matches!(s, Step::ActiveGate { .. })),
        "dev has no active-run gate"
    );
}

#[test]
fn a_workstation_deploy_reusing_the_image_builds_no_image_and_ends_with_the_smoke() {
    let plan = steps(&Env::Dev, &dev_workers(), false, &reuse(&[]));
    let mut expected = steps(&Env::Dev, &dev_workers(), false, &Source::Dockerfile);
    expected.push(Step::Smoke);
    assert_eq!(
        plan, expected,
        "no image build, push, record or rollout gate"
    );
}

#[test]
fn a_workstation_rollout_is_gated_right_before_the_first_container_worker() {
    let d = |worker| Step::Deploy {
        worker,
        dry_run: false,
    };
    for source in [reuse(&[CHECK]), build()] {
        let plan = steps(&Env::Dev, &dev_workers(), false, &source);
        let first_container = plan.iter().position(|s| *s == d(1)).unwrap();
        assert_eq!(plan[first_container - 1], Step::RolloutGate, "{plan:?}");
        assert!(plan.iter().position(|s| *s == d(0)).unwrap() < first_container);
        assert_eq!(plan.last(), Some(&Step::Smoke));
    }
}

#[test]
fn a_workstation_build_is_gated_then_built_pushed_and_recorded_before_migrations() {
    let plan = steps(&Env::Dev, &dev_workers(), false, &build());
    assert_eq!(
        plan[..6],
        [
            Step::BuildWasm,
            Step::BuildFrontend,
            Step::RolloutGate,
            Step::BuildImage,
            Step::PushImage,
            Step::RecordImage
        ]
    );
    assert!(matches!(plan[6], Step::Migrate { .. }));
    let dry = steps(&Env::Dev, &dev_workers(), true, &build());
    assert!(
        !dry.iter()
            .any(|s| matches!(s, Step::BuildImage | Step::PushImage | Step::Smoke)),
        "a dry run builds and pushes no image: {dry:?}"
    );
    assert!(
        dry.contains(&Step::RolloutGate),
        "a dry run reports busy containers"
    );
}

#[test]
fn prod_checks_active_runs_right_before_each_container_rollout() {
    let workers = prod_workers();
    let roles: Vec<&str> = workers.iter().map(|w| w.role.as_str()).collect();
    assert_eq!(roles, ["superfan", "platform", "agents-managed", "agents"]);
    let plan = steps(&Env::Prod, &workers, false, &Source::Dockerfile);
    for (index, worker) in workers.iter().enumerate() {
        let gate = plan
            .iter()
            .position(|s| *s == Step::ActiveGate { worker: index });
        assert_eq!(gate.is_some(), worker.has_containers, "{}", worker.name);
        if let Some(gate) = gate {
            assert_eq!(
                plan[gate + 1],
                Step::Deploy {
                    worker: index,
                    dry_run: false
                }
            );
        }
    }
    assert!(workers[1].has_containers);
    assert!(!workers[0].has_containers && !workers[2].has_containers && !workers[3].has_containers);
}

#[test]
fn prod_checks_the_retired_workers_containers_before_the_first_deploy() {
    let plan = steps(&Env::Prod, &prod_workers(), false, &Source::Dockerfile);
    let gate = plan.iter().position(|s| *s == Step::RetiredGate).unwrap();
    let first_deploy = plan
        .iter()
        .position(|s| matches!(s, Step::Deploy { .. }))
        .unwrap();
    let last_migration = plan
        .iter()
        .rposition(|s| matches!(s, Step::Migrate { .. }))
        .unwrap();
    assert!(last_migration < gate && gate < first_deploy, "{plan:?}");
    assert_eq!(plan.iter().filter(|s| **s == Step::RetiredGate).count(), 1);
    let dev = steps(&Env::Dev, &dev_workers(), false, &Source::Dockerfile);
    assert!(!dev.contains(&Step::RetiredGate));
}

#[test]
fn infra_up_moves_each_workers_hosts_right_before_its_deploy() {
    let workers = prod_workers();
    let plan = with_host_moves(
        steps(&Env::Prod, &workers, false, &Source::Dockerfile),
        &workers,
    );
    for (index, worker) in workers.iter().enumerate() {
        let deploy = plan
            .iter()
            .position(|s| matches!(s, Step::Deploy { worker, .. } if *worker == index))
            .unwrap();
        let moved = plan[deploy - 1] == Step::MoveHosts { worker: index };
        assert_eq!(
            moved,
            !inventory::routes(&worker.config).is_empty(),
            "{}",
            worker.name
        );
    }
    assert!(Step::MoveHosts { worker: 0 }.mutates_remote());
    assert!(
        !steps(&Env::Prod, &workers, false, &Source::Dockerfile)
            .iter()
            .any(|s| matches!(s, Step::MoveHosts { .. })),
        "a plain deploy moves no host"
    );
}

#[test]
fn dirty_tree_and_wrong_ref_are_refused() {
    let dev = dev();
    let facts = Facts {
        head: HEAD.into(),
        dirty: vec!["?? deploy.txt".into()],
        ref_tips: vec![HEAD.into()],
        ..Facts::default()
    };
    refused(
        &Env::Dev,
        &dev,
        &facts,
        &Options::default(),
        "uncommitted changes (?? deploy.txt)",
    );
    let facts = Facts {
        dirty: vec![],
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
        dev_revisions: vec![("yonedarepo-dev-agents".into(), Some(OTHER.into()))],
        ..good_prod()
    };
    refused(&Env::Prod, &prod, &stale, &confirmed(), "deploy --env dev");
    let down = Facts {
        dev_revisions: vec![("yonedarepo-dev-agents".into(), None)],
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
        dirty: vec!["?? deploy.txt".into()],
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
fn busy_containers_stop_a_workstation_rollout_unless_allowed() {
    let busy = vec![(EXECUTION.to_owned(), 2), (CHECK.to_owned(), 0)];
    let error = guard::rollout_gate(&busy, &Options::default())
        .unwrap_err()
        .to_string();
    assert!(error.contains(&format!("{EXECUTION}: 2")), "{error}");
    assert!(!error.contains(CHECK), "idle apps are not listed: {error}");
    let allowed = Options {
        allow_active: true,
        ..Options::default()
    };
    guard::rollout_gate(&busy, &allowed).unwrap();
    let dry = Options {
        dry_run: true,
        ..Options::default()
    };
    guard::rollout_gate(&busy, &dry).unwrap();
    guard::rollout_gate(&[(CHECK.to_owned(), 0)], &Options::default()).unwrap();
}

#[test]
fn the_always_on_ssh_gateway_never_stops_a_rollout_but_is_noted() {
    const GATEWAY: &str = "yonedarepo-dev-platform-sshgateway";
    let platform = dev_workers()
        .into_iter()
        .find(|w| w.role == "platform")
        .unwrap();
    assert_eq!(
        platform.always_on.get(GATEWAY).map(String::as_str),
        Some("open SSH sessions")
    );
    let prod_platform = prod_workers()
        .into_iter()
        .find(|w| w.role == "platform")
        .unwrap();
    assert!(
        prod_platform
            .always_on
            .keys()
            .all(|app| app.ends_with("-sshgateway"))
    );
    assert_eq!(prod_platform.always_on.len(), 1);

    // The gateway's one instance (its tunnel) is not busy work; a busy check still is.
    let live = vec![(CHECK.to_owned(), 0), (GATEWAY.to_owned(), 1)];
    let (busy, notes) = guard::counted(live, &platform.always_on);
    assert_eq!(busy, vec![(CHECK.to_owned(), 0)]);
    assert_eq!(notes.len(), 1);
    assert!(
        notes[0].contains(GATEWAY) && notes[0].contains("open SSH sessions drop"),
        "{notes:?}"
    );
    guard::rollout_gate(&busy, &Options::default()).unwrap();
    let live = vec![(CHECK.to_owned(), 2), (GATEWAY.to_owned(), 1)];
    let (busy, _) = guard::counted(live, &platform.always_on);
    let error = guard::rollout_gate(&busy, &Options::default())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains(&format!("{CHECK}: 2")) && !error.contains(GATEWAY),
        "{error}"
    );
    // An idle gateway drops nothing, so it gets no note.
    let (_, notes) = guard::counted(vec![(GATEWAY.to_owned(), 0)], &platform.always_on);
    assert!(notes.is_empty());
}

#[test]
fn an_always_on_class_must_be_a_declared_container() {
    let mut spec: serde_json::Value =
        serde_json::from_str(include_str!("../../../infra/envs/dev.json")).unwrap();
    let platform = spec["workers"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|w| w["role"] == "platform")
        .unwrap();
    platform["always_on"] = json!({"SshGatewayTypo": "open SSH sessions"});
    let lock =
        serde_json::from_str::<Lock>(include_str!("../../../infra/envs/dev.lock.json")).unwrap();
    let error = inventory::deployables(&Spec::parse(&spec.to_string()).unwrap(), &lock)
        .unwrap_err()
        .to_string();
    assert!(error.contains("SshGatewayTypo is not declared"), "{error}");
}

#[test]
fn ci_skips_its_deploy_only_when_every_worker_already_runs_the_commit() {
    let live = |platform: Option<&str>, agents: Option<&str>| {
        vec![
            (
                "yonedarepo-dev-platform".to_owned(),
                platform.map(str::to_owned),
            ),
            (
                "yonedarepo-dev-agents".to_owned(),
                agents.map(str::to_owned),
            ),
        ]
    };
    match guard::live_check(HEAD, &live(Some(HEAD), Some(HEAD))) {
        guard::LiveCheck::Skip(line) => {
            assert!(
                line.contains("Deploy skipped") && line.contains(&HEAD[..12]),
                "{line}"
            )
        }
        other => panic!("expected a skip, got {other:?}"),
    }
    for revisions in [
        live(Some(HEAD), Some(OTHER)),
        live(None, Some(HEAD)),
        live(Some(OTHER), Some(OTHER)),
        vec![],
    ] {
        assert!(
            matches!(
                guard::live_check(HEAD, &revisions),
                guard::LiveCheck::Deploy(_)
            ),
            "{revisions:?}"
        );
    }
    let guard::LiveCheck::Deploy(line) = guard::live_check(HEAD, &live(None, Some(OTHER))) else {
        panic!("expected a deploy");
    };
    assert!(
        line.contains("nothing reachable") && line.contains(&OTHER[..12]),
        "{line}"
    );
}

#[test]
fn busy_containers_stop_prod_unless_allowed() {
    let error = guard::active_gate(&Env::Prod, "yonedarepo-dev", 2, &confirmed()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("2 container instance(s) are active")
    );
    guard::active_gate(&Env::Prod, "yonedarepo-dev", 0, &confirmed()).unwrap();
    let allow = Options {
        allow_active: true,
        ..confirmed()
    };
    guard::active_gate(&Env::Prod, "yonedarepo-dev", 2, &allow).unwrap();
    guard::active_gate(&Env::Dev, "yonedarepo-dev-agents", 2, &Options::default()).unwrap();
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
    let options = Options::from_args(&args).unwrap();
    assert!(options.dry_run && options.confirm && !options.allow_active);
}

#[test]
fn prod_deploys_only_the_tip_of_main() {
    let prod = prod();
    assert_eq!(prod.git_ref.as_deref(), Some("main"));
    assert_eq!(dev().git_ref.as_deref(), Some("dev"));
    let off_main = Facts {
        ref_tips: vec![OTHER.into()],
        ..good_prod()
    };
    refused(
        &Env::Prod,
        &prod,
        &off_main,
        &confirmed(),
        "is not the tip of main",
    );
}

#[test]
fn deploy_without_an_env_is_refused_and_the_legacy_env_is_gone() {
    let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let error = Env::from_args(&args(&["deploy"])).unwrap_err().to_string();
    assert!(error.contains("Missing --env"), "{error}");
    assert!(Env::from_args(&args(&["deploy", "--confirm"])).is_err());
    let error = Env::from_args(&args(&["deploy", "--env", "prod-legacy", "--confirm"]))
        .unwrap_err()
        .to_string();
    assert!(error.contains("Unknown environment"), "{error}");
}

#[test]
fn the_browser_item_must_pass_whenever_the_kit_recorded_it() {
    let with_browser = |status: &str| {
        let mut evidence = evidence(HEAD, "pass");
        evidence["items"].as_array_mut().unwrap().push(
            json!({"id": guard::BROWSER_ITEM, "title": "Browser", "status": status, "metrics": {}}),
        );
        evidence
    };
    guard::evidence_passes(Some(&with_browser("pass")), HEAD).unwrap();
    for status in ["fail", "skip"] {
        let error = guard::evidence_passes(Some(&with_browser(status)), HEAD)
            .unwrap_err()
            .to_string();
        assert!(error.contains("kit item browser"), "{error}");
    }
    // Not yet required (guard::BROWSER_REQUIRED): evidence without the item still passes.
    guard::evidence_passes(Some(&evidence(HEAD, "pass")), HEAD).unwrap();
    let no_item_zero = json!({"items": [{"id": "browser", "status": "pass"}]});
    assert!(guard::evidence_passes(Some(&no_item_zero), HEAD).is_err());
}

#[test]
fn the_summary_shows_which_container_apps_rolled_out() {
    let workers = dev_workers();
    let platform = workers.iter().find(|w| w.role == "platform").unwrap();
    let app = "yonedarepo-dev-platform-checkcontainer".to_string();
    // Every declared app is listed, the SSH gateway too (its own image: often no rollout).
    let gateway = "yonedarepo-dev-platform-sshgateway".to_string();
    let before = BTreeMap::from([(app.clone(), 1), (gateway.clone(), 7)]);
    let after = BTreeMap::from([(app.clone(), 2), (gateway.clone(), 7)]);
    assert_eq!(
        rollouts(platform, Some(&before), Some(&after)),
        format!("{app} v1 -> v2 (rolled out); {gateway} v7 (no rollout)")
    );
    assert_eq!(
        rollouts(platform, Some(&before), Some(&before)),
        format!("{app} v1 (no rollout); {gateway} v7 (no rollout)")
    );
    assert_eq!(
        rollouts(platform, None, None),
        format!("{app} ? (no rollout); {gateway} ? (no rollout)")
    );
    let front = workers.iter().find(|w| w.role == "agents").unwrap();
    assert_eq!(rollouts(front, Some(&before), Some(&after)), "-");
}

#[test]
fn stale_queue_consumers_are_detached_right_before_each_deploy_and_only_listed_in_a_dry_run() {
    for dry_run in [false, true] {
        let workers = prod_workers();
        let plan = with_consumer_detach(steps(&Env::Prod, &workers, dry_run, &Source::Dockerfile));
        for index in 0..workers.len() {
            let deploy = plan
                .iter()
                .position(|s| {
                    *s == Step::Deploy {
                        worker: index,
                        dry_run,
                    }
                })
                .unwrap();
            assert_eq!(
                plan[deploy - 1],
                Step::DetachConsumers {
                    worker: index,
                    dry_run
                },
                "{plan:?}"
            );
        }
        assert_eq!(
            plan.iter().any(Step::mutates_remote),
            !dry_run,
            "a dry run detaches nothing: {plan:?}"
        );
    }
}

#[test]
fn instances_still_starting_are_reported_but_not_busy() {
    let info = json!({"health": {"instances": {"active": 1, "assigned": 2, "starting": 4, "scheduling": 1, "stopped": 9}}});
    assert_eq!(crate::deploy_live::instance_counts(&info), (3, 5));
    assert_eq!(crate::deploy_live::instance_counts(&json!({})), (0, 0));
}
