//! A push opens a Landing when the repository's switch is on: one row, in the move's
//! transaction, never failing the push. Off, nothing changes.
use super::*;
use crate::storage::SqlStore;

const HOOKS: &str = "platform:hooks";

fn on(h: &Harness) {
    let set = h.ok(OWNER, json!({"op":"repo_auto_landings","create":true}));
    assert_eq!(
        set,
        json!({"create": true, "agents": false, "land_when_cleared": false, "findings_block": false})
    );
}

/// A commit of `message` on `parent`, not on any branch yet.
fn commit(h: &Harness, parent: &str, path: &str, message: &str) -> String {
    h.commit_with(
        AGENT,
        Some(parent),
        1,
        json!([file(path, "x\n")]),
        json!([]),
        json!({"message": message}),
    )
    .unwrap()
}

fn push(h: &Harness, name: &str, id: &str, expected: Option<&str>) -> Value {
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":expected}),
    )
}

fn rows(h: &Harness, status: &str) -> Vec<Value> {
    h.ok(CI, json!({"op":"repo_changes","status":status}))["changes"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn off_is_the_default_and_a_push_opens_nothing() {
    let (h, root) = seeded();
    let status = h.ok(OWNER, json!({"op":"repo_status"}));
    assert_eq!(
        status["landings"],
        json!({"create": false, "agents": false, "land_when_cleared": false, "findings_block": false})
    );
    let id = commit(&h, &root, "src/a.rs", "Add a");
    let moved = push(&h, "fix", &id, None);
    assert_eq!(moved["change"], Value::Null);
    assert!(rows(&h, "all").is_empty());
}

#[test]
fn the_switches_belong_to_the_owner_and_leave_the_policy_alone() {
    let h = Harness::new();
    let before = h.ok(OWNER, json!({"op":"repo_status"}))["policy_digest"].clone();
    let refused = h.run(AGENT, json!({"op":"repo_auto_landings","create":true}));
    assert_eq!(code(refused), "FORBIDDEN");
    let both = json!({"op":"repo_auto_landings","create":true,"agents":true});
    assert_eq!(
        h.ok(OWNER, both),
        json!({"create": true, "agents": true, "land_when_cleared": false, "findings_block": false})
    );
    // Each is set alone; the other stays.
    let one = json!({"op":"repo_auto_landings","agents":false});
    assert_eq!(
        h.ok(OWNER, one),
        json!({"create": true, "agents": false, "land_when_cleared": false, "findings_block": false})
    );
    let status = h.ok(OWNER, json!({"op":"repo_status"}));
    assert_eq!(
        status["landings"],
        json!({"create": true, "agents": false, "land_when_cleared": false, "findings_block": false})
    );
    assert_eq!(status["policy_digest"], before);
    let bad = h.run(OWNER, json!({"op":"repo_auto_landings","create":"yes"}));
    assert_eq!(code(bad), "INVALID_INPUT");
}

#[test]
fn a_push_opens_one_landing_named_for_its_commit() {
    let (h, root) = seeded();
    on(&h);
    let first = commit(&h, &root, "src/a.rs", "Add a\n\nThe long story");
    let moved = push(&h, "fix", &first, None);
    let number = moved["change"].as_i64().unwrap();
    let change = h.ok(CI, json!({"op":"repo_change_show","number":number}));
    assert_eq!(change["title"], "Add a");
    assert_eq!(change["body"], "");
    assert_eq!(change["base"], "main");
    assert_eq!(change["branch"], "fix");
    assert_eq!(change["author"], AGENT);
    assert_eq!(change["origin"], "auto");
    assert_eq!(change["head"], json!(first));

    // The next push moves it; there is still one row, and create claims it.
    let second = commit(&h, &first, "src/b.rs", "Add b");
    assert_eq!(push(&h, "fix", &second, Some(&first))["change"], number);
    assert_eq!(rows(&h, "all").len(), 1);
    let claimed = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Mine"}),
    );
    assert_eq!(
        (&claimed["number"], &claimed["origin"]),
        (&json!(number), &json!("explicit"))
    );
}

#[test]
fn an_atomic_push_opens_one_per_branch() {
    let (h, root) = seeded();
    on(&h);
    let a = commit(&h, &root, "src/a.rs", "Add a");
    let b = commit(&h, &root, "src/b.rs", "Add b");
    let moved = h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[
            {"ref":"a","commit":a,"expected":null},{"ref":"b","commit":b,"expected":null}]}),
    );
    assert!(moved["refs"][0]["change"].is_number());
    assert!(moved["refs"][1]["change"].is_number());
    assert_eq!(rows(&h, "open").len(), 2);
}

