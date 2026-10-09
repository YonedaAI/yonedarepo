use super::*;
use yoneda_core::{FileEntry, Workspace};

#[test]
fn planner_uses_actual_brief_and_frozen_roster_without_source_authority() {
    let payload = json!({"run":{"intent":"Build a bilingual bike club with SQLite API","criteria":["English and Spanish"],"agents":[{"provider":"mimo","model":"selected-model"}],"base":{"commit":"exact-base"},"context_records":[{"id":"prior-contract"}]},"policy":{"build":{"static_dir":"public"}}});
    let result = prompt(&payload).unwrap();
    for required in [
        "bilingual bike club",
        "SQLite API",
        "English and Spanish",
        "selected-model",
        "exact-base",
        "prior-contract",
        "do not create",
        "team_plan_propose",
        "separate deployment",
        "one-agent teams",
    ] {
        assert!(result.contains(required), "Missing {required}");
    }
    assert!(prompt(&json!({"run":{"agents":[]}})).is_err());
}

#[test]
fn planning_rejects_source_edits_modes_additions_and_deletions() {
    let baseline = Workspace::from([(
        "public/index.html".into(),
        FileEntry::from_bytes(b"<html>base</html>".to_vec(), false),
    )]);
    assert!(crate::team_workspace::validate_read_only(&baseline, &baseline).is_ok());
    for kind in 0..4 {
        let mut after = baseline.clone();
        match kind {
            0 => after.get_mut("public/index.html").unwrap().content = "changed".into(),
            1 => after.get_mut("public/index.html").unwrap().executable = true,
            2 => {
                after.insert("new-file".into(), FileEntry::from_bytes(vec![], false));
            }
            _ => {
                after.remove("public/index.html");
                after.insert("other-file".into(), FileEntry::from_bytes(vec![], false));
            }
        }
        assert_eq!(
            crate::team_workspace::validate_read_only(&baseline, &after)
                .unwrap_err()
                .code,
            "PLANNING_SOURCE_CHANGED"
        );
    }
}
