use super::*;
use crate::deploy_evidence::{FULL_KIT, full_kit_passes};
use crate::deploy_guard::{self as guard, Options};
use crate::infra::spec::{Env, Spec};
use serde_json::json;
use std::collections::BTreeSet;

const REPO: &str = "YonedaAI/yonedarepo";
const MERGE: &str = "0123456789abcdef0123456789abcdef01234567";
const PR_HEAD: &str = "fedcba9876543210fedcba9876543210fedcba98";
const TREE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn prod() -> Spec {
    Spec::parse(include_str!("../../../infra/envs/prod.json")).unwrap()
}
fn options() -> Options {
    Options {
        confirm: true,
        ship_head: Some(PR_HEAD.into()),
        ..Options::default()
    }
}
fn run() -> Value {
    json!({
        "id": 123, "run_attempt": 1, "event": "pull_request", "conclusion": "success", "head_sha": PR_HEAD, "head_branch": "dev",
        "head_repository": {"full_name": REPO}, "path": ".github/workflows/ci.yml",
        "pull_requests": [{"head":{"sha":PR_HEAD,"ref":"dev"},"base":{"ref":"main"}}]
    })
}
fn jobs() -> Value {
    json!({"total_count":1,"jobs":[{"name":"Ship gate","run_id":123,"run_attempt":1,"head_sha":PR_HEAD,"status":"completed","conclusion":"success"}]})
}
fn ship() -> ShipFacts {
    ShipFacts {
        repo: REPO.into(),
        pr_head: PR_HEAD.into(),
        tree: Some(TREE.into()),
        runs: vec![run()],
        gates: vec![final_gate(&run(), &jobs(), false).unwrap()],
    }
}
fn facts(ship: Option<ShipFacts>) -> Facts {
    Facts {
        head: MERGE.into(),
        head_tree: TREE.into(),
        ref_tips: vec![MERGE.into()],
        ship,
        ..Facts::default()
    }
}
fn refused(ship: ShipFacts, needle: &str) {
    let error = guard::preflight(&Env::Prod, &prod(), &facts(Some(ship)), &options())
        .unwrap_err()
        .to_string();
    assert!(error.contains(needle), "expected {needle:?} in {error:?}");
}

#[test]
fn release_ci_suffices_without_live_statuses_or_local_kit() {
    let ship = ship();
    guard::preflight(&Env::Prod, &prod(), &facts(Some(ship)), &options()).unwrap();
}

#[test]
fn merged_ci_run_remains_valid_after_github_removes_pull_association() {
    let mut merged = run();
    merged["pull_requests"] = json!([]);
    let ship = ShipFacts {
        runs: vec![merged],
        ..ship()
    };
    guard::preflight(&Env::Prod, &prod(), &facts(Some(ship)), &options()).unwrap();
}

#[test]
fn direct_prod_deploy_requires_the_ci_release_path_even_with_passing_local_evidence() {
    let mut facts = facts(Some(ship()));
    facts.evidence = Some(full_kit(Some(TREE), MERGE));
    let direct = Options {
        confirm: true,
        ..Options::default()
    };
    let error = guard::preflight(&Env::Prod, &prod(), &facts, &direct).unwrap_err();
    assert!(error.to_string().contains("CI release workflow"), "{error}");
}

#[test]
fn ship_mode_never_passes_without_its_facts_or_confirm_or_on_dev() {
    let error = guard::preflight(&Env::Prod, &prod(), &facts(None), &options()).unwrap_err();
    assert!(error.to_string().contains("release CI proof"), "{error}");
    let unconfirmed = Options {
        confirm: false,
        ..options()
    };
    let error = guard::preflight(&Env::Prod, &prod(), &facts(Some(ship())), &unconfirmed);
    assert!(error.unwrap_err().to_string().contains("--confirm"));
    let dev = Spec::parse(include_str!("../../../infra/envs/dev.json")).unwrap();
    let on_dev = Facts {
        ref_tips: vec![MERGE.into()],
        ..facts(None)
    };
    let error = guard::preflight(&Env::Dev, &dev, &on_dev, &options()).unwrap_err();
    assert!(error.to_string().contains("--ship-head"), "{error}");
}

