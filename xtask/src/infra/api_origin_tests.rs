//! The API origin the frontend is built with, per env.
use super::api_origin::api_origin;
use super::env::Env;
use super::spec::Spec;

fn spec(name: &str) -> Spec {
    let text = match name {
        "dev" => include_str!("../../../infra/envs/dev.json"),
        _ => include_str!("../../../infra/envs/prod.json"),
    };
    Spec::parse(text).unwrap()
}

#[test]
fn dev_and_prod_use_the_platform_custom_domain() {
    assert_eq!(
        api_origin(&spec("dev")).unwrap(),
        "https://api.dev.yonedarepo.com"
    );
    assert_eq!(
        api_origin(&spec("prod")).unwrap(),
        "https://api.yonedarepo.com"
    );
}

#[test]
fn an_ephemeral_stack_uses_the_platform_workers_dev_url() {
    let eph = spec("dev").ephemeral(&Env::Ephemeral("x1".into()));
    assert_eq!(
        api_origin(&eph).unwrap(),
        "https://yonedarepo-eph-x1-platform.mlong-f01.workers.dev"
    );
}

#[test]
fn a_spec_without_a_reachable_platform_is_refused() {
    let mut no_platform = spec("dev");
    no_platform.workers.retain(|w| w.role != "platform");
    assert!(
        api_origin(&no_platform)
            .unwrap_err()
            .to_string()
            .contains("no platform Worker")
    );
    let mut hidden = spec("dev");
    for worker in hidden.workers.iter_mut().filter(|w| w.role == "platform") {
        let config = worker.config.as_object_mut().unwrap();
        config.remove("routes");
        config.insert("workers_dev".into(), false.into());
    }
    assert!(
        api_origin(&hidden)
            .unwrap_err()
            .to_string()
            .contains("neither a Custom Domain")
    );
}
