//! Down: cloud `main` onto local `main`. The cloud's head is fetched into the store and
//! pushed to the authority through the same receive path every push takes, as sync's own
//! principal: a fast-forward when local `main` is its ancestor, otherwise the platform's
//! merge, and a conflict leaves local `main` as it was (`diverged`).
use super::state::{State, Sync};
use super::{Ctx, classify, local_main};
use crate::cloud;
use crate::receive;
use yoneda_core::{Result, git_object::ObjectId, transport::receive_pack_request};

/// Lands cloud `main` locally when it holds anything local `main` lacks. Answers whether
/// local `main` moved.
pub fn down(ctx: &Ctx, sync: &mut Sync) -> Result<bool> {
    let Some(head) = cloud_main(ctx, sync)? else {
        return Ok(false);
    };
    let local = local_main(ctx.svc)?;
    if local == Some(head) {
        return Ok(false);
    }
    if !ctx.svc.store.has(&head) && !fetch(ctx, sync)? {
        return Ok(false);
    }
    if local.is_some_and(|l| ctx.svc.store.is_ancestor(&head, &l)) {
        return Ok(false);
    }
    let mut want = format!("{head}\n");
    if let Some(l) = local {
        want.push_str(&format!("^{l}\n"));
    }
    let pack = ctx.svc.store.git(
        &["pack-objects", "--revs", "--stdout", "-q"],
        Some(want.as_bytes()),
    )?;
    let body = receive_pack_request("refs/heads/main", local, head, &pack)?;
    let report = receive::receive(ctx.svc, &ctx.cred, &body)?;
    let text = String::from_utf8_lossy(&report);
    if text.contains("ok refs/heads/main") {
        return Ok(true);
    }
    let why = text
        .lines()
        .find_map(|l| l.split_once("ng refs/heads/main ").map(|(_, w)| w.trim()))
        .unwrap_or("refused");
    sync.note(
        State::Diverged,
        format!("cloud main {head} does not land locally: {why}"),
    );
    Ok(false)
}

/// Cloud `main` (`None` for an empty repository), noted in `sync`.
pub fn cloud_main(ctx: &Ctx, sync: &mut Sync) -> Result<Option<ObjectId>> {
    let url = ctx.cloud.git_url();
    let out = cloud::git(
        &ctx.layout.store(),
        &ctx.cloud.origin,
        &["ls-remote", &url, "refs/heads/main"],
    )?;
    if !out.status.success() {
        let (state, why) = classify(&out);
        sync.note(state, why);
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let head = match text.split_whitespace().next() {
        Some(id) => Some(ObjectId::parse(id)?),
        None => None,
    };
    sync.cloud_main = head.map(|h| h.to_string());
    Ok(head)
}

fn fetch(ctx: &Ctx, sync: &mut Sync) -> Result<bool> {
    let url = ctx.cloud.git_url();
    let out = cloud::git(
        &ctx.layout.store(),
        &ctx.cloud.origin,
        &["fetch", "--no-tags", "-q", &url, "refs/heads/main"],
    )?;
    if !out.status.success() {
        let (state, why) = classify(&out);
        sync.note(state, why);
    }
    Ok(out.status.success())
}