#[test]
fn the_other_guards_still_hold_in_ship_mode() {
    let dirty = Facts {
        dirty: vec![" M file".into()],
        ..facts(Some(ship()))
    };
    assert!(guard::preflight(&Env::Prod, &prod(), &dirty, &options()).is_err());
    let behind = Facts {
        ref_tips: vec![PR_HEAD.into()],
        ..facts(Some(ship()))
    };
    let error = guard::preflight(&Env::Prod, &prod(), &behind, &options());
    assert!(error.unwrap_err().to_string().contains("tip of main"));
}

#[test]
fn the_pr_head_must_have_heads_tree() {
    refused(
        ShipFacts {
            tree: Some(OTHER_TREE.into()),
            ..ship()
        },
        "different tree",
    );
    refused(
        ShipFacts {
            tree: None,
            ..ship()
        },
        "different tree",
    );
}

#[test]
fn check_and_full_count_only_from_a_successful_ship_run_of_this_repository() {
    let with = |change: &dyn Fn(&mut Value)| {
        let mut forged = run();
        change(&mut forged);
        ShipFacts {
            runs: vec![forged],
            ..ship()
        }
    };
    refused(
        ShipFacts {
            runs: vec![],
            ..ship()
        },
        "no successful release CI run",
    );
    refused(
        with(&|r| r["head_repository"]["full_name"] = json!("someone/yonedarepo")),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["head_branch"] = json!("patch")),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["path"] = json!(".github/workflows/evil.yml")),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["conclusion"] = json!("failure")),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["event"] = json!("push")),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["head_sha"] = json!(MERGE)),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["event"] = json!("workflow_dispatch")),
        "no successful release CI run",
    );
    refused(
        with(&|r| r["path"] = json!(".github/workflows/deploy-prod.yml")),
        "no successful release CI run",
    );
    let at_ref = ShipFacts {
        runs: vec![{
            let mut r = run();
            r["path"] = json!(".github/workflows/ci.yml@refs/pull/9/merge");
            r
        }],
        ..ship()
    };
    guard::preflight(&Env::Prod, &prod(), &facts(Some(at_ref)), &options()).unwrap();
}

#[test]
fn final_gate_must_be_completed_success_from_the_same_run_and_attempt() {
    assert!(
        final_gate(&run(), &jobs(), true).is_none(),
        "pagination headers deny proof"
    );
    let without = ShipFacts {
        gates: vec![],
        ..ship()
    };
    refused(without, "no successful release CI run");
    for (field, value) in [
        ("name", json!("Other gate")),
        ("status", json!("in_progress")),
        ("conclusion", json!("skipped")),
        ("conclusion", json!("failure")),
        ("conclusion", json!("cancelled")),
        ("conclusion", Value::Null),
        ("run_id", json!(456)),
        ("run_attempt", json!(2)),
        ("head_sha", json!(MERGE)),
    ] {
        let mut page = jobs();
        page["jobs"][0][field] = value;
        assert!(
            final_gate(&run(), &page, false).is_none(),
            "{field}: {page}"
        );
    }
    for page in [
        json!({}),
        json!({"total_count":0,"jobs":[]}),
        json!({"total_count":2,"jobs":jobs()["jobs"]}),
        json!({"total_count":101,"jobs":jobs()["jobs"]}),
        json!({"total_count":2,"jobs":[jobs()["jobs"][0], jobs()["jobs"][0]]}),
    ] {
        assert!(final_gate(&run(), &page, false).is_none(), "{page}");
    }
    let mut changed = run();
    changed["run_attempt"] = json!(2);
    refused(
        ShipFacts {
            runs: vec![changed],
            ..ship()
        },
        "no successful release CI run",
    );
}

