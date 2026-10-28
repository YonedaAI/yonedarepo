//! Annotated tags and releases: a tag object is checked against the commit its ref names,
//! kept byte for byte, listed beside the ref and served to a fetch that wants it; a
//! malformed or mismatched one moves nothing. A release belongs to one existing tag, needs
//! `write` and `land` to publish, records immutable assets within their caps, reaches
//! `release` hooks, and its tables arrive by an additive migration.
use super::*;
use crate::storage::SqlStore;
use yoneda_core::git_object::{AnnotatedTag, Signature};

const HOOKS: &str = "platform:hooks";

fn tag_bytes(commit: &str, name: &str) -> Vec<u8> {
    let who = Signature {
        name: "Ada".into(),
        email: "ada@example.com".into(),
        seconds: 1_700_000_000,
        offset: "+0000".into(),
    };
    let commit = yoneda_core::git_object::ObjectId::parse(commit).unwrap();
    AnnotatedTag::new(commit, name, who, "first release")
        .unwrap()
        .encode()
        .unwrap()
}

fn push_tag(h: &Harness, name: &str, commit: &str, data: &[u8]) -> yoneda_core::Result<Value> {
    h.run(
        OWNER,
        json!({"op":"repo_branch_batch","updates":[{"ref":format!("refs/tags/{name}"),
            "commit":commit,"expected":null,"tag":{"data_b64":STANDARD.encode(data)}}]}),
    )
}

#[test]
fn annotated_tags_are_checked_kept_listed_and_fetched() {
    let (h, root) = seeded();
    let data = tag_bytes(&root, "v1");
    let id = hash_object(ObjectKind::Tag, &data).hex();
    let before = h.ok(OWNER, json!({"op":"repo_refs"}));

    // A malformed tag object, or one naming another commit, moves nothing.
    let mut broken = data.clone();
    broken.splice(0..6, b"objekt".iter().copied());
    assert_eq!(
        code(push_tag(&h, "v1", &root, &broken)),
        "GIT_OBJECT_INVALID"
    );
    let elsewhere = tag_bytes(&"c".repeat(40), "v1");
    assert_eq!(code(push_tag(&h, "v1", &root, &elsewhere)), "INVALID_INPUT");
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["version"],
        before["version"]
    );

    let made = push_tag(&h, "v1", &root, &data).unwrap();
    assert_eq!(made["refs"][0]["tag"], json!(id));
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"]["refs/tags/v1"], json!(root));
    assert_eq!(refs["annotated"], json!({ "refs/tags/v1": id }));
    // The same tag again is a no-op; another tag object at that commit is not.
    assert_eq!(
        push_tag(&h, "v1", &root, &data).unwrap()["refs"][0]["already"],
        true
    );
    let other = AnnotatedTag::decode(&data).unwrap();
    let other = AnnotatedTag::new(other.object, "v1", other.tagger.unwrap(), "changed")
        .unwrap()
        .encode()
        .unwrap();
    assert_eq!(code(push_tag(&h, "v1", &root, &other)), "ALREADY_EXISTS");
    let lightweight = json!({"op":"repo_tag_create","name":"v1","commit":root});
    assert_eq!(code(h.run(OWNER, lightweight)), "ALREADY_EXISTS");

    // A client reads the tag object back to write it locally (`git-remote-yoneda`).
    let shown = h.ok(CI, json!({"op":"repo_tag_show","name":"v1"}));
    assert_eq!(
        (&shown["commit"], &shown["tag"], &shown["data_b64"]),
        (&json!(root), &json!(id), &json!(STANDARD.encode(&data)))
    );
    h.ok(
        OWNER,
        json!({"op":"repo_tag_create","name":"light","commit":root}),
    );
    let light = h.ok(CI, json!({"op":"repo_tag_show","name":"light"}));
    assert_eq!(
        (&light["tag"], &light["data_b64"]),
        (&Value::Null, &Value::Null)
    );
    let missing = json!({"op":"repo_tag_show","name":"nope"});
    assert_eq!(code(h.run(CI, missing)), "NOT_FOUND");

    // A fetch that wants the tag object gets its commit and the object itself.
    let walk = h.ok(OWNER, json!({"op":"repo_git_walk","wants":[id],"haves":[]}));
    assert_eq!(walk["commits"][0]["commit"], json!(root));
    assert_eq!(
        walk["tags"],
        json!([{ "id": id, "data_b64": STANDARD.encode(&data) }])
    );
}

#[test]
fn the_platform_builds_annotated_tags_from_a_message() {
    let (h, root) = seeded();
    let made = h.ok(
        OWNER,
        json!({"op":"repo_tag_create","name":"v2","commit":root,"message":"Second cut",
               "tagger":{"name":"Ada","email":"ada@example.com"}}),
    );
    let id = made["tag"].as_str().unwrap().to_owned();
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["annotated"]["refs/tags/v2"],
        json!(id)
    );
    let row = &h
        .db
        .query("SELECT data_b64 FROM annotated_tags", &[])
        .unwrap()[0];
    let bytes = STANDARD.decode(row["data_b64"].as_str().unwrap()).unwrap();
    assert_eq!(hash_object(ObjectKind::Tag, &bytes).hex(), id);
    let tag = AnnotatedTag::decode(&bytes).unwrap();
    assert_eq!(
        (tag.name.as_str(), tag.message.as_str()),
        ("v2", "Second cut\n")
    );
    assert_eq!(tag.tagger.unwrap().email, "ada@example.com");
    // Write without land cannot tag, as for lightweight tags.
    let denied = json!({"op":"repo_tag_create","name":"v3","commit":root,"message":"m"});
    assert_eq!(code(h.run(AGENT, denied)), "FORBIDDEN");
}

