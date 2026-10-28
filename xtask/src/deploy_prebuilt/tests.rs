use super::*;
use crate::infra::spec::Spec;
use serde_json::json;

const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";
const OTHER: &str = "fedcba9876543210fedcba9876543210fedcba98";
const ID: &str = "sha256:797bc8cc5339dfeed09c68718378aa1aeb2ab7c9eb5c01c40b0179bf2bb4750b";

fn dev() -> Spec {
    Spec::parse(include_str!("../../../infra/envs/dev.json")).unwrap()
}

/// A complete prebuilt directory for `revision`.
fn outputs(revision: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (output, entry) in [
        (WASM, WASM_ENTRY),
        (FRONTEND, FRONTEND_ENTRY),
        (IMAGE, IMAGE_ARCHIVE),
    ] {
        let path = dir.path().join(output).join(entry);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
        std::fs::write(
            dir.path().join(output).join(REVISION),
            format!("{revision}\n"),
        )
        .unwrap();
    }
    std::fs::write(dir.path().join(IMAGE).join(IMAGE_ID), format!("{ID}\n")).unwrap();
    dir
}

fn refused(dir: &Path, needle: &str) {
    let error = check(dir, HEAD).unwrap_err().to_string();
    assert!(error.contains(needle), "expected {needle:?} in {error:?}");
}

#[test]
fn the_flag_needs_a_directory() {
    let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(dir_arg(&args(&["deploy", "--env", "dev"])).unwrap(), None);
    assert_eq!(
        dir_arg(&args(&["deploy", "--prebuilt", "/tmp/out", "--dry-run"])).unwrap(),
        Some(PathBuf::from("/tmp/out"))
    );
    assert!(dir_arg(&args(&["deploy", "--prebuilt"])).is_err());
    assert!(dir_arg(&args(&["deploy", "--prebuilt", "--dry-run"])).is_err());
}

#[test]
fn outputs_built_from_head_pass() {
    let dir = outputs(HEAD);
    let prebuilt = check(dir.path(), HEAD).unwrap();
    assert_eq!(prebuilt.image_id, ID);
}

#[test]
fn stale_outputs_are_refused() {
    let dir = outputs(HEAD);
    std::fs::write(dir.path().join(FRONTEND).join(REVISION), OTHER).unwrap();
    refused(
        dir.path(),
        &format!("{FRONTEND} was built from {OTHER}, not HEAD"),
    );
    refused(
        outputs(OTHER).path(),
        &format!("{WASM} was built from {OTHER}"),
    );
}

#[test]
fn missing_outputs_are_refused() {
    let dir = outputs(HEAD);
    std::fs::remove_dir_all(dir.path().join(WASM)).unwrap();
    refused(dir.path(), &format!("no prebuilt {WASM} revision"));

    let dir = outputs(HEAD);
    std::fs::remove_file(dir.path().join(IMAGE).join(IMAGE_ARCHIVE)).unwrap();
    refused(dir.path(), &format!("{IMAGE} lacks {IMAGE_ARCHIVE}"));

    let dir = outputs(HEAD);
    std::fs::remove_file(dir.path().join(IMAGE).join(IMAGE_ID)).unwrap();
    refused(dir.path(), &format!("no prebuilt {IMAGE}/{IMAGE_ID}"));

    refused(Path::new("/nonexistent/prebuilt"), "no prebuilt");
}

#[test]
fn a_malformed_image_id_is_refused() {
    let dir = outputs(HEAD);
    std::fs::write(dir.path().join(IMAGE).join(IMAGE_ID), "latest").unwrap();
    refused(dir.path(), "not a sha256 image id");
}

#[test]
fn the_image_is_named_by_its_content_in_the_account_registry() {
    let dir = outputs(HEAD);
    let prebuilt = check(dir.path(), HEAD).unwrap();
    let spec = dev();
    assert_eq!(
        prebuilt.local_tag(&spec),
        "yonedarepo-dev-runtime:797bc8cc5339dfee"
    );
    assert_eq!(
        prebuilt.image_ref(&spec),
        format!(
            "registry.cloudflare.com/{}/yonedarepo-dev-runtime:797bc8cc5339dfee",
            spec.account_id
        )
    );
}

