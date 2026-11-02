//! One command: parse its op, authorize the caller, run it, and redact the answer to the
//! caller's grant. Families with their own tables (`maintenance`, `lfs`, `forks`) run theirs.
use super::auth::{self, Actor};
use super::op::{InitOp, Op, RepoOp as R, StoreOp};
use super::rows::{self, Settings};
use super::{
    activity, adopt, agent_context, agent_reads, annotated, audit_outbox, auto_landing, bisect,
    branches, capacity, change_closing, change_comments, change_delete, change_gates,
    change_instruments, change_records, change_route, changes, changesets, checks, classes,
    commit_authors, contracts, dir_activity, flight_plans, git_http, head, history, history_reset,
    hook_delivery, hook_events, hooks, land, land_batch, land_queue, land_tickets,
    land_when_cleared, legal_hold, members, merging, prepare, projection_plan, pushed, reads,
    rebase, record, releases, search_records, sessions, staging, submitted, symbols, tags, tokens,
    version_projection,
};
use super::{
    authorize::authorize, break_glass, deletion, erase, forks, grants, lfs, maintenance, memory,
    quarantine, undo, visibility,
};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::Result;

pub(super) fn dispatch<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let op = match Op::parse(c)? {
        Op::Init(InitOp::Init) => return rows::init(db, c),
        Op::Store(op) => op,
    };
    let settings = rows::settings(db)?;
    if settings.deleted_at.is_some() && !deletion::allowed_when_deleted(op, c, &settings) {
        return Err(deletion::gone());
    }
    let actor = auth::actor(db, c, &settings)?;
    deletion::tombstone_caller(op, c, &actor, &settings)?;
    visibility::gate(&actor, op, c)?;
    authorize(&actor, op, c)?;
    // Only the owner's own account keeps working while automation is paused (not admins).
    if !actor.repo_owner() && break_glass::pauses(op) {
        break_glass::refuse_if_paused(db)?;
    }
    grants::precheck(db, op, c, &actor.grant)?;
    if capacity::refuses(op) {
        capacity::refuse_if_full(db, c)?;
    }
    if capacity::adds_objects(op) {
        capacity::refuse_if_over_size(&settings, c)?;
    }
    // An erased tombstone holds nothing, and no longer knows its owner.
    if legal_hold::refuses(op) && !settings.erased() {
        legal_hold::require_free(c, &settings.workspace)?;
    }
    let since = land_when_cleared::watching(db, op, c, &settings);
    let mut result = run(db, c, op, &actor, &settings)?;
    land_when_cleared::ask_for_jobs(db, op, c, since, &mut result);
    Ok(grants::redact(op, &actor.grant, result))
}

