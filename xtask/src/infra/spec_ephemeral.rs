//! Isolated one-cell disposable environments derived from the normal spec.
use super::retired::Retired;
use super::spec::{Env, Spec};
use serde_json::{Value, json};

const EPHEMERAL_RATE_LIMIT: &str = "2900";
const EPHEMERAL_PUBLIC_RATE_LIMIT: &str = "2901";

impl Spec {
    /// The dev stack under its own prefix: workers.dev only, its own resources and secrets,
    /// one container instance per class.
    pub(crate) fn ephemeral(mut self, env: &Env) -> Self {
        let prefix = format!("yonedarepo-{}", env.name().replace("ephemeral", "eph"));
        self.env = env.name();
        self.git_ref = None;
        self.secrets_file = env.state_dir().join("secrets.env").display().to_string();
        self.vars
            .insert("ratelimit".into(), EPHEMERAL_RATE_LIMIT.into());
        self.vars.insert(
            "public_ratelimit".into(),
            EPHEMERAL_PUBLIC_RATE_LIMIT.into(),
        );
        self.vars.insert(
            "origin".into(),
            format!(
                "https://{prefix}-agents.{}.workers.dev",
                self.workers_subdomain
            ),
        );
        self.prefix = prefix;
        self.workers.retain(|w| w.ephemeral);
        // A copy has one cell: what names another goes with it.
        self.cells.clear();
        self.api_regions.clear();
        for worker in &mut self.workers {
            if let Some(databases) = worker
                .config
                .get_mut("d1_databases")
                .and_then(Value::as_array_mut)
            {
                databases.retain(|d| {
                    !d["binding"]
                        .as_str()
                        .is_some_and(|b| b.starts_with("INDEX_"))
                });
            }
        }
        // A service binding to a Worker the copy leaves out would fail its deploy; the binder
        // treats a missing binding as the feature being off (the front's MANAGED).
        let kept: Vec<Value> = self
            .workers
            .iter()
            .map(|w| w.config["name"].clone())
            .collect();
        for worker in &mut self.workers {
            if let Some(services) = worker
                .config
                .get_mut("services")
                .and_then(Value::as_array_mut)
            {
                services.retain(|s| kept.contains(&s["service"]));
            }
        }
        self.retired = Retired::default();
        self.check_instances = self.check_instances.map(|_| 1);
        for worker in &mut self.workers {
            worker.file = format!("wrangler.{}-{}.jsonc", env.name(), worker.role);
            // Its generated secrets file has no R2 S3 key pair: Git LFS answers 501 there. Git
            // over SSH stays off: the host name, tunnel and host keys belong to one env.
            worker
                .secrets
                .retain(|s| !s.starts_with("LFS_S3_") && !s.starts_with("SSH_"));
            worker.notes = vec![format!(
                "Ephemeral stack {}: removed by `cargo xtask infra down --env {} --confirm --purge`.",
                env.name(),
                env.name()
            )];
            if let Some(config) = worker.config.as_object_mut() {
                config.remove("routes");
                config.remove("tail_consumers");
                config.insert("workers_dev".into(), json!(true));
                if let Some(vars) = config.get_mut("vars").and_then(Value::as_object_mut) {
                    vars.remove("SSH_HOST");
                    vars.remove("API_REGION");
                    if vars.contains_key("REGIONAL_API") {
                        vars.insert("REGIONAL_API".into(), json!("off"));
                    }
                    // The sender is one env's verified domain (and email is off here).
                    vars.remove("EMAIL_FROM");
                    if vars.contains_key("SSH_FRONT_DOOR") {
                        vars.insert("SSH_FRONT_DOOR".into(), json!("off"));
                    }
                }
                if let Some(containers) = config.get_mut("containers").and_then(Value::as_array_mut)
                {
                    for container in containers {
                        container["max_instances"] = json!(1);
                    }
                }
            }
        }
        self
    }
}
