//! Local dashboard reads real authority state, keeps credentials out of the browser,
//! refuses other origins, and never provides a publication or mutation endpoint.
mod support;
use support::{Local, text};

fn origin(l: &Local) -> String {
    l.status()["url"]
        .as_str()
        .unwrap()
        .split("/git/")
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn dashboard_shows_landings_and_refusals_without_credentials() {
    let mut l = Local::new();
    l.run_ok(&l.clone, &["configure", "--no-cloud"]);
    l.serve();
    let base = origin(&l);
    let client = reqwest::blocking::Client::new();
    let page = client.get(&base).send().unwrap();
    assert_eq!(page.status(), 200);
    assert!(
        page.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    l.run_ok(
        &l.clone,
        &[
            "check",
            "add",
            "not-bad",
            "--on-host",
            "--",
            "sh",
            "-c",
            "! grep -q bad a.txt",
        ],
    );
    let a = l.worktree("a");
    let b = l.worktree("b");
    let accepted = l.commit(&a, "a.txt", "accepted\n");
    l.commit(&b, "a.txt", "conflicting\n");
    assert!(l.push(&a, &[]).status.success());
    let refused = l.push(&b, &[]);
    assert!(!refused.status.success(), "{}", text(&refused));
    let response = client
        .get(format!("{base}/local/dashboard"))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(
        response
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );
    let body = response.text().unwrap();
    let secret = std::fs::read_to_string(l.clone.join(".git/yoneda/local/token")).unwrap();
    assert!(!body.contains(secret.trim()));
    assert!(!body.contains("secret_allow"));
    let data: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(data["repository"]["head"], accepted);
    assert_eq!(data["cloud"]["state"], "disabled");
    assert_eq!(data["checks"][0]["status"], "passed");
    assert!(
        data["landings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["commit"] == accepted)
    );
    assert!(
        data["refusals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["reason"].as_str().unwrap().contains("conflict"))
    );
    assert_eq!(l.run_ok(&l.clone, &["ui"]), base);
}

#[test]
fn dashboard_refuses_rebinding_cross_origin_and_mutation() {
    let mut l = Local::new();
    l.serve();
    let base = origin(&l);
    let client = reqwest::blocking::Client::new();
    for (name, value) in [
        ("Host", "attacker.invalid"),
        ("Origin", "https://attacker.invalid"),
        ("Sec-Fetch-Site", "cross-site"),
        ("Sec-Fetch-Site", "same-site"),
    ] {
        let response = client
            .get(format!("{base}/local/dashboard"))
            .header(name, value)
            .send()
            .unwrap();
        assert_eq!(response.status(), 403, "{name}");
    }
    assert_eq!(
        client
            .post(format!("{base}/local/dashboard"))
            .send()
            .unwrap()
            .status(),
        405
    );
    assert_eq!(
        client
            .get(&base)
            .header("Host", "attacker.invalid")
            .send()
            .unwrap()
            .status(),
        403
    );
}

#[test]
fn dashboard_handles_a_repository_without_commits() {
    let mut l = Local::uninitialized("empty", &[]);
    l.git_ok(l.dir.path(), &["init", "-q", "empty"]);
    l.run_ok(&l.clone, &["init", "--no-cloud"]);
    l.serve();
    let data: serde_json::Value = reqwest::blocking::get(format!("{}/local/dashboard", origin(&l)))
        .unwrap()
        .json()
        .unwrap();
    assert!(data["repository"]["head"].is_null());
    assert!(data["landings"].as_array().unwrap().is_empty());
    assert!(data["writers"].as_array().unwrap().is_empty());
    assert_eq!(data["cloud"]["state"], "disabled");
}