#[test]
fn a_commit_recorded_on_no_branch_opens_nothing() {
    let (h, root) = seeded();
    on(&h);
    commit(&h, &root, "src/a.rs", "Add a");
    assert!(rows(&h, "all").is_empty());
}

#[test]
fn release_and_fork_branches_are_skipped() {
    let (h, root) = seeded();
    on(&h);
    for (i, name) in ["release-1.2", "releases/next", "forks/r1/fix"]
        .iter()
        .enumerate()
    {
        let id = commit(&h, &root, &format!("src/{i}.rs"), "Add");
        assert_eq!(push(&h, name, &id, None)["change"], Value::Null, "{name}");
    }
    assert!(rows(&h, "all").is_empty());
}

#[test]
fn a_head_already_on_base_is_skipped() {
    let (h, root) = seeded();
    on(&h);
    // At main's head, and behind it.
    let landed = commit(&h, &root, "src/a.rs", "Add a");
    h.approve_and_check(&landed);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":landed}),
    );
    assert_eq!(push(&h, "same", &landed, None)["change"], Value::Null);
    assert_eq!(push(&h, "behind", &root, None)["change"], Value::Null);
    // Reached only through a merge's second parent: on no chain, with no landing of its own.
    let side = commit(&h, &root, "src/side.rs", "Side");
    let kid = commit(&h, &side, "src/kid.rs", "Kid");
    h.approve_and_check(&kid);
    let blob = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"x\n");
    let take = json!([{"path": "src/side.rs", "blob": blob, "type": "blob"},
        {"path": "src/kid.rs", "blob": blob, "type": "blob"}]);
    let merge = h
        .commit_with(
            "platform:merge",
            Some(&landed),
            2,
            take,
            json!([]),
            json!({"merge_parent": kid}),
        )
        .unwrap();
    let land = json!({"op":"repo_land","ref":"main","commit":kid,"merge":merge});
    assert_eq!(h.ok(OWNER, land)["merged"], json!(kid));
    assert_eq!(push(&h, "merged", &side, None)["change"], Value::Null);
    assert!(rows(&h, "all").is_empty());
}

#[test]
fn a_repository_with_no_main_is_skipped() {
    let h = Harness::new();
    on(&h);
    let root = h.commit(OWNER, None, 0, json!([file("a", "x\n")]), json!([]));
    let id = root.unwrap();
    assert_eq!(push(&h, "fix", &id, None)["change"], Value::Null);
    assert!(rows(&h, "all").is_empty());
}

#[test]
fn a_subject_that_fails_title_rules_falls_back_to_the_branch_name() {
    let (h, root) = seeded();
    on(&h);
    let long = "x".repeat(201);
    let tabbed = "a\tb";
    let secret = format!("key ghp_{}", "a".repeat(36));
    for (i, subject) in [
        long.as_str(),
        tabbed,
        "\nBelow a blank line",
        secret.as_str(),
    ]
    .iter()
    .enumerate()
    {
        let name = format!("fall/{i}");
        let id = commit(&h, &root, &format!("src/{i}.rs"), subject);
        let moved = push(&h, &name, &id, None);
        let number = moved["change"].clone();
        let shown = h.ok(CI, json!({"op":"repo_change_show","number":number}));
        assert_eq!(shown["title"], json!(name), "{subject}");
    }
}

