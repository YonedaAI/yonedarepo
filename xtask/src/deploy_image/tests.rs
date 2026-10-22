use super::*;

const ACCOUNT: &str = "f011d0ee02b23cad26b4b38151b204ad";
const EXECUTION: &str = "yonedarepo-staging-agents-executioncontainer";
const CHECK: &str = "yonedarepo-staging-platform-checkcontainer";
const INPUTS: &str = "1111111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn image(tag: &str) -> String {
    format!("registry.cloudflare.com/{ACCOUNT}/yonedarepo-staging-runtime:{tag}")
}

fn facts(deployed: &[(&str, Option<&str>)], records: &[(&str, &[&str])]) -> ImageFacts {
    ImageFacts {
        inputs: INPUTS.into(),
        deployed: deployed
            .iter()
            .map(|(app, tag)| ((*app).to_owned(), tag.map(image)))
            .collect(),
        records: records
            .iter()
            .map(|(tag, hashes)| (image(tag), hashes.iter().map(|h| (*h).to_owned()).collect()))
            .collect(),
    }
}

#[test]
fn unchanged_inputs_reuse_the_deployed_image_without_a_rollout() {
    let facts = facts(
        &[(EXECUTION, Some("ef9d")), (CHECK, Some("ef9d"))],
        &[("ef9d", &["0000000000000000", "1111111111111111"])],
    );
    assert_eq!(
        decide(&facts),
        ImagePlan::Reuse {
            image: image("ef9d"),
            rollouts: vec![]
        }
    );
}

#[test]
fn an_app_on_another_image_switches_to_the_recorded_one() {
    let facts = facts(
        &[(EXECUTION, Some("ef9d")), (CHECK, Some("a428"))],
        &[("ef9d", &["1111111111111111"]), ("a428", &[])],
    );
    assert_eq!(
        decide(&facts),
        ImagePlan::Reuse {
            image: image("ef9d"),
            rollouts: vec![CHECK.into()]
        }
    );
}

#[test]
fn changed_inputs_build_and_roll_out_every_app() {
    let facts = facts(
        &[(EXECUTION, Some("ef9d")), (CHECK, Some("ef9d"))],
        &[("ef9d", &["0000000000000000"])],
    );
    let ImagePlan::Build { reason, rollouts } = decide(&facts) else {
        panic!("expected a build");
    };
    assert!(reason.contains("runtime inputs changed"), "{reason}");
    assert!(reason.contains("1111111111111111") && reason.contains("0000000000000000"));
    assert_eq!(rollouts, [EXECUTION, CHECK].map(String::from));
}

#[test]
fn a_missing_record_builds() {
    let facts = facts(
        &[(EXECUTION, Some("ef9d")), (CHECK, Some("ef9d"))],
        &[("ef9d", &[])],
    );
    let ImagePlan::Build { reason, rollouts } = decide(&facts) else {
        panic!("expected a build");
    };
    assert!(reason.contains("no inputs record"), "{reason}");
    assert_eq!(rollouts.len(), 2);
    // A wrangler-built digest reference has no record either.
    let mut digest = facts.clone();
    digest.deployed.insert(
        EXECUTION.into(),
        Some(format!("registry.cloudflare.com/{ACCOUNT}/x@sha256:abc")),
    );
    digest.deployed.insert(CHECK.into(), None);
    digest.records.clear();
    assert!(matches!(decide(&digest), ImagePlan::Build { .. }));
    let fresh = facts_without_apps();
    assert!(
        matches!(decide(&fresh), ImagePlan::Build { reason, .. } if reason.contains("no container app"))
    );
}

fn facts_without_apps() -> ImageFacts {
    facts(&[(EXECUTION, None), (CHECK, None)], &[])
}

#[test]
fn records_are_tags_bound_to_the_image_tag() {
    assert_eq!(
        record_tag("ef9d08f6e761484c", INPUTS),
        "ef9d08f6e761484c--inputs-1111111111111111"
    );
    let tags: Vec<String> = [
        "ef9d08f6e761484c",
        "ef9d08f6e761484c--inputs-1111111111111111",
        "a4281d1593e952df--inputs-2222222222222222",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(
        recorded_inputs(&tags, "ef9d08f6e761484c"),
        BTreeSet::from(["1111111111111111".to_owned()])
    );
    assert!(recorded_inputs(&tags, "a4281d1593e9").is_empty());
}

#[test]
fn only_tagged_images_of_this_account_parse() {
    assert_eq!(
        parse_image(&image("ef9d08f6e761484c"), ACCOUNT),
        Some(RegistryImage {
            repo: "yonedarepo-staging-runtime".into(),
            tag: "ef9d08f6e761484c".into()
        })
    );
    for other in [
        format!("registry.cloudflare.com/{ACCOUNT}/app@sha256:5a7b"),
        "registry.cloudflare.com/other/yonedarepo-staging-runtime:ef9d".to_owned(),
        "docker.io/library/node:24".to_owned(),
    ] {
        assert_eq!(parse_image(&other, ACCOUNT), None, "{other}");
    }
}
