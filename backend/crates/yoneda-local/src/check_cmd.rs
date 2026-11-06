//! `check add|list|remove`: the clone's local checks, kept as the repository policy's command
//! runners (the engine's own model, so a check result is recorded against the exact commit
//! and policy digest). Where a check runs is the owner's explicit choice: `--on-host` runs
//! the command in a fresh checkout on this machine; `--image <image>` runs it in that
//! Docker image with no network. Pushed code is untrusted, so sandboxed agents' work should
//! be checked in an image.
use crate::authority::Cred;
use crate::layout::{Layout, local_error};
use crate::service::Service;
use serde_json::{Map, Value, json};
use std::path::Path;
use yoneda_core::Result;

const USAGE: &str = "usage: yoneda local check <add <name> [--timeout <seconds>] \
                     (--on-host | --image <image>) -- <command...> | list | remove <name>>";
const DEFAULT_TIMEOUT: u32 = 600;

/// The argv before an image's command; `{checkout}` and `{run}` are filled in per run.
pub const DOCKER: [&str; 11] = [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--name",
    "yoneda-check-{run}",
    "-v",
    "{checkout}:/work",
    "-w",
    "/work",
];

pub fn run(cwd: &Path, args: &[String]) -> Result<String> {
    let svc = Service::open(&Layout::find(cwd)?)?;
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("add"), Some(name)) => add(&svc, name, &args[2..]),
        (Some("list"), None) => list(&svc),
        (Some("remove"), Some(name)) => remove(&svc, name),
        _ => Err(local_error(USAGE)),
    }
}

/// The image a runner's argv runs in, or `None` on the host.
pub fn image_of(command: &[Value]) -> Option<String> {
    let prefix = command.len() > DOCKER.len()
        && command
            .iter()
            .zip(DOCKER)
            .all(|(a, d)| a.as_str() == Some(d));
    prefix
        .then(|| command[DOCKER.len()].as_str().map(str::to_owned))
        .flatten()
}

fn add(svc: &Service, name: &str, rest: &[String]) -> Result<String> {
    let split = rest
        .iter()
        .position(|a| a == "--")
        .ok_or_else(|| local_error(USAGE))?;
    let (flags, argv) = (&rest[..split], &rest[split + 1..]);
    if argv.is_empty() {
        return Err(local_error(USAGE));
    }
    let (mut timeout, mut on_host, mut image) = (DEFAULT_TIMEOUT, false, None);
    let mut it = flags.iter();
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--on-host" => on_host = true,
            "--image" => image = Some(it.next().ok_or_else(|| local_error(USAGE))?.clone()),
            "--timeout" => {
                timeout = it
                    .next()
                    .and_then(|t| t.parse().ok())
                    .ok_or_else(|| local_error("--timeout takes whole seconds"))?;
            }
            _ => return Err(local_error(USAGE)),
        }
    }
    let mut command: Vec<String> = match (on_host, image) {
        (true, None) => Vec::new(),
        (false, Some(image)) => DOCKER
            .iter()
            .map(|s| (*s).to_owned())
            .chain([image])
            .collect(),
        _ => {
            return Err(local_error(
                "Say where the check runs: --on-host or --image <image>",
            ));
        }
    };
    command.extend(argv.iter().cloned());
    edit(svc, |runners| {
        runners.insert(
            name.to_owned(),
            json!({ "command": command, "timeout_seconds": timeout }),
        );
        Ok(())
    })?;
    Ok(format!("check {name} added: it runs on what lands on main"))
}

fn remove(svc: &Service, name: &str) -> Result<String> {
    edit(svc, |runners| {
        runners
            .remove(name)
            .map(|_| ())
            .ok_or_else(|| local_error(format!("No check named {name}")))
    })?;
    Ok(format!("check {name} removed"))
}

fn list(svc: &Service) -> Result<String> {
    let status = svc
        .authority
        .call(&Cred::Owner, json!({ "op": "repo_status" }))?;
    let runners = status["policy"]["runners"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if runners.is_empty() {
        return Ok("No checks".into());
    }
    Ok(runners
        .iter()
        .map(|(name, r)| {
            let command = r["command"].as_array().cloned().unwrap_or_default();
            let (place, argv) = match image_of(&command) {
                Some(image) => (format!("in {image}"), &command[DOCKER.len() + 1..]),
                None => ("on host".to_owned(), &command[..]),
            };
            let argv: Vec<&str> = argv.iter().filter_map(Value::as_str).collect();
            format!(
                "{name}  {place}  {}s  {}",
                r["timeout_seconds"],
                argv.join(" ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Replaces the policy with `change` applied to its runners; everything else stays.
fn edit(svc: &Service, change: impl FnOnce(&mut Map<String, Value>) -> Result<()>) -> Result<()> {
    let status = svc
        .authority
        .call(&Cred::Owner, json!({ "op": "repo_status" }))?;
    let mut policy = status["policy"].clone();
    let mut runners = policy["runners"].as_object().cloned().unwrap_or_default();
    change(&mut runners)?;
    policy["runners"] = Value::Object(runners);
    svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_set_policy", "policy": policy }),
    )?;
    Ok(())
}