fn run<S: SqlStore>(
    db: &S,
    c: &Value,
    op: StoreOp,
    actor: &Actor,
    settings: &Settings,
) -> Result<Value> {
    let principal = actor.principal.as_str();
    let op = match op {
        StoreOp::Maintenance(op) => return maintenance::run(db, c, op, principal),
        StoreOp::Lfs(op) => return lfs::run(db, c, op, actor, settings),
        StoreOp::Fork(op) => return forks::run(db, c, op, actor, settings),
        StoreOp::Quarantine(op) => return quarantine::run(db, c, op, actor),
        StoreOp::Memory(op) => return memory::run(db, c, op, actor),
        StoreOp::Repo(op) => op,
    };
    match op {
        R::Status => serde_json::to_value(super::status::status(db, settings, actor)?)
            .map_err(|e| yoneda_core::Error::new("ENCODING", e.to_string())),
        R::Storage => capacity::repo_usage(db, settings),
        R::SizeAdd => capacity::add_pack(db, settings, c).map(|()| json!({})),
        R::Refs => reads::refs(db, c),
        R::Snapshot => reads::snapshot(db, c),
        R::Log => reads::log(db, c),
        R::Txlog => reads::txlog(db, c),
        R::ChangeRecords => change_records::records(db, c),
        R::Activity => activity::activity(db, c),
        R::Insights => super::insights::insights(db, c, actor),
        R::Commit => reads::commit(db, c, settings),
        R::MergeBase => reads::merge_base(db, c),
        R::MergePlan => merging::plan(db, c),
        R::PathHistory => history::path_history(db, c),
        R::DirActivity => dir_activity::dir_activity(db, c),
        R::RecordClasses => classes::record(db, c),
        R::ClassesPending => classes::pending(db, c),
        R::RecordSymbols => symbols::record(db, c),
        R::StaleReads => symbols::stale_reads(db, c),
        R::RecordContract => contracts::record(db, c, principal),
        R::Contracts => contracts::list(db, c),
        R::BisectStart => bisect::start(db, c, principal, settings),
        R::BisectStep => bisect::step_op(db, c, principal, settings),
        // The store (and what it withholds) travels with the answer, so the adapter needs
        // no status read first.
        R::PrepareCommit => {
            prepare::prepare(db, c, principal, settings).and_then(|mut prepared| {
                prepared["object_store"] = json!(settings.object_store);
                prepared["quarantined"] = json!(quarantine::withheld(db)?);
                Ok(prepared)
            })
        }
        R::RecordCommit => record::record(db, c, principal, settings),
        R::BeginCommit => adopt::begin(db, c, principal, settings).and_then(|mut begun| {
            begun["quarantined"] = json!(quarantine::withheld(db)?);
            Ok(begun)
        }),
        R::AdoptCommit => adopt::adopt(db, c, settings),
        R::Check => record::check(db, c, actor, settings),
        R::CheckRequest => checks::request_op(db, c, principal, settings),
        R::SessionRecord => sessions::record(db, c, actor),
        R::Sessions => sessions::list(db, c, actor),
        R::SessionList => agent_reads::session_list(db, c, actor),
        R::SearchRecords => search_records::search(db, c, actor),
        R::SessionShow => agent_reads::session_show(db, c, actor),
        R::SessionTranscript => sessions::transcript(db, c, actor),
        R::ContractList => agent_reads::contract_list(db, c),
        R::PinList => agent_reads::pin_list(db, actor),
        R::BisectList => agent_reads::bisect_list(db, c, actor),
        R::AgentContext => agent_context::context(db, c, actor, settings),
        R::FlightPlan => flight_plans::file(db, c, actor),
        R::ChangeCreate => changes::create(db, c, actor),
        R::Changes => changes::list(db, c, actor),
        R::ChangeShow => changes::show(db, c, actor, settings),
        R::ChangeComment => change_comments::comment(db, c, actor),
        R::ChangeClose => change_closing::set_open(db, c, actor, false),
        R::ChangeReopen => change_closing::set_open(db, c, actor, true),
        R::ChangeDelete => change_delete::delete(db, c, actor),
        R::ChangeGates => change_gates::gates(db, c, actor, settings),
        R::CtcRadar => super::traffic::radar::radar(db, c, actor, settings),
        R::ChangeRoute => change_route::route(db, c, actor),
        R::ChangeInstruments => change_instruments::read(db, c, actor),
        R::CheckClaim => checks::claim(db, c),
        R::CheckRelease => checks::release(db, c),
        R::CheckRun => super::check_run_reads::run_op(db, c),
        R::RecordRepair => checks::record_repair(db, c),
        R::CheckComplete => checks::complete(db, c, principal),
        R::SetPolicy => checks::set_policy(db, c, principal, settings),
        R::AutoLandings => auto_landing::set(db, c),
        R::ObjectsPending => staging::pending(db),
        R::ObjectsProjected => staging::projected(db, c),
        R::StagedObjects => pushed::bundles::staged(db, c),
        R::Review => record::review(db, c, principal),
        R::BranchSet => branches::set(db, c, principal),
        R::RebasePlan => rebase::plan(db, c),
        R::BranchBatch => branches::batch(db, c, principal),
        R::TagCreate => tags::create(db, c, principal),
        R::TagShow => annotated::tag_show(db, c),
        R::ReleaseCreate => releases::create(db, c, actor),
        R::Releases => releases::list(db, c, actor),
        R::ReleaseShow => releases::show(db, c, actor),
        R::ReleaseDelete => releases::delete(db, c, actor),
        R::ReleaseAssetPut => releases::asset_put(db, c, actor),
        R::ReleaseAsset => releases::asset(db, c, actor),
        // Git over HTTPS: each checks its own scope (read to fetch, write to push).
        // Withheld blobs travel with access: the adapter refuses a fetch that needs one.
        R::GitAccess => git_http::access(actor, c, settings).and_then(|mut access| {
            access["quarantined"] = json!(quarantine::withheld(db)?);
            Ok(access)
        }),
        R::GitWalk => git_http::walk(db, c, actor),
        R::RecordPushed => pushed::record(db, c, actor, settings),
        R::BundleIndex => {
            pushed::bundles::require_system(actor).and_then(|()| pushed::bundles::index(db, c))
        }
        R::BundleLocate => {
            pushed::bundles::require_system(actor).and_then(|()| pushed::bundles::locate(db, c))
        }
        R::Delete => deletion::delete(db, c, actor, settings),
        R::PurgeNow => undo::purge_now(db, c, actor, settings),
        R::PurgeTarget => deletion::purge_target(db, c, actor, settings),
        R::Purged => undo::purged(db, c, actor, settings),
        R::Restore => undo::restore(db, c, actor, settings),
        R::HoldOwner => Ok(json!({ "owner": settings.workspace })),
        R::AuditPending => audit_outbox::pending(db, c, settings),
        R::AuditDone => audit_outbox::done(db, c),
        R::AuditSetAside => audit_outbox::set_aside(db, c),
        R::ErasePlan => erase::plan(db, c, settings),
        R::EraseStep => erase::step(db, c, settings),
        // `enqueue`: a landing that needs a merge joins the branch's queue in this call.
        R::Land => {
            let cleared = land_when_cleared::guard(db, c, actor, settings)?;
            let landed = land::land(db, c, principal, settings).or_else(|e| {
                if e.code == "MERGE_REQUIRED" && c["enqueue"] == true {
                    land_tickets::enqueue(db, c, principal, settings)
                } else {
                    Err(e)
                }
            })?;
            land_when_cleared::after_land(db, c, cleared.as_ref(), &landed)?;
            Ok(landed)
        }
        R::LandEnqueue => land_when_cleared::refuse_bare_land(actor)
            .and_then(|()| land_tickets::enqueue(db, c, principal, settings)),
        R::LandClearance => land_when_cleared::ask(db, c, settings),
        R::LandStatus => land_tickets::status(db, c),
        R::LandClaim => land_queue::claim(db, c, settings),
        R::LandBatch => land_batch::land_batch(db, c, principal, settings),
        R::LandRelease => land_batch::release(db, c),
        R::LandChangesets => changesets::land(db, c),
        R::LandSubmitted => submitted::land(db, c, settings),
        R::ChangesetPlan => projection_plan::plan(db, c),
        R::Head => head::head(db, c, settings),
        R::ChangesetRecord => version_projection::record(db, c, settings),
        R::ImportRefs => branches::import_refs(db, c, principal),
        R::ImportReset => history_reset::step(db, c, settings),
        R::AuthorsMissing => commit_authors::missing(db, c),
        R::AuthorsSet => commit_authors::fill(db, c),
        R::StoreAudit => history_reset::audit(db, settings),
        R::BreakGlass => break_glass::execute(db, c, principal, settings),
        R::Import => {
            let importer = actor.can("import");
            if !importer {
                actor.require_owner()?;
            }
            let landed = land::import(db, c, principal, importer)?;
            capacity::add_pack(db, settings, c)?;
            Ok(landed)
        }
        R::HookCreate => hooks::create(db, c, actor),
        R::Hooks => hooks::list(db),
        R::HookDelete => hooks::delete(db, c, actor),
        R::HookDeliveries => hooks::deliveries(db, c),
        R::HooksFanout => hook_events::fanout(db),
        R::HookClaim => hook_delivery::claim(db, c),
        R::HookSettle => hook_delivery::settle(db, c),
        R::TokenCreate => tokens::create_token(db, c, actor),
        R::TokenRevoke => tokens::revoke_token(db, c, actor),
        R::Tokens => tokens::list_tokens(db, actor),
        R::Members => members::list(db),
        R::SetVisibility => visibility::set(db, c, actor),
        R::Rename => visibility::rename(db, c, actor, settings),
        R::MemberPut => members::put(db, c, actor, settings),
        R::AccountClosed => deletion::account_closed(db, c, settings),
        R::MemberRemove => members::remove(db, c, actor, settings),
    }
}
