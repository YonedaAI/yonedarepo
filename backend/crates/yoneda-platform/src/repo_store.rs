//! The YonedaRepo source platform authority: recorded commits, refs, the hash-chained
//! transaction log, checks, reviews and landing. It knows API principals only, never
//! agents or runs. Every operation is synchronous SQL; object-store I/O (Artifacts, R2)
//! happens in the adapter before `repo_record_commit` and never inside a transaction.
use crate::storage::{SqlStore, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod adopt;
mod annotated;
pub(crate) mod auth;
mod bisect;
mod branches;
mod break_glass;
mod change_comments;
mod change_hooks;
mod change_records;
mod changes;
mod changesets;
mod checkpoints;
mod checks;
mod classes;
mod contracts;
mod deletion;
mod git_http;
mod git_shallow;
mod git_wanted;
pub(crate) mod grants;
mod head;
mod history;
mod history_import;
mod hook_delivery;
mod hook_events;
mod hook_url;
mod hooks;
mod land;
mod land_queue;
mod land_tickets;
mod maintenance;
pub(crate) mod members;
mod merging;
pub(crate) mod migration;
mod policy;
pub(crate) mod prepare;
mod projection;
mod projection_plan;
mod pushed;
mod reads;
mod rebase;
mod record;
mod releases;
mod reviewers;
mod rows;
mod runner;
mod sessions;
pub(crate) mod staging;
mod store_lineage;
mod submitted;
mod symbols;
mod tags;
mod tokens;
mod tree_cache;
mod version_projection;
pub use migration::migrate_repo_store;
pub(crate) use rows::protected as protected_ref;

pub fn execute_repo_store<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    migrate_repo_store(db)?;
    execute_migrated(db, command)
}

/// One command against a store this process already migrated.
pub fn execute_migrated<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    let owned = db.clone();
    db.transaction(Box::new(move || {
        maintenance::scoped(&command, || dispatch(&owned, &command))
    }))
}

