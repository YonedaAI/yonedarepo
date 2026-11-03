//! Regional Worker bootstrap from the same desired bound configuration.

use crate::deploy_env::Step;
use crate::infra::inventory::Deployable;
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::Write;

/// Only missing cross-script services are removed; all durable identities remain.
pub(crate) fn configuration(config: &Value, missing: &BTreeSet<String>) -> Result<Value> {
    let mut copy = config.clone();
    let authority = copy["durable_objects"]["bindings"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["class_name"] == "WorkspaceAuthority")
        .and_then(|b| b.get("script_name"))
        .cloned()
        .or_else(|| {
            copy["services"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["binding"] == "SELF" || s["binding"] == "PLATFORM")
                .and_then(|s| s.get("service"))
                .cloned()
        });
    let services = copy["services"]
        .as_array_mut()
        .ok_or("Bootstrap Worker has no services")?;
    // The staged primary has dispatch off: retain its legacy authority path until
    // api-enam exists, instead of dropping cross-cell reads during bootstrap.
    for service in services.iter_mut() {
        if service["binding"] == "CELL_ENAM"
            && service["service"]
                .as_str()
                .is_some_and(|name| missing.contains(name))
        {
            service["service"] = authority
                .clone()
                .ok_or("Missing ENAM alias needs its original authority binding")?;
        }
    }
    services.retain(|s| {
        s["binding"] == "SELF"
            || !s["service"]
                .as_str()
                .is_some_and(|name| missing.contains(name))
    });
    // Do not advertise automatic placement until the desired bound rollout finishes.
    copy["vars"]["AUTOMATIC_LOCALITY"] = json!("off");
    // Missing aliases cannot receive public traffic until all desired bindings exist.
    if copy["vars"].get("REGIONAL_API").is_some() {
        copy["vars"]["REGIONAL_API"] = json!("off");
    }
    Ok(copy)
}

/// The ordinary plan retains its guards/builds/migrations and final bound deployment.
pub(crate) fn insert(
    plan: Vec<Step>,
    workers: &[Deployable],
    missing: &BTreeSet<String>,
) -> Result<Vec<Step>> {
    if missing.is_empty()
        || plan
            .iter()
            .any(|s| matches!(s, Step::Deploy { dry_run: true, .. }))
    {
        return Ok(plan);
    }
    let primary = workers
        .iter()
        .position(|w| w.role == "platform")
        .ok_or("Regional bootstrap needs the primary platform")?;
    let mut stage = vec![primary];
    stage.extend(
        workers
            .iter()
            .enumerate()
            .filter_map(|(i, w)| missing.contains(&w.name).then_some(i)),
    );
    if stage.len() != missing.len() + 1 {
        return Err("Missing regional bootstrap target is not in this deploy".into());
    }
    let prod = plan.iter().any(|s| matches!(s, Step::ActiveGate { .. }));
    let mut out = Vec::new();
    let mut inserted = false;
    for step in plan {
        if matches!(step, Step::Deploy{worker,..} if worker==primary) && !inserted {
            for worker in stage.iter().copied() {
                if prod && workers[worker].has_containers {
                    out.push(Step::ActiveGate { worker });
                }
                out.push(Step::RolloutGate);
                out.push(Step::Bootstrap {
                    worker,
                    config: configuration(&workers[worker].config, missing)?,
                });
                if !(workers[worker].secrets.is_empty()
                    && workers[worker].optional_secrets.is_empty())
                {
                    out.push(Step::Secrets { worker });
                }
                if workers[worker].health.is_some() {
                    out.push(Step::Health { worker });
                }
            }
            // Recheck after a possibly slow bootstrap: work may have started meanwhile.
            if prod {
                out.push(Step::ActiveGate { worker: primary });
            }
            out.push(Step::RolloutGate);
            inserted = true;
        }
        out.push(step);
    }
    if !inserted {
        return Err("Regional bootstrap has no primary deploy step".into());
    }
    Ok(out)
}

