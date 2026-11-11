//! Up: local the integration branch onto cloud the integration branch, by a stock smart-HTTP push from the store, so every
//! commit keeps its id. The push declares the union of what the unsynced local landings
//! read, so the cloud's own landing rules judge them; a refusal leaves the cloud as it was
//! and local the integration branch as it is (a local landing is never rolled back).
use super::state::{State, Sync};
use super::{Ctx, classify, local_head, log_version};
use crate::cloud;
use crate::service::PROJECTOR;
use serde_json::json;
use std::collections::BTreeSet;
use yoneda_core::Result;

/// Page size when reading the local log for read sets.
const LOG_PAGE: u64 = 500;
/// The most read paths one push declares (the cloud caps them as well).
const MAX_READS: usize = 1000;

/// Pushes local the integration branch when the cloud lacks it. Answers whether anything was pushed.
pub fn up(ctx: &Ctx, sync: &mut Sync) -> Result<bool> {
    let Some(local) = local_head(ctx.svc)? else {
        return Ok(false);
    };
    let version = log_version(ctx.svc)?;
    let on_cloud = sync.cloud_main.as_deref().is_some_and(|c| {
        c == local.to_string()
            || yoneda_core::git_object::ObjectId::parse(c)
                .is_ok_and(|c| ctx.svc.store.has(&c) && ctx.svc.store.is_ancestor(&local, &c))
    });
    if on_cloud {
        sync.synced_version = version;
        return Ok(false);
    }
    let reads = unsynced_reads(ctx, sync.synced_version)?;
    let url = ctx.cloud.git_url();
    let refspec = format!("{local}:{}", ctx.svc.config.refname());
    let option = format!("yoneda.reads={}", reads.join(","));
    let mut args = vec!["push", "--porcelain", &url, &refspec];
    if !reads.is_empty() {
        args.extend(["-o", &option]);
    }
    let out = cloud::git(&ctx.layout.store(), &ctx.cloud.origin, &args)?;
    if out.status.success() {
        sync.synced_version = version;
        return Ok(true);
    }
    let porcelain = String::from_utf8_lossy(&out.stdout);
    let rejected = porcelain
        .lines()
        .find(|l| l.starts_with('!') && l.contains(&ctx.svc.config.refname()));
    match rejected {
        Some(line) if line.contains("conflict") => {
            let why = line.rsplit('\t').next().unwrap_or(line).trim();
            sync.note(
                State::Conflict,
                format!(
                    "the cloud refused local {} {local}: {why}",
                    ctx.svc.config.branch
                ),
            );
        }
        Some(line) => sync.note(State::Pending, line.trim().to_owned()),
        None => {
            let (state, why) = classify(&out);
            sync.note(state, why);
        }
    }
    Ok(false)
}

/// Every path the local landings on the integration branch after `version` declared they read.
fn unsynced_reads(ctx: &Ctx, mut after: u64) -> Result<Vec<String>> {
    let mut reads = BTreeSet::new();
    loop {
        let page = ctx.svc.authority.call(
            &PROJECTOR,
            json!({ "op": "repo_txlog", "after": after, "limit": LOG_PAGE }),
        )?;
        let entries = page["entries"].as_array().cloned().unwrap_or_default();
        let Some(last) = entries.last().and_then(|e| e["version"].as_u64()) else {
            break;
        };
        for e in &entries {
            if e["refname"] == ctx.svc.config.refname() {
                for r in e["read_set"].as_array().into_iter().flatten() {
                    if let Some(r) = r.as_str() {
                        reads.insert(r.to_owned());
                    }
                }
            }
        }
        after = last;
    }
    Ok(reads.into_iter().take(MAX_READS).collect())
}
