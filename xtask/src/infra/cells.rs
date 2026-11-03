//! Cells: a region's whole copy of the platform (docs/global-scale-plan.md, cells as built). A
//! spec names each cell once, and its Worker is made here from the platform Worker's own config,
//! so a cell can't drift from the stack it copies. `enam` is that stack, under its own names: a
//! cell adds a Worker beside it and changes nothing of it until `bound` says so.
use super::spec::{Spec, WorkerSpec};
use crate::process::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const PLATFORM: &str = "platform";
const FRONT: &str = "agents";
const EDGE: &str = "edge";
/// Object classes a cell runs itself. Accounts are shared, and SSH has one gateway.
const OWN_CLASSES: [&str; 6] = [
    "SourceRepository",
    "CheckContainer",
    "CommitShard",
    "LandCombiner",
    "PackBuilder",
    "ImportContainer",
];
const NOT_IN_A_CELL: &str = "SshGateway";
/// One stream, one billing reconcile, one newsletter: never a cell's.
const OFF_IN_A_CELL: [&str; 2] = ["ADMIN_BILLING", "NEWSLETTER"];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct CellSpec {
    /// Its region code, the one accounts and repository ids name.
    pub code: String,
    /// Optional fetch placement; absent means Cloudflare edge execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<String>,
    /// Where its containers run: `constraints.regions`.
    pub containers: String,
    /// Its objects', bucket's, D1's and queues' jurisdiction, fixed at creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jurisdiction: Option<String>,
    /// Its rate limiters' namespace ids.
    pub ratelimit: String,
    pub public_ratelimit: String,
    /// The other Workers know it. False while it stands alone, with nothing able to reach it.
    #[serde(default)]
    pub bound: bool,
}

impl CellSpec {
    fn suffix(&self) -> String {
        format!("-{}", self.code)
    }
    fn upper(&self) -> String {
        self.code.to_uppercase()
    }
    fn service(&self) -> String {
        format!("{{prefix}}-platform{}", self.suffix())
    }
    fn index(&self) -> String {
        format!("{{prefix}}-platform-index{}", self.suffix())
    }
}

fn platform_index(config: &Value) -> Result<String> {
    config["d1_databases"][0]["database_name"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "The platform Worker has no D1".into())
}

fn renamed(value: &mut Value, suffix: &str) {
    if let Some(name) = value.as_str() {
        *value = json!(format!("{name}{suffix}"));
    }
}

fn each<'a>(config: &'a mut Value, path: &str) -> impl Iterator<Item = &'a mut Value> {
    config
        .pointer_mut(path)
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
}

fn queues(config: &mut Value, suffix: &str) {
    for producer in each(config, "/queues/producers") {
        renamed(&mut producer["queue"], suffix);
    }
    for consumer in each(config, "/queues/consumers") {
        renamed(&mut consumer["queue"], suffix);
        renamed(&mut consumer["dead_letter_queue"], suffix);
    }
}

fn vars(config: &mut Value, cell: &CellSpec) {
    let endpoint = match &cell.jurisdiction {
        Some(place) => format!("https://{{account_id}}.{place}.r2.cloudflarestorage.com"),
        None => "https://{account_id}.r2.cloudflarestorage.com".to_owned(),
    };
    let bucket = format!("{{prefix}}-platform-objects{}", cell.suffix());
    let vars = &mut config["vars"];
    vars["CELL"] = json!(cell.code);
    vars["CELLS"] = json!("on");
    vars["CELL_HINT"] = json!(cell.code);
    if let Some(place) = &cell.jurisdiction {
        vars["CELL_JURISDICTION"] = json!(place);
    }
    vars["LFS_S3_ENDPOINT"] = json!(endpoint);
    vars["LFS_S3_BUCKET"] = json!(bucket);
    vars["SSH_FRONT_DOOR"] = json!("off");
    for name in OFF_IN_A_CELL {
        vars[name] = json!("off");
    }
    if let Some(all) = vars.as_object_mut() {
        all.remove("SSH_HOST");
        // Keep an explicitly enabled dev-only location diagnostic in derived cells too.
        // Production declares none, so it exposes no extra diagnostic route.
    }
}

fn bindings(config: &mut Value, cell: &CellSpec, name: &str) -> Result<()> {
    let enam_index = platform_index(config)?;
    for binding in each(config, "/durable_objects/bindings") {
        if binding["class_name"] == "WorkspaceAuthority"
            || binding["class_name"] == "RepositoryReadCopy"
        {
            binding["script_name"] = json!("{prefix}-platform");
        }
    }
    if let Some(list) = config
        .pointer_mut("/durable_objects/bindings")
        .and_then(Value::as_array_mut)
    {
        list.retain(|b| b["class_name"] != NOT_IN_A_CELL);
    }
    for service in each(config, "/services") {
        if service["binding"] == "SELF" {
            service["service"] = json!(name);
        }
    }
    if let Some(services) = config["services"].as_array_mut() {
        services.push(json!({"binding": "CELL_ENAM", "service": "{prefix}-platform"}));
    }
    for bucket in each(config, "/r2_buckets") {
        renamed(&mut bucket["bucket_name"], &cell.suffix());
        if let Some(place) = &cell.jurisdiction {
            bucket["jurisdiction"] = json!(place);
        }
    }
    for database in each(config, "/d1_databases") {
        renamed(&mut database["database_name"], &cell.suffix());
    }
    if let Some(databases) = config["d1_databases"].as_array_mut() {
        databases.push(json!({"binding": "INDEX_ENAM", "database_name": enam_index}));
    }
    Ok(())
}