struct PrivateConfig(std::path::PathBuf);
impl PrivateConfig {
    fn write(worker: &Deployable, config: Value, image: Option<&str>) -> Result<Self> {
        let original = std::path::Path::new(&worker.config_path);
        let file = original
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid bootstrap config path")?;
        let path =
            original.with_file_name(format!(".prebuilt.bootstrap-{}.{file}", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&path)?;
        let owned = Self(path);
        let config = match image.filter(|_| worker.has_containers) {
            Some(image) => crate::deploy_prebuilt::with_image(config, image),
            None => config,
        };
        output.write_all(serde_json::to_string_pretty(&config)?.as_bytes())?;
        Ok(owned)
    }
}
impl Drop for PrivateConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) fn deploy(
    env: &Env,
    spec: &Spec,
    worker: &Deployable,
    config: Value,
    image: Option<&str>,
    head: &str,
) -> Result<()> {
    let copy = PrivateConfig::write(worker, config, image)?;
    let path = copy.0.to_str().ok_or("Invalid bootstrap config path")?;
    let revision = format!("BUILD_REVISION:{head}");
    let message = crate::deploy_ledger::message(env, head);
    crate::infra::wrangler::run(
        &spec.account_id,
        &crate::deploy_exec::deploy_args(path, &revision, head, &message, false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy_env::{Source, Step, steps};
    use crate::infra::inventory;
    use crate::infra::spec::{Env, Lock, PENDING_D1, Spec};
    use serde_json::{Value, json};
    use std::collections::BTreeSet;

    fn workers(prod: bool) -> Vec<inventory::Deployable> {
        let mut value: Value = serde_json::from_str(if prod {
            include_str!("../../infra/envs/prod.json")
        } else {
            include_str!("../../infra/envs/dev.json")
        })
        .unwrap();
        if value["cells"].as_array().is_none_or(Vec::is_empty) {
            value["cells"] = serde_json::from_str::<Value>(include_str!(
                "../../infra/envs/dev.json"
            ))
            .unwrap()["cells"]
                .clone();
        }
        value["cells"][0]["bound"] = json!(true);
        let spec = Spec::parse(&value.to_string()).unwrap();
        let mut lock: Lock = serde_json::from_str(if prod {
            include_str!("../../infra/envs/prod.lock.json")
        } else {
            include_str!("../../infra/envs/dev.lock.json")
        })
        .unwrap();
        for name in spec.d1_names().unwrap() {
            lock.d1.entry(name).or_insert(PENDING_D1.into());
        }
        inventory::deployables(&spec, &lock).unwrap()
    }

    #[test]
    fn new_region_bootstraps_provider_then_region_before_desired_bound_deploy() {
        for (prod, env) in [(false, Env::Dev), (true, Env::Prod)] {
            let workers = workers(prod);
            let primary = workers.iter().position(|w| w.role == "platform").unwrap();
            let region = workers
                .iter()
                .position(|w| w.role == "platform-weur")
                .unwrap();
            let missing = BTreeSet::from([workers[region].name.clone()]);
            let ordinary = steps(&env, &workers, false, &Source::Dockerfile);
            let plan = insert(ordinary, &workers, &missing).unwrap();
            let position = |wanted: &Step| plan.iter().position(|s| s == wanted).unwrap();
            let provider_boot = plan
                .iter()
                .position(|s| matches!(s,Step::Bootstrap{worker,..} if *worker==primary))
                .unwrap();
            let region_boot = plan
                .iter()
                .position(|s| matches!(s,Step::Bootstrap{worker,..} if *worker==region))
                .unwrap();
            assert!(provider_boot < region_boot);
            assert!(
                region_boot
                    < position(&Step::Deploy {
                        worker: primary,
                        dry_run: false
                    })
            );
            assert!(
                position(&Step::Deploy {
                    worker: primary,
                    dry_run: false
                }) < position(&Step::Deploy {
                    worker: region,
                    dry_run: false
                })
            );
            for worker in [primary, region] {
                let b = plan
                    .iter()
                    .position(|s| matches!(s,Step::Bootstrap{worker:w,..} if *w==worker))
                    .unwrap();
                assert!(matches!(plan[b - 1], Step::RolloutGate));
                assert_eq!(plan[b + 1], Step::Secrets { worker });
                assert_eq!(plan[b + 2], Step::Health { worker });
            }
        }
    }

    #[test]
    fn bootstrap_removes_only_missing_services_and_keeps_class_ids_images_and_d1() {
        let workers = workers(false);
        let region = workers.iter().find(|w| w.role == "platform-weur").unwrap();
        let primary = workers.iter().find(|w| w.role == "platform").unwrap();
        let missing = BTreeSet::from([region.name.clone()]);
        for worker in [primary, region] {
            let mut c = configuration(&worker.config, &missing).unwrap();
            assert_eq!(c["durable_objects"], worker.config["durable_objects"]);
            assert_eq!(c["migrations"], worker.config["migrations"]);
            assert_eq!(c["d1_databases"], worker.config["d1_databases"]);
            assert_eq!(c["containers"], worker.config["containers"]);
            assert!(
                c["services"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|s| s["service"] != region.name || s["binding"] == "SELF")
            );
            c["vars"]["AUTOMATIC_LOCALITY"] = worker.config["vars"]["AUTOMATIC_LOCALITY"].clone();
            c["vars"]["REGIONAL_API"] = worker.config["vars"]["REGIONAL_API"].clone();
            let mut expected = worker.config.clone();
            expected["services"]
                .as_array_mut()
                .unwrap()
                .retain(|s| s["service"] != region.name || s["binding"] == "SELF");
            assert_eq!(c, expected);
        }
    }

    #[test]
    fn existing_regions_and_dry_runs_have_no_bootstrap_or_extra_mutations() {
        let workers = workers(false);
        let ordinary = steps(&Env::Dev, &workers, false, &Source::Dockerfile);
        assert_eq!(
            insert(ordinary.clone(), &workers, &BTreeSet::new()).unwrap(),
            ordinary
        );
        let region = workers.iter().find(|w| w.role == "platform-weur").unwrap();
        let dry = steps(&Env::Dev, &workers, true, &Source::Dockerfile);
        let result = insert(
            dry.clone(),
            &workers,
            &BTreeSet::from([region.name.clone()]),
        )
        .unwrap();
        assert_eq!(result, dry);
        assert!(result.iter().all(|s| !s.mutates_remote()));
    }
}