#[test]
fn a_failure_opening_a_landing_never_fails_the_push() {
    let (h, root) = seeded();
    on(&h);
    h.db.query(
        "CREATE TRIGGER no_rows BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT,'refused'); END",
        &[],
    )
    .unwrap();
    let id = commit(&h, &root, "src/a.rs", "Add a");
    let moved = push(&h, "fix", &id, None);
    assert_eq!(moved["commit"], json!(id));
    assert_eq!(moved["change"], Value::Null);
    let refs = h.ok(CI, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"]["refs/heads/fix"], json!(id));
}

#[test]
fn a_closed_landing_stays_closed_until_reopened() {
    let (h, root) = seeded();
    on(&h);
    let first = commit(&h, &root, "src/a.rs", "Add a");
    let number = push(&h, "fix", &first, None)["change"].clone();
    h.ok(OWNER, json!({"op":"repo_change_close","number":number}));

    let second = commit(&h, &first, "src/b.rs", "Add b");
    assert_eq!(
        push(&h, "fix", &second, Some(&first))["change"],
        Value::Null
    );
    assert_eq!(rows(&h, "all").len(), 1);
    h.ok(OWNER, json!({"op":"repo_change_reopen","number":number}));
    let third = commit(&h, &second, "src/c.rs", "Add c");
    assert_eq!(push(&h, "fix", &third, Some(&second))["change"], number);
}

#[test]
fn a_new_branch_of_a_deleted_name_gets_a_new_row() {
    let (h, root) = seeded();
    on(&h);
    let first = commit(&h, &root, "src/a.rs", "Add a");
    let number = push(&h, "fix", &first, None)["change"].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":null,"expected":first}]}),
    );
    let closed = h.ok(CI, json!({"op":"repo_change_show","number":number}));
    assert_eq!(closed["status"], "closed");

    let again = commit(&h, &root, "src/b.rs", "Add b");
    let moved = push(&h, "fix", &again, None);
    assert!(moved["change"].is_number());
    assert_ne!(moved["change"], number);
}

#[test]
fn a_landed_branch_pushed_again_gets_a_new_row() {
    let (h, root) = seeded();
    on(&h);
    let first = commit(&h, &root, "src/a.rs", "Add a");
    let number = push(&h, "fix", &first, None)["change"].clone();
    h.approve_and_check(&first);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let landed = h.ok(CI, json!({"op":"repo_change_show","number":number}));
    assert_eq!(landed["status"], "landed");

    let again = commit(&h, &first, "src/b.rs", "Add b");
    let moved = push(&h, "fix", &again, Some(&first));
    assert!(moved["change"].is_number());
    assert_ne!(moved["change"], number);
}

#[test]
fn landing_on_a_working_branch_opens_one_and_a_mirror_or_import_does_not() {
    let (h, root) = seeded();
    on(&h);
    let id = commit(&h, &root, "src/a.rs", "Add a");
    h.ok(AGENT, json!({"op":"repo_land","ref":"stage","commit":id}));
    let opened = rows(&h, "open");
    assert_eq!(opened.len(), 1);
    assert_eq!(
        (&opened[0]["branch"], &opened[0]["title"]),
        (&json!("stage"), &json!("Add a"))
    );

    let fork = commit(&h, &root, "src/b.rs", "Add b");
    h.ok(
        "platform:fork",
        json!({"op":"repo_fork_mirror","fork":"r0123456789abcdef0999","branch":"feature","commit":fork}),
    );
    assert_eq!(rows(&h, "open").len(), 1, "a fork's mirror opens nothing");
    // The fork's proposal opens its own, on that mirror, as it always did.
    let proposed = h.ok(
        CI,
        json!({"op":"repo_change_create","branch":"forks/r0123456789abcdef0999/feature",
            "source_repo":"r0123456789abcdef0999","source_branch":"feature","title":"From a fork"}),
    );
    assert_eq!(proposed["origin"], "explicit");
    assert_eq!(proposed["head"], json!(fork));
}

#[test]
fn turning_it_on_touches_no_existing_branch() {
    let (h, root) = seeded();
    let id = commit(&h, &root, "src/a.rs", "Add a");
    push(&h, "fix", &id, None);
    on(&h);
    assert!(rows(&h, "all").is_empty());
    let next = commit(&h, &id, "src/b.rs", "Add b");
    assert!(push(&h, "fix", &next, Some(&id))["change"].is_number());
}

fn hook(h: &Harness, events: Value) -> Value {
    h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
            "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
            "_workers_subdomain":"mlong-f01","events":events}),
    )["id"]
        .clone()
}

fn delivered(h: &Harness, id: &Value) -> Vec<Value> {
    h.ok(HOOKS, json!({"op":"repo_hooks_fanout"}));
    let mut bodies = Vec::new();
    loop {
        let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":id}));
        if claim["idle"] == true {
            return bodies;
        }
        bodies.push(serde_json::from_str(claim["body"].as_str().unwrap()).unwrap());
        h.ok(
            HOOKS,
            json!({"op":"repo_hook_settle","hook_id":id,"seq":claim["seq"],
                "attempt":claim["attempt"],"ok":true,"status":200,"ms":5}),
        );
    }
}

