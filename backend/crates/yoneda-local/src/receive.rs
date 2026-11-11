//! `git push` (receive-pack), as `cloudflare/worker/repo-git-receive.ts` runs it, on the
//! same Rust session: the pack is parsed and verified (asking the repository for what it
//! does not carry, scanning files for credentials), the verified objects go into the
//! store, the new commits are recorded under their own ids, and only then do refs move
//! (`moves`). A push that fails before that leaves every ref and the log as they were.
use crate::authority::Cred;
use crate::moves::{self, Command, Outcomes};
use crate::service::Service;
use crate::timing::{Clock, Phases, wall_ms};
use crate::{outbox, pause, project, verify};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, write_pack},
};
use yoneda_platform::platform_git_receive::ReceiveSession;

const FEED_BYTES: usize = 1024 * 1024;
const WRITE_BUDGET: usize = 4 * 1024 * 1024;
const RECORD_COMMITS: usize = 100;
const VERIFIED_PAGE: usize = 25;

/// Answers a receive-pack request body with Git's report (empty for Git's probe).
pub fn receive(svc: &Service, cred: &Cred, body: &[u8]) -> Result<Vec<u8>> {
    let clock = Clock::start();
    let start_ms = wall_ms();
    let access = svc.authority.call(
        cred,
        json!({ "op": "repo_git_access", "service": "git-receive-pack" }),
    )?;
    let actor = access["principal"].as_str().unwrap_or_default();
    let mut session = ReceiveSession::new();
    let mut failure = unpack(svc, &mut session, body)
        .err()
        .map(|e| moves::reason(&e));
    if failure.is_none() {
        failure = session.finish().err().map(|e| moves::reason(&e));
    }
    let listed = session.commands();
    let mut commands: Vec<Command> = serde_json::from_value(listed["commands"].clone())
        .map_err(|_| Error::new("INVALID_INPUT", "Unreadable push commands"))?;
    // The clone's integration branch uses the same transactional landing path as main.
    for command in &mut commands {
        command.protected |= command.refname == svc.config.refname();
    }
    if failure.is_none() && commands.is_empty() {
        return Ok(Vec::new());
    }
    let caps: Vec<String> =
        serde_json::from_value(listed["capabilities"].clone()).unwrap_or_default();
    let side_band = caps
        .iter()
        .any(|c| c == "side-band-64k" || c == "side-band");
    let reads: Vec<String> = serde_json::from_value(listed["reads"].clone()).unwrap_or_default();
    let mut outcomes: Outcomes = commands.iter().map(|c| (c.refname.clone(), None)).collect();
    let mut messages = Vec::new();
    if let Some(why) = failure {
        for c in &commands {
            outcomes.insert(c.refname.clone(), Some(why.clone()));
        }
        svc.activity.record(actor, &commands, &outcomes, start_ms);
        return report(&commands, &outcomes, Some(&why), side_band, &messages);
    }
    let atomic = caps.iter().any(|c| c == "atomic") && commands.len() > 1;
    for c in &commands {
        outcomes.insert(c.refname.clone(), moves::refusal(c, atomic));
    }
    if atomic && outcomes.values().any(Option::is_some) {
        for why in outcomes.values_mut() {
            why.get_or_insert_with(|| "atomic push refused".into());
        }
    }
    let going: Vec<&Command> = commands
        .iter()
        .filter(|c| outcomes[&c.refname].is_none())
        .collect();
    let tips: Vec<String> = going.iter().filter_map(|c| c.target()).collect();
    let mut fresh = HashSet::new();
    let stored = Clock::start();
    if !tips.is_empty() {
        match store(svc, cred, &mut session, &tips, &access, &reads, &going) {
            Ok(recorded) => fresh = recorded,
            Err(e) => {
                let why = moves::reason(&e);
                for c in &going {
                    outcomes.insert(c.refname.clone(), Some(why.clone()));
                }
                let unpack = (e.code != "SECRET_DETECTED").then_some(why.as_str());
                svc.activity.record(actor, &commands, &outcomes, start_ms);
                return report(&commands, &outcomes, unpack, side_band, &messages);
            }
        }
    }
    let store_ms = stored.ms();
    pause::point("after_record");
    let mut phases: HashMap<String, Phases> = HashMap::new();
    if atomic {
        let moving = Clock::start();
        moves::move_all(svc, cred, &going, &mut outcomes, &mut messages);
        for c in &going {
            phases
                .entry(c.refname.clone())
                .or_default()
                .add("land", moving.ms());
        }
    } else {
        for c in &going {
            let moving = Clock::start();
            let mut p = Phases::default();
            let why = moves::move_one(svc, cred, c, &fresh, &mut messages, &mut p);
            p.add("land", moving.ms());
            phases.insert(c.refname.clone(), p);
            outcomes.insert(c.refname.clone(), why);
        }
    }
    pause::point("after_land");
    let projecting = Clock::start();
    // The platform's merge commits are staged in the authority: into the store first, so
    // the refs below can move to them.
    if let Err(e) = outbox::drain(svc) {
        eprintln!(
            "yoneda-local: staged objects not written yet: {}",
            moves::reason(&e)
        );
    }
    if let Err(e) = project::project(svc) {
        eprintln!(
            "yoneda-local: refs not projected yet: {}",
            moves::reason(&e)
        );
    }
    let project_ms = projecting.ms();
    svc.activity.record(actor, &commands, &outcomes, start_ms);
    let answer = report(&commands, &outcomes, None, side_band, &messages);
    if svc.timings.on() {
        let lines: Vec<Value> = commands
            .iter()
            .map(|c| {
                let p = phases.remove(&c.refname).unwrap_or_default();
                let outcome = match (&outcomes[&c.refname], p.merged) {
                    (Some(_), _) => "refused",
                    (None, true) => "merged",
                    (None, false) => "landed",
                };
                let mut ms = p.ms;
                ms.insert("store".into(), json!(store_ms));
                ms.insert("project".into(), json!(project_ms));
                ms.insert("total".into(), json!(clock.ms()));
                json!({ "ref": c.refname, "outcome": outcome, "start_ms": start_ms, "ms": ms })
            })
            .collect();
        svc.timings.write(&lines);
    }
    answer
}

