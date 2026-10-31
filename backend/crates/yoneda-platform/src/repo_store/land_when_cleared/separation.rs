//! Separation: a Landing waits while one ahead of it in the queue (`traffic::Queue`) touches the
//! same files with a read conflict, one having written what the other read. Holding here only
//! keeps them in order: whichever lands first, landing's own rules then judge the other, and
//! the job is asked again when the way clears (`triggers`). Explicit landings never come here.
use crate::platform_ctc::Ahead;
use crate::repo_store::traffic::{self, Queue, Seed};
use crate::storage::SqlStore;
use serde_json::Value;
use yoneda_core::{Result, git_object::ObjectId};

/// Landings ahead looked at, nearest the front first.
const AHEAD: usize = 8;
/// Paths named per Landing ahead.
const PATHS: usize = 3;

/// The Landings ahead that `head`, of `change` on `refname`, has a read conflict with.
pub(super) fn ahead<S: SqlStore>(
    db: &S,
    queue: &Queue,
    change: &Value,
    head: &ObjectId,
    refname: &str,
) -> Result<Vec<Ahead>> {
    let number = change["number"].as_i64().unwrap_or_default();
    let front = queue.ahead_of(number, refname);
    if front.is_empty() {
        return Ok(Vec::new());
    }
    let seed = |landing, head: &str| Seed {
        landing,
        head: head.to_owned(),
        base: refname.to_owned(),
    };
    let places = || front.iter().take(AHEAD);
    let mut seeds: Vec<Seed> = places().map(|p| seed(p.number, &p.head)).collect();
    seeds.push(seed(number, &head.hex()));
    let prints = traffic::read(db, &seeds, None)?;
    let Some(mine) = prints.get(&number) else {
        return Ok(Vec::new());
    };
    Ok(places()
        .filter_map(|place| {
            let paths = prints.get(&place.number)?.read_conflict(mine);
            (!paths.is_empty()).then(|| Ahead {
                landing: place.number,
                paths: paths.into_iter().take(PATHS).collect(),
            })
        })
        .collect())
}
