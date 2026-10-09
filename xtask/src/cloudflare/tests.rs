use super::*;

fn template() -> Value {
    serde_json::from_str(include_str!("../../../cloudflare/wrangler.jsonc")).unwrap()
}
fn manifest() -> Value {
    json!({"name":"my-platform","account_id":"a".repeat(32),"namespace":"my-namespace",
        "database_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","sites_url":"https://my-platform-sites.mine.workers.dev"})
}

#[test]
fn portable_configuration_replaces_foreign_identities_and_preserves_history_with_new_paths() {
    let template = template();
    let migrations = template["migrations"].clone();
    let (platform, sites) = configs(template, &manifest());
    let text = format!("{platform}{sites}");
    for foreign in [
        "f011d0ee",
        "182c0b3e",
        "3d9115d4",
        "yoneda-dev",
        "yonedarepo-dev",
        "mlong-f01",
    ] {
        assert!(!text.contains(foreign), "retained {foreign}");
    }
    assert_eq!(platform["migrations"], migrations);
    assert_eq!(platform["main"], "../../../cloudflare/worker/index.ts");
    assert_eq!(platform["assets"]["directory"], "../../../frontend/dist");
    assert_eq!(
        platform["containers"][0]["image"],
        "../../../cloudflare/containers/Dockerfile"
    );
    assert_eq!(platform["containers"][0]["image_build_context"], "../../..");
    assert_eq!(
        platform["d1_databases"][0]["migrations_dir"],
        "../../../cloudflare/migrations"
    );
    assert_eq!(sites["main"], "../../../cloudflare/sites/index.ts");
    assert_eq!(platform["d1_databases"][0]["binding"], "INDEX");
    assert_eq!(sites["services"][0]["service"], platform["name"]);
    assert!(platform.get("secrets_store_secrets").is_none());
    assert!(!slug("../prod"));
    assert!(!slug("a;curl"));
}

#[test]
fn repeat_configure_changes_only_known_legacy_paths_and_retains_settings_and_state() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(directory("my-platform").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    save_configs(&dir, &manifest(), template()).unwrap();
    let (mut platform, mut sites) = configs(template(), &manifest());
    platform["main"] = json!("../../../worker/index.ts");
    platform["assets"]["directory"] = json!("../../../web/dist");
    platform["containers"][0]["image"] = json!("../../../containers/Dockerfile");
    platform["containers"][0]["image_build_context"] = json!("../../../custom-context");
    platform["containers"][0]["max_instances"] = json!(37);
    platform["d1_databases"][0]["migrations_dir"] = json!("../../../migrations");
    platform["d1_databases"].as_array_mut().unwrap().push(json!({"binding":"CUSTOM","database_id":"custom-db","migrations_dir":"../../../custom-migrations"}));
    platform["containers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"image":"../../../custom/Dockerfile"}));
    platform["vars"]["CUSTOM_SETTING"] = json!("preserved");
    platform["migrations"]
        .as_array_mut()
        .unwrap()
        .push(json!({"tag":"custom-v3","renamed_classes":[{"from":"Old","to":"New"}]}));
    sites["main"] = json!("../../../sites/index.ts");
    sites["routes"] = json!([{"pattern":"sites.example/*","zone_name":"example"}]);
    std::fs::write(
        dir.join("platform.json"),
        serde_json::to_vec_pretty(&platform).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.join("sites.json"),
        serde_json::to_vec_pretty(&sites).unwrap(),
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("state")).unwrap();
    std::fs::write(dir.join("state/existing.sqlite"), b"existing-state").unwrap();
    std::fs::write(dir.join(".dev.vars"), b"CUSTOM_SECRET=fixture-retained\n").unwrap();
    let mut expected_platform = platform;
    expected_platform["main"] = json!("../../../cloudflare/worker/index.ts");
    expected_platform["assets"]["directory"] = json!("../../../frontend/dist");
    expected_platform["containers"][0]["image"] =
        json!("../../../cloudflare/containers/Dockerfile");
    expected_platform["d1_databases"][0]["migrations_dir"] =
        json!("../../../cloudflare/migrations");
    let mut expected_sites = sites;
    expected_sites["main"] = json!("../../../cloudflare/sites/index.ts");
    save_configs(&dir, &manifest(), template()).unwrap();
    let first = std::fs::read(dir.join("platform.json")).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&first).unwrap(),
        expected_platform
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(dir.join("sites.json")).unwrap()).unwrap(),
        expected_sites
    );
    save_configs(&dir, &manifest(), template()).unwrap();
    assert_eq!(std::fs::read(dir.join("platform.json")).unwrap(), first);
    assert_eq!(
        std::fs::read(dir.join("state/existing.sqlite")).unwrap(),
        b"existing-state"
    );
    assert_eq!(
        std::fs::read(dir.join(".dev.vars")).unwrap(),
        b"CUSTOM_SECRET=fixture-retained\n"
    );
    let mut changed_identity = manifest();
    changed_identity["namespace"] = json!("another-namespace");
    assert!(save_configs(&dir, &changed_identity, template()).is_err());
    assert_eq!(std::fs::read(dir.join("platform.json")).unwrap(), first);
}

#[test]
fn custom_paths_and_missing_sections_are_preserved_during_known_path_upgrade() {
    let mut config =
        json!({"main":"../../../worker/index.ts","assets":{"directory":"../../../custom-assets"}});
    assert!(upgrade_paths(&mut config, false));
    assert_eq!(
        config,
        json!({"main":"../../../cloudflare/worker/index.ts","assets":{"directory":"../../../custom-assets"}})
    );
    assert!(!upgrade_paths(&mut config, false));
    let mut custom = json!({"main":"../../../custom/worker.ts","routes":["example/*"]});
    let before = custom.clone();
    assert!(!upgrade_paths(&mut custom, false));
    assert_eq!(custom, before);
}