#[test]
fn ship_head_takes_a_full_object_id_only() {
    let args = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(head_arg(&args(&["deploy"])).unwrap(), None);
    assert_eq!(
        head_arg(&args(&["--ship-head", PR_HEAD]))
            .unwrap()
            .as_deref(),
        Some(PR_HEAD)
    );
    for bad in [
        &["--ship-head"][..],
        &["--ship-head", "--confirm"],
        &["--ship-head", "main"],
    ] {
        assert!(head_arg(&args(bad)).is_err(), "{bad:?}");
    }
}

fn full_kit(tree: Option<&str>, head: &str) -> Value {
    let items: Vec<Value> = FULL_KIT
        .iter()
        .map(|id| {
            let metrics = if *id == "0" {
                json!({"front": head, "platform": head})
            } else {
                json!({})
            };
            json!({"id": id, "title": id, "status": "pass", "metrics": metrics})
        })
        .collect();
    json!({"tree": tree, "items": items})
}
fn local(evidence: Value) -> Facts {
    Facts {
        evidence: Some(evidence),
        ..facts(None)
    }
}

#[test]
fn only_a_full_passing_kit_at_head_sets_live_tests() {
    full_kit_passes(&local(full_kit(Some(TREE), MERGE))).unwrap();
    let error = |evidence: Value| full_kit_passes(&local(evidence)).unwrap_err().to_string();
    assert!(error(full_kit(None, MERGE)).contains("records no tree"));
    assert!(error(full_kit(Some(OTHER_TREE), MERGE)).contains("not recorded against HEAD"));
    assert!(error(full_kit(Some(TREE), PR_HEAD)).contains("not recorded against HEAD"));
    let mut other_platform = full_kit(Some(TREE), MERGE);
    other_platform["items"][0]["metrics"]["platform"] = json!(PR_HEAD);
    assert!(error(other_platform).contains("not recorded against HEAD"));
    let mut partial = full_kit(Some(TREE), MERGE);
    partial["items"].as_array_mut().unwrap().truncate(5);
    assert!(error(partial).contains("not a full kit"));
    let mut failed = full_kit(Some(TREE), MERGE);
    failed["items"][7]["status"] = json!("fail");
    assert!(error(failed).contains("is fail, not pass"));
    let mut skipped = full_kit(Some(TREE), MERGE);
    skipped["items"][7]["status"] = json!("skip");
    assert!(error(skipped).contains("is skip, not pass"));
    let none = Facts {
        evidence: None,
        ..facts(None)
    };
    assert!(full_kit_passes(&none).is_err());
}

#[test]
fn full_kit_lists_what_a_kit_run_without_only_records() {
    let kit = include_str!("../../../tools/staging-realworld.mjs");
    let features = include_str!("../../../tools/staging/feature-items.mjs");
    let all: BTreeSet<&str> = [kit, features]
        .iter()
        .flat_map(|source| source.split("await step('").skip(1))
        .filter_map(|rest| rest.split('\'').next())
        .collect();
    let named_only = kit
        .split("only.has(id) : ![")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap();
    let named_only: BTreeSet<&str> = named_only
        .split(',')
        .map(|id| id.trim().trim_matches('\''))
        .collect();
    let mut expected: BTreeSet<&str> = all.difference(&named_only).copied().collect();
    // A full run leaves 41 out while AUDIT_LOG is off on dev (kit-gates.mjs). The day it goes on,
    // this fails until FULL_KIT names 41.
    let dev: Value = serde_json::from_str(include_str!("../../../infra/envs/dev.json")).unwrap();
    let workers = dev["workers"].as_array().unwrap();
    let platform = workers.iter().find(|w| w["role"] == "platform").unwrap();
    if platform["config"]["vars"]["AUDIT_LOG"] != "on" {
        expected.remove("41");
    }
    assert_eq!(expected, FULL_KIT.into_iter().collect());
}

#[test]
fn the_status_says_only_pass_and_the_tree() {
    assert_eq!(
        status_args(MERGE, TREE),
        [
            "api",
            "--method",
            "POST",
            "--silent",
            &format!("repos/{{owner}}/{{repo}}/statuses/{MERGE}"),
            "-f",
            "state=success",
            "-f",
            "context=live-tests",
            "-f",
            &format!("description=pass tree {TREE}"),
        ]
    );
}