/// Feeds the body to the session, storing each file it spills (over 8 MiB) as it ends.
fn unpack(svc: &Service, session: &mut ReceiveSession, body: &[u8]) -> Result<()> {
    let mut file = Vec::new();
    for chunk in body.chunks(FEED_BYTES) {
        session.feed(chunk)?;
        loop {
            take_spilled(svc, &session.spilled(), &mut file)?;
            if !session.paused() {
                break;
            }
            session.feed(&[])?;
        }
    }
    Ok(())
}

/// Spill frames: 1 and an 8-byte size (a file begins), 2, a 4-byte length and bytes, 3 and
/// the 20-byte id (it ends, verified).
fn take_spilled(svc: &Service, frames: &[u8], file: &mut Vec<u8>) -> Result<()> {
    let bad = || Error::new("INVALID_INPUT", "Malformed spill frames");
    let mut at = 0;
    while at < frames.len() {
        match frames[at] {
            1 => {
                file.clear();
                at += 9;
            }
            2 => {
                let len = frames.get(at + 1..at + 5).ok_or_else(bad)?;
                let len = u32::from_be_bytes([len[0], len[1], len[2], len[3]]) as usize;
                file.extend_from_slice(frames.get(at + 5..at + 5 + len).ok_or_else(bad)?);
                at += 5 + len;
            }
            3 => {
                let id = ObjectId::parse(&hex(frames.get(at + 1..at + 21).ok_or_else(bad)?))?;
                if svc.store.write(ObjectKind::Blob, file)? != id {
                    return Err(bad());
                }
                file.clear();
                at += 21;
            }
            _ => return Err(bad()),
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Verifies the pack, stores its objects and records the new commits (parents first),
/// each tip with the push's declared reads. Answers the recorded commits.
fn store(
    svc: &Service,
    cred: &Cred,
    session: &mut ReceiveSession,
    tips: &[String],
    access: &Value,
    reads: &[String],
    going: &[&Command],
) -> Result<HashSet<String>> {
    let verified = verify::run(svc, cred, session, tips, access)?;
    let mut objects = Vec::new();
    loop {
        let frames = session.next_objects(WRITE_BUDGET)?;
        if frames.is_empty() {
            break;
        }
        objects.extend(verify::framed(&frames)?);
    }
    if !objects.is_empty() {
        let listed: Vec<(ObjectKind, &[u8])> =
            objects.iter().map(|(k, d)| (*k, d.as_slice())).collect();
        svc.store.index_pack(&write_pack(&listed)?)?;
    }
    for c in going {
        if let Some(tag) = c.tag.as_ref() {
            let data = STANDARD
                .decode(tag["data_b64"].as_str().unwrap_or_default())
                .map_err(|_| Error::new("INVALID_INPUT", "Unreadable tag object"))?;
            svc.store.write(ObjectKind::Tag, &data)?;
        }
    }
    let total = verified["verified"].as_u64().unwrap_or(0) as usize;
    let mut fresh = HashSet::new();
    for start in (0..total).step_by(RECORD_COMMITS) {
        let mut commits = Vec::new();
        for at in (start..total.min(start + RECORD_COMMITS)).step_by(VERIFIED_PAGE) {
            let page = session.verified_page(at, VERIFIED_PAGE)?;
            commits.extend(page["commits"].as_array().cloned().unwrap_or_default());
        }
        for c in &mut commits {
            let id = c["commit"].as_str().unwrap_or_default().to_owned();
            let tip = tips.contains(&id);
            c["check"] = json!(tip);
            if tip && !reads.is_empty() {
                c["read_set"] = json!(reads);
            }
            fresh.insert(id);
        }
        svc.authority.call(
            cred,
            json!({ "op": "repo_record_pushed", "commits": commits }),
        )?;
    }
    Ok(fresh)
}

fn report(
    commands: &[Command],
    outcomes: &Outcomes,
    unpack: Option<&str>,
    side_band: bool,
    messages: &[String],
) -> Result<Vec<u8>> {
    let refs: Vec<Value> = commands
        .iter()
        .map(
            |c| json!({ "ref": c.refname, "refused": outcomes.get(&c.refname).cloned().flatten() }),
        )
        .collect();
    let answer = yoneda_platform::platform_compute(json!({
        "op": "git_report", "unpack": unpack, "refs": refs, "side_band": side_band, "messages": messages,
    }))?;
    STANDARD
        .decode(answer["body_b64"].as_str().unwrap_or_default())
        .map_err(|_| Error::new("LOCAL", "Unreadable push report"))
}
