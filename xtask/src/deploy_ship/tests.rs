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
fn status(state: &str, creator: &str, tree: &str) -> Value {
    json!({"context": "live-tests", "state": state, "description": format!("pass tree {tree}"), "creator": {"login": creator}})
}
fn run() -> Value {
    json!({
        "event": "pull_request", "conclusion": "success", "head_sha": PR_HEAD, "head_branch": "dev",
        "head_repository": {"full_name": REPO}, "path": ".github/workflows/ship.yml"
    })
}
fn ship() -> ShipFacts {
    ShipFacts {
        repo: REPO.into(),
        pr_head: PR_HEAD.into(),
        tree: Some(TREE.into()),
        statuses: vec![status("success", "MagnetonIO", TREE)],
        runs: vec![run()],
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
fn a_merged_ship_deploys_on_its_statuses_without_dev_workers_or_evidence() {
    guard::preflight(&Env::Prod, &prod(), &facts(Some(ship())), &options()).unwrap();
}

#[test]
fn ship_mode_never_passes_without_its_facts_or_confirm_or_on_dev() {
    let error = guard::preflight(&Env::Prod, &prod(), &facts(None), &options()).unwrap_err();
    assert!(error.to_string().contains("ship statuses"), "{error}");
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
fn live_tests_must_be_the_owners_newest_pass_for_this_tree() {
    let with = |statuses: Vec<Value>| ShipFacts { statuses, ..ship() };
    refused(with(vec![]), "no live-tests status");
    refused(
        with(vec![json!({"context": "other", "state": "success"})]),
        "no live-tests status",
    );
    refused(
        with(vec![status("failure", "MagnetonIO", TREE)]),
        "live-tests is failure",
    );
    refused(
        with(vec![status("success", "github-actions[bot]", TREE)]),
        "not set by MagnetonIO",
    );
    refused(
        with(vec![status("success", "MagnetonIO", OTHER_TREE)]),
        "another tree",
    );
    // The newest status wins: GitHub lists them newest first.
    refused(
        with(vec![
            status("failure", "MagnetonIO", TREE),
            status("success", "MagnetonIO", TREE),
        ]),
        "live-tests is failure",
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
        "no successful Ship run",
    );
    refused(
        with(&|r| r["head_repository"]["full_name"] = json!("someone/yonedarepo")),
        "no successful Ship run",
    );
    refused(
        with(&|r| r["head_branch"] = json!("patch")),
        "no successful Ship run",
    );
    refused(
        with(&|r| r["path"] = json!(".github/workflows/evil.yml")),
        "no successful Ship run",
    );
    refused(
        with(&|r| r["conclusion"] = json!("failure")),
        "no successful Ship run",
    );
    refused(
        with(&|r| r["event"] = json!("push")),
        "no successful Ship run",
    );
    refused(
        with(&|r| r["head_sha"] = json!(MERGE)),
        "no successful Ship run",
    );
    let at_ref = ShipFacts {
        runs: vec![{
            let mut r = run();
            r["path"] = json!(".github/workflows/ship.yml@refs/pull/9/merge");
            r
        }],
        ..ship()
    };
    guard::preflight(&Env::Prod, &prod(), &facts(Some(at_ref)), &options()).unwrap();
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
    // The evidence of another commit of the same tree is not "at HEAD".
    let same_tree = Facts {
        evidence: Some(full_kit(Some(TREE), PR_HEAD)),
        trees: [(PR_HEAD.to_owned(), TREE.to_owned())].into(),
        ..facts(None)
    };
    assert!(full_kit_passes(&same_tree).is_err());
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