#[test]
fn releases_need_a_tag_land_scope_and_keep_assets_within_caps() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write","land"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let hook = h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook","events":["release"],
               "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
               "_workers_subdomain":"mlong-f01"}),
    )["id"]
        .clone();
    let create = json!({"op":"repo_release_create","tag":"v1","title":"First","notes":"It works."});
    assert_eq!(code(h.run(OWNER, create.clone())), "NOT_FOUND");
    h.ok(
        OWNER,
        json!({"op":"repo_tag_create","name":"v1","commit":root,"message":"v1"}),
    );
    // Read-only, write without land, and path-restricted credentials cannot publish.
    assert_eq!(code(h.run(CI, create.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(AGENT, create.clone())), "FORBIDDEN");
    assert_eq!(code(h.run("token:docs", create.clone())), "FORBIDDEN");
    let untitled = json!({"op":"repo_release_create","tag":"v1","title":" "});
    assert_eq!(code(h.run(OWNER, untitled)), "INVALID_INPUT");
    let release = h.ok(OWNER, create.clone());
    assert_eq!(
        (
            &release["tag"],
            &release["commit_id"],
            &release["asset_count"]
        ),
        (&json!("v1"), &json!(root), &json!(0))
    );
    assert_eq!(code(h.run(OWNER, create)), "ALREADY_EXISTS");

    let sha = "ab".repeat(32);
    let asset = |name: &str, size: i64, dry: bool| {
        json!({"op":"repo_release_asset_put","tag":"refs/tags/v1","name":name,"size":size,
               "sha256":sha,"content_type":"application/zip","dry_run":dry})
    };
    assert_eq!(h.ok(OWNER, asset("app.zip", 10, true))["name"], "app.zip");
    assert!(
        h.ok(OWNER, json!({"op":"repo_release_show","tag":"v1"}))["assets"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    h.ok(OWNER, asset("app.zip", 10, false));
    assert_eq!(
        code(h.run(OWNER, asset("app.zip", 10, true))),
        "ALREADY_EXISTS"
    );
    assert_eq!(
        code(h.run(OWNER, asset("big.bin", 26 * 1024 * 1024, true))),
        "TOO_LARGE"
    );
    assert_eq!(code(h.run(OWNER, asset("../x", 1, true))), "INVALID_INPUT");
    assert_eq!(code(h.run(AGENT, asset("b.zip", 1, true))), "FORBIDDEN");

    // Readers see the release, its assets and its tag message.
    let shown = h.ok(CI, json!({"op":"repo_release_show","tag":"v1"}));
    assert_eq!(shown["assets"][0]["sha256"], json!(sha));
    assert_eq!(shown["annotated"]["message"], "v1\n");
    let listed = h.ok(CI, json!({"op":"repo_releases"}));
    assert_eq!(listed["releases"][0]["asset_count"], 1);
    let one = h.ok(
        CI,
        json!({"op":"repo_release_asset","tag":"v1","name":"app.zip"}),
    );
    assert_eq!((&one["size"], &one["tag"]), (&json!(10), &json!("v1")));
    let missing = json!({"op":"repo_release_asset","tag":"v1","name":"nope.zip"});
    assert_eq!(code(h.run(CI, missing)), "NOT_FOUND");
    let restricted = json!({"op":"repo_releases"});
    assert_eq!(code(h.run("token:docs", restricted)), "FORBIDDEN");

    // Deleting answers the asset names to remove; the tag stays.
    let delete = json!({"op":"repo_release_delete","tag":"v1"});
    assert_eq!(code(h.run(CI, delete.clone())), "FORBIDDEN");
    assert_eq!(h.ok(OWNER, delete)["assets"], json!(["app.zip"]));
    assert!(
        h.ok(CI, json!({"op":"repo_releases"}))["releases"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/tags/v1"],
        json!(root)
    );

    // Both events reached the release hook, notes as the message.
    let mut events = Vec::new();
    loop {
        let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
        if claim["idle"] == true {
            break;
        }
        events.push(serde_json::from_str::<Value>(claim["body"].as_str().unwrap()).unwrap());
        h.ok(
            HOOKS,
            json!({"op":"repo_hook_settle","hook_id":hook,"seq":claim["seq"],"attempt":claim["attempt"],"ok":true,"status":200,"ms":5}),
        );
    }
    let names: Vec<&str> = events.iter().filter_map(|e| e["event"].as_str()).collect();
    assert_eq!(names, ["release.published", "release.deleted"]);
    assert_eq!(events[0]["message"], "It works.");
    assert_eq!(events[0]["release"]["title"], "First");
}

#[test]
fn upgrades_from_the_bundles_schema_with_empty_release_tables() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations.len() - 1;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    for table in ["annotated_tags", "releases", "release_assets"] {
        assert!(
            db.query(&format!("SELECT * FROM {table}"), &[])
                .unwrap()
                .is_empty()
        );
    }
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        migrations.last().unwrap().0
    );
    assert_eq!(
        db.query("SELECT owner FROM repo_settings", &[]).unwrap()[0]["owner"],
        "user:owner"
    );
}