#[test]
fn containers_deploy_the_image_instead_of_a_dockerfile() {
    let config = json!({
        "name": "w",
        "main": "worker/platform-index.ts",
        "containers": [
            {"class_name": "A", "image": "./containers/Dockerfile", "image_build_context": "..", "max_instances": 6},
            {"class_name": "B", "image": "./containers/Dockerfile"}
        ]
    });
    let swapped = with_image(config.clone(), "registry.cloudflare.com/acct/r:t");
    for container in swapped["containers"].as_array().unwrap() {
        assert_eq!(container["image"], "registry.cloudflare.com/acct/r:t");
        assert!(container.get("image_build_context").is_none());
    }
    assert_eq!(swapped["containers"][0]["max_instances"], 6);
    assert_eq!(swapped["main"], config["main"]);
    assert_eq!(with_image(json!({"name": "s"}), "x"), json!({"name": "s"}));
}

#[test]
fn a_sandbox_with_its_own_images_keeps_its_dockerfile() {
    let sandbox = json!({"class_name": "AgentSandbox", "scheduling_policy": "durable_object",
        "images": {"agent": {"dockerfile": "./sandbox/Dockerfile", "build_context": ".."}}});
    let config = json!({"name": "w", "containers": [
        {"class_name": "CheckContainer", "image": "./containers/Dockerfile"}, sandbox.clone()]});
    let swapped = with_image(config.clone(), "registry.cloudflare.com/acct/r:t");
    assert_eq!(
        swapped["containers"][0]["image"],
        "registry.cloudflare.com/acct/r:t"
    );
    assert_eq!(swapped["containers"][1], sandbox);
    let runtime = crate::infra::inventory::runtime_containers(&config);
    assert_eq!(runtime.keys().collect::<Vec<_>>(), ["w-checkcontainer"]);
}

#[test]
fn the_ssh_gateway_keeps_its_own_dockerfile() {
    let gateway = json!({"class_name": "SshGateway", "image": "./ssh-gateway/Dockerfile",
        "image_build_context": "..", "max_instances": 2});
    let config = json!({"name": "w", "containers": [
        {"class_name": "CheckContainer", "image": "./containers/Dockerfile", "image_build_context": ".."},
        gateway.clone()]});
    let swapped = with_image(config.clone(), "registry.cloudflare.com/acct/r:t");
    assert_eq!(
        swapped["containers"][0]["image"],
        "registry.cloudflare.com/acct/r:t"
    );
    assert_eq!(swapped["containers"][1], gateway);
    let runtime = crate::infra::inventory::runtime_containers(&config);
    assert_eq!(runtime.keys().collect::<Vec<_>>(), ["w-checkcontainer"]);
}

#[test]
fn the_config_copy_sits_next_to_the_original() {
    assert_eq!(
        config_copy_path("cloudflare/wrangler.dev-platform.jsonc"),
        "cloudflare/.prebuilt.wrangler.dev-platform.jsonc"
    );
}

#[test]
fn installed_outputs_drop_the_revision_marker_and_stale_files() {
    let src = outputs(HEAD);
    let dest = tempfile::tempdir().unwrap();
    let target = dest.path().join("build");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("stale.js"), "old").unwrap();
    replace_dir(&src.path().join(WASM), &target).unwrap();
    assert!(target.join(WASM_ENTRY).is_file());
    assert!(!target.join(REVISION).exists());
    assert!(!target.join("stale.js").exists());
}

#[test]
fn a_frontend_built_for_another_api_origin_is_refused() {
    let dir = outputs(HEAD);
    let prebuilt = check(dir.path(), HEAD).unwrap();
    let origin = "https://api.dev.yonedarepo.com";
    let assets = dir.path().join(FRONTEND).join("assets");
    let refused = |needle: &str| {
        let error = prebuilt.check_api_origin(origin).unwrap_err().to_string();
        assert!(error.contains(needle), "expected {needle:?} in {error:?}");
    };
    refused("no prebuilt frontend-dist/assets");
    std::fs::create_dir_all(&assets).unwrap();
    std::fs::write(assets.join("index-a.js"), "fetch(location.origin+'/git/')").unwrap();
    std::fs::write(assets.join("index-a.css"), origin).unwrap();
    refused("not built with VITE_YONEDA_API_ORIGIN=https://api.dev.yonedarepo.com");
    std::fs::write(assets.join("index-b.js"), format!("const o=\"{origin}\";")).unwrap();
    prebuilt.check_api_origin(origin).unwrap();
}