fn dispatch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let op = string(c, "op")?;
    if op == "repo_init" {
        return rows::init(db, c);
    }
    let settings = rows::settings(db)?;
    if settings.deleted_at.is_some() && !deletion::allowed_when_deleted(&op) {
        return Err(deletion::gone());
    }
    let actor = auth::actor(db, c, &settings)?;
    match op.as_str() {
        // Tags are release markers that never move: creating one needs `land` as well.
        "repo_tag_create" => actor.require("write").and_then(|()| actor.require("land")),
        "repo_branch_batch" if tags::in_batch(c) => {
            actor.require("write").and_then(|()| actor.require("land"))
        }
        // Releases publish a tag the way tags mark one: `land` as well as `write`.
        "repo_release_create" | "repo_release_delete" | "repo_release_asset_put" => {
            actor.require("write").and_then(|()| actor.require("land"))
        }
        "repo_prepare_commit"
        | "repo_record_commit"
        | "repo_rebase_plan"
        | "repo_branch_set"
        | "repo_branch_batch"
        | "repo_begin_commit" => actor.require("write"),
        // Owner (or repo:admin) checks and the purger's check happen in `deletion`.
        "repo_delete" | "repo_purge_target" => Ok(()),
        // Only the platform copies commit shard records in.
        "repo_adopt_commit" if !actor.can("system") => {
            Err(Error::new("FORBIDDEN", "Only the platform adopts commits"))
        }
        "repo_check" => actor.require("check"),
        "repo_session_record" => actor.require("write"),
        "repo_change_create" | "repo_change_close" | "repo_change_reopen" => actor.require("write"),
        // Reviewers discuss a change as well as writers.
        "repo_change_comment" => actor.require_any(&["write", "review"]),
        "repo_check_request" | "repo_bisect_start" => actor.require_any(&["write", "check"]),
        // The check executor advances bisects as results arrive.
        "repo_bisect_step" => actor.require_any(&["write", "check", "system"]),
        "repo_record_contract" => actor.require("write"),
        // Only the platform classifier records review classes.
        "repo_record_classes" | "repo_record_symbols" if !actor.can("classify") => Err(Error::new(
            "FORBIDDEN",
            "Only the platform classifier records derived classes",
        )),
        // Change records feed analytics; only the platform's derive job streams them.
        "repo_change_records" if !actor.can("classify") => Err(Error::new(
            "FORBIDDEN",
            "Only the platform reads change records",
        )),
        op if maintenance::owns(op) => maintenance::authorize(&actor, op),
        "repo_check_claim"
        | "repo_check_release"
        | "repo_check_complete"
        | "repo_projection_pending"
        | "repo_projection_result"
        | "repo_changeset_plan"
        | "repo_head"
        | "repo_changeset_record"
        | "repo_record_repair" => actor.require("system"),
        // Only the platform's object projector reads or settles the object outbox: a false
        // "projected" would drop the only copy of accepted objects.
        "repo_objects_pending"
        | "repo_objects_projected"
        | "repo_staged_objects"
        | "repo_projection_objects"
        | "repo_objects_stored"
            if !actor.can("system") =>
        {
            Err(Error::new(
                "FORBIDDEN",
                "Only the platform projects staged objects",
            ))
        }
        // Imported history is only recorded by the platform importer, which read it from
        // the object store; nobody else can declare commits into existence.
        "repo_record_imported" if !actor.can("import") => Err(Error::new(
            "FORBIDDEN",
            "Only the platform importer records imported history",
        )),
        "repo_review" => actor.require("review"),
        // Protected refs need `land`; any other branch lands with `write` (`land::scope`).
        "repo_land" | "repo_land_enqueue" => actor.require(land::scope(&rows::branch_ref(c)?)),
        // Only the platform merger builds and lands batches.
        "repo_land_claim"
        | "repo_land_batch"
        | "repo_land_release"
        | "repo_land_changesets"
        | "repo_land_submitted"
            if !actor.can("lander") =>
        {
            Err(Error::new(
                "FORBIDDEN",
                "Only the platform merger lands queued work",
            ))
        }
        "repo_set_policy" => actor.require_owner(),
        // Admins manage other members; only the owner manages admins (`members`).
        "repo_members" | "repo_member_put" | "repo_member_remove" => actor.require_owner(),
        // Hooks reveal repository events to an outside URL: the owner (or repo:admin) decides.
        "repo_hook_create" | "repo_hooks" | "repo_hook_delete" | "repo_hook_deliveries" => {
            actor.require_owner()
        }
        // Only the platform's hook job fans out, reads secrets and settles deliveries.
        "repo_hooks_fanout" | "repo_hook_claim" | "repo_hook_settle" if !actor.can("hooks") => {
            Err(Error::new("FORBIDDEN", "Only the platform delivers hooks"))
        }
        "repo_break_glass" => actor.require_human_owner(),
        "repo_clone_access" => actor.require_human_reader(),
        _ => actor.require("read"),
    }?;
    // Only the owner's own account keeps working while automation is paused (not admins).
    if !actor.repo_owner() && break_glass::PAUSED_OPS.contains(&op.as_str()) {
        break_glass::refuse_if_paused(db)?;
    }
    grants::precheck(db, &op, c, &actor.grant)?;
    let principal = actor.principal.as_str();
    let result = match op.as_str() {
        "repo_status" => reads::status(db, &settings, &actor),
        "repo_clone_access" => Ok(json!({ "object_store": settings.object_store })),
        "repo_refs" => reads::refs(db, c),
        "repo_snapshot" => reads::snapshot(db, c),
        "repo_log" => reads::log(db, c),
        "repo_txlog" => reads::txlog(db, c),
        "repo_change_records" => change_records::records(db, c),
        "repo_commit" => reads::commit(db, c, &settings),
        "repo_merge_base" => reads::merge_base(db, c),
        "repo_merge_plan" => merging::plan(db, c),
        "repo_path_history" => history::path_history(db, c),
        "repo_record_classes" => classes::record(db, c),
        "repo_record_symbols" => symbols::record(db, c),
        "repo_stale_reads" => symbols::stale_reads(db, c),
        "repo_record_contract" => contracts::record(db, c, principal),
        "repo_contracts" => contracts::list(db, c),
        "repo_bisect_start" => bisect::start(db, c, principal, &settings),
        "repo_bisect_step" => bisect::step_op(db, c, principal, &settings),
        op if maintenance::owns(op) => maintenance::run(db, c, op, principal),
        // The store travels with the answer, so the adapter needs no status read first.
        "repo_prepare_commit" => {
            prepare::prepare(db, c, principal, &settings).map(|mut prepared| {
                prepared["object_store"] = json!(settings.object_store);
                prepared
            })
        }
        "repo_record_commit" => record::record(db, c, principal, &settings),
        "repo_begin_commit" => adopt::begin(db, c, principal, &settings),
        "repo_adopt_commit" => adopt::adopt(db, c, &settings),
        "repo_check" => record::check(db, c, &actor, &settings),
        "repo_check_request" => checks::request_op(db, c, principal, &settings),
        "repo_session_record" => sessions::record(db, c, &actor),
        "repo_sessions" => sessions::list(db, c, &actor),
        "repo_change_create" => changes::create(db, c, &actor),
        "repo_changes" => changes::list(db, c, &actor),
        "repo_change_show" => changes::show(db, c, &actor, &settings),
        "repo_change_comment" => change_comments::comment(db, c, &actor),
        "repo_change_close" => changes::set_open(db, c, &actor, false),
        "repo_change_reopen" => changes::set_open(db, c, &actor, true),
        "repo_check_claim" => checks::claim(db, c),
        "repo_check_release" => checks::release(db, c),
        "repo_check_run" => checks::run_op(db, c),
        "repo_record_repair" => checks::record_repair(db, c),
        "repo_check_complete" => checks::complete(db, c, principal),
        "repo_set_policy" => checks::set_policy(db, c, principal),
        "repo_projection_pending" => projection::pending(db),
        "repo_projection_result" => projection::result(db, c),
        "repo_objects_pending" => staging::pending(db),
        "repo_objects_projected" => staging::projected(db, c),
        "repo_staged_objects" => pushed::bundles::staged(db, c),
        "repo_projection_objects" => store_lineage::unprojected(db, c),
        "repo_objects_stored" => store_lineage::stored_op(db, c),
        "repo_review" => record::review(db, c, principal),
        "repo_branch_set" => branches::set(db, c, principal),
        "repo_rebase_plan" => rebase::plan(db, c),
        "repo_branch_batch" => branches::batch(db, c, principal),
        "repo_tag_create" => tags::create(db, c, principal),
        "repo_tag_show" => annotated::tag_show(db, c),
        "repo_release_create" => releases::create(db, c, &actor),
        "repo_releases" => releases::list(db, c, &actor),
        "repo_release_show" => releases::show(db, c, &actor),
        "repo_release_delete" => releases::delete(db, c, &actor),
        "repo_release_asset_put" => releases::asset_put(db, c, &actor),
        "repo_release_asset" => releases::asset(db, c, &actor),
        // Git over HTTPS: each checks its own scope (read to fetch, write to push).
        "repo_git_access" => git_http::access(&actor, c, &settings),
        "repo_git_walk" => git_http::walk(db, c, &actor),
        "repo_record_pushed" => pushed::record(db, c, &actor, &settings),
        "repo_bundle_index" | "repo_bundle_locate" => pushed::bundles::op(db, c, &op, &actor),
        "repo_delete" => deletion::delete(db, c, &actor, &settings),
        "repo_purge_target" => deletion::purge_target(&actor, &settings),
        // `enqueue`: a landing that needs a merge joins the branch's queue in this call.
        "repo_land" => land::land(db, c, principal, &settings).or_else(|e| {
            if e.code == "MERGE_REQUIRED" && c["enqueue"] == true {
                land_tickets::enqueue(db, c, principal, &settings)
            } else {
                Err(e)
            }
        }),
        "repo_land_enqueue" => land_tickets::enqueue(db, c, principal, &settings),
        "repo_land_status" => land_tickets::status(db, c),
        "repo_land_claim" => land_queue::claim(db, c),
        "repo_land_batch" => land_queue::land_batch(db, c, principal),
        "repo_land_release" => land_queue::release(db, c),
        "repo_land_changesets" => changesets::land(db, c),
        "repo_land_submitted" => submitted::land(db, c, &settings),
        "repo_changeset_plan" => projection_plan::plan(db, c),
        "repo_head" => head::head(db, c, &settings),
        "repo_changeset_record" => version_projection::record(db, c, &settings),
        "repo_record_imported" => history_import::record(db, c),
        "repo_break_glass" => break_glass::execute(db, c, principal, &settings),
        "repo_import" => {
            if !actor.can("import") {
                actor.require_owner()?;
            }
            land::import(db, c, principal)
        }
        "repo_hook_create" => hooks::create(db, c, &actor),
        "repo_hooks" => hooks::list(db),
        "repo_hook_delete" => hooks::delete(db, c),
        "repo_hook_deliveries" => hooks::deliveries(db, c),
        "repo_hooks_fanout" => hook_events::fanout(db),
        "repo_hook_claim" => hook_delivery::claim(db, c),
        "repo_hook_settle" => hook_delivery::settle(db, c),
        "repo_token_create" => tokens::create_token(db, c, &actor),
        "repo_token_revoke" => tokens::revoke_token(db, c, &actor),
        "repo_tokens" => tokens::list_tokens(db, &actor),
        "repo_members" => members::list(db),
        "repo_member_put" => members::put(db, c, &actor, &settings),
        "repo_member_remove" => members::remove(db, c, &actor, &settings),
        _ => Err(Error::new(
            "UNKNOWN_OP",
            format!("Unknown platform op {op}"),
        )),
    }?;
    Ok(grants::redact(&op, &actor.grant, result))
}

#[cfg(test)]
mod tests;