fn containers(config: &mut Value, cell: &CellSpec) {
    if let Some(list) = config["containers"].as_array_mut() {
        list.retain(|c| c["class_name"] != NOT_IN_A_CELL);
        for container in list {
            let constraints = &mut container["constraints"];
            constraints["regions"] = json!([cell.containers]);
            if let Some(place) = &cell.jurisdiction {
                constraints["jurisdiction"] = json!(place);
            }
        }
    }
}

/// The cell's Worker: the platform's config, with everything that names a place of its own.
fn cell_worker(platform: &WorkerSpec, spec: &Spec, cell: &CellSpec) -> Result<WorkerSpec> {
    let mut config = platform.config.clone();
    let name = cell.service();
    config["name"] = json!(name);
    config["workers_dev"] = json!(true);
    if let Some(region) = &cell.placement {
        config["placement"] = json!({"mode": "targeted", "region": region});
    } else if let Some(config) = config.as_object_mut() {
        config.remove("placement");
    }
    if let Some(all) = config.as_object_mut() {
        // Reached through bindings; `CHANGELOG` is one stream, and not yet a cell's.
        all.remove("routes");
        all.remove("pipelines");
    }
    bindings(&mut config, cell, &name)?;
    queues(&mut config, &cell.suffix());
    containers(&mut config, cell);
    for workflow in each(&mut config, "/workflows") {
        renamed(&mut workflow["name"], &cell.suffix());
    }
    config["ratelimits"][0]["namespace_id"] = json!(cell.ratelimit);
    config["ratelimits"][1]["namespace_id"] = json!(cell.public_ratelimit);
    config["migrations"] = json!([{"tag": "v1", "new_sqlite_classes": OWN_CLASSES}]);
    vars(&mut config, cell);
    let lfs = |name: &str| format!("{name}_{}", cell.upper());
    let keys = ["LFS_S3_ACCESS_KEY_ID", "LFS_S3_SECRET_ACCESS_KEY"];
    Ok(WorkerSpec {
        role: format!("{PLATFORM}{}", cell.suffix()),
        file: format!("wrangler.{}-platform{}.jsonc", spec.env, cell.suffix()),
        notes: vec![
            format!(
                "The {} cell (docs/global-scale-plan.md, cells as built): the platform Worker's config with its own",
                cell.code
            ),
            "objects, bucket, D1, queues, workflow and containers. Accounts are the platform Worker's, by script_name.".into(),
            "Made by xtask/src/infra/cells.rs: change the platform Worker, or the spec's cells, not this.".into(),
        ],
        secrets: vec!["OWNER_TOKEN".into(), "SSH_GATEWAY_SECRET".into()],
        // Its bucket's own R2 keys. Without them Git LFS answers 501 here and nothing else changes.
        optional_secrets: keys
            .iter()
            .map(|key| (*key).to_owned())
            .chain(
                platform
                    .optional_secrets
                    .iter()
                    .filter(|name| !name.starts_with("NEWSLETTER"))
                    .cloned(),
            )
            .collect(),
        secret_files: keys.iter().map(|key| ((*key).to_owned(), lfs(key))).collect::<BTreeMap<_, _>>(),
        health: platform.health.clone(),
        ephemeral: false,
        always_on: BTreeMap::new(),
        config,
    })
}

/// What the other Workers gain once a cell is `bound`.
fn bind(spec: &mut Spec, cell: &CellSpec) -> Result<()> {
    let binding = format!("CELL_{}", cell.upper());
    for worker in &mut spec.workers {
        let role = worker.role.as_str();
        let other_cell = role.starts_with("platform-") && role != cell_role(cell);
        if !(role == PLATFORM || role == FRONT || role == EDGE || other_cell) {
            continue;
        }
        if let Some(services) = worker.config["services"].as_array_mut() {
            services.push(json!({"binding": binding, "service": cell.service()}));
        }
        if role == PLATFORM || other_cell {
            let index = json!({"binding": format!("INDEX_{}", cell.upper()), "database_name": cell.index()});
            match worker.config["d1_databases"].as_array_mut() {
                Some(databases) => databases.push(index),
                None => return Err(format!("{role} has no D1").into()),
            }
        }
    }
    Ok(())
}

fn cell_role(cell: &CellSpec) -> String {
    format!("{PLATFORM}{}", cell.suffix())
}

/// Shared class exports must exist before a regional Worker's cross-script bindings.
/// Bootstrap regional Workers unbound before enabling service bindings back to them.
pub(super) fn expand(spec: &mut Spec) -> Result<()> {
    for (offset, cell) in spec.cells.clone().into_iter().enumerate() {
        let at = spec
            .workers
            .iter()
            .position(|w| w.role == PLATFORM)
            .ok_or("A cell copies the platform Worker, and the spec has none")?;
        let worker = cell_worker(&spec.workers[at], spec, &cell)?;
        spec.workers.insert(at + offset + 1, worker);
    }
    for cell in spec.cells.clone() {
        if cell.bound {
            bind(spec, &cell)?;
        }
    }
    Ok(())
}

/// The jurisdiction a resource of this spec is created in.
pub(super) fn jurisdiction_of(spec: &Spec, resource: &str) -> Option<String> {
    spec.cells
        .iter()
        .find(|cell| resource.ends_with(&cell.suffix()))
        .and_then(|cell| cell.jurisdiction.clone())
}