#[test]
fn only_a_hook_that_opts_in_hears_an_auto_row_open() {
    let (h, root) = seeded();
    on(&h);
    let plain = hook(&h, json!(["change"]));
    let every = h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
            "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
            "_workers_subdomain":"mlong-f01"}),
    )["id"]
        .clone();
    let opted = hook(&h, json!(["change", "change.auto"]));
    let id = commit(&h, &root, "src/a.rs", "Add a");
    let number = push(&h, "fix", &id, None)["change"].clone();

    assert!(delivered(&h, &plain).is_empty());
    let default_hook: Vec<Value> = delivered(&h, &every)
        .into_iter()
        .filter(|b| b["event"] == "change.opened")
        .collect();
    assert!(default_hook.is_empty(), "no hook opts in by default");
    let bodies = delivered(&h, &opted);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["event"], "change.opened");
    assert_eq!(bodies[0]["change"]["number"], number);
    assert_eq!(bodies[0]["change"]["origin"], "auto");
    assert_eq!(bodies[0]["message"], "Add a");

    // Adopting tells everyone, as a create does; the payload is the one an explicit row has.
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Mine"}),
    );
    let bodies = delivered(&h, &plain);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["change"].get("origin"), None);
}

#[test]
fn a_hook_that_did_not_opt_in_queues_nothing_however_many_branches_move() {
    let (h, root) = seeded();
    on(&h);
    let plain = hook(&h, json!(["change"]));
    let id = commit(&h, &root, "src/a.rs", "Add a");
    for i in 0..3 {
        push(&h, &format!("fix/{i}"), &id, None);
    }
    let pending =
        h.db.query("SELECT COUNT(*) AS n FROM hook_outbox", &[])
            .unwrap();
    assert_eq!(pending[0]["n"], 0);
    let listed = h.ok(OWNER, json!({"op":"repo_hooks"}));
    assert_eq!(listed["hooks"][0]["id"], plain);
    assert_eq!(listed["hooks"][0]["active"], true);
}

#[test]
fn the_list_filters_by_branch_and_origin() {
    let (h, root) = seeded();
    on(&h);
    let a = commit(&h, &root, "src/a.rs", "Add a");
    let b = commit(&h, &root, "src/b.rs", "Add b");
    push(&h, "a", &a, None);
    let number = push(&h, "b", &b, None)["change"].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"b","title":"Mine"}),
    );

    let list = |extra: Value| {
        let mut c = json!({"op":"repo_changes","status":"open"});
        c.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        h.ok(CI, c)["changes"].as_array().unwrap().clone()
    };
    assert_eq!(list(json!({})).len(), 2);
    let explicit = list(json!({"origin":"explicit"}));
    assert_eq!(explicit.len(), 1);
    assert_eq!(explicit[0]["number"], number);
    assert_eq!(list(json!({"origin":"auto"}))[0]["branch"], "a");
    assert_eq!(list(json!({"branch":"b"}))[0]["number"], number);
    assert!(list(json!({"branch":"none"})).is_empty());
    let bad = h.run(CI, json!({"op":"repo_changes","origin":"robot"}));
    assert_eq!(code(bad), "INVALID_INPUT");
}

#[test]
fn landings_without_a_change_are_listed_as_direct() {
    let (h, root) = seeded();
    // Direct: no change names this landing.
    let direct = commit(&h, &root, "src/d.rs", "Fix the build\n\nDetail");
    h.approve_and_check(&direct);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":direct}),
    );
    // Through a change: never listed twice.
    let proposed = commit(&h, &direct, "src/p.rs", "Proposed");
    push(&h, "fix", &proposed, None);
    let change = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Fix"}),
    );
    h.approve_and_check(&proposed);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":proposed}),
    );

    let listed = h.ok(
        CI,
        json!({"op":"repo_changes","status":"landed","direct":true}),
    );
    assert_eq!(listed["changes"][0]["number"], change["number"]);
    let direct_rows = listed["direct"].as_array().unwrap();
    assert_eq!(direct_rows.len(), 1, "{direct_rows:?}");
    assert_eq!(direct_rows[0]["commit"], json!(direct));
    assert_eq!(direct_rows[0]["title"], "Fix the build");
    assert_eq!(direct_rows[0]["author"], AGENT);
    assert!(direct_rows[0]["version"].is_number());
    assert!(direct_rows[0]["landed_at"].is_number());

    // Only when asked, and only with landed rows: an installed client's answer is unchanged.
    let plain = h.ok(CI, json!({"op":"repo_changes","status":"landed"}));
    assert_eq!(plain.get("direct"), None);
    let open = h.ok(
        CI,
        json!({"op":"repo_changes","status":"open","direct":true}),
    );
    assert_eq!(open.get("direct"), None);
}
