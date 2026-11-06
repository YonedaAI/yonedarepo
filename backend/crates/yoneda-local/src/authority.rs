//! The repository authority: the platform's engine (`execute_migrated`) on a native SQLite
//! file, owned by one thread (the store handle is not `Send`). Every command runs in its
//! own transaction, as in the Durable Object; this host only adds what the Worker's
//! authenticating adapter adds there: the time, the credentials and the legal-hold answer.
use crate::layout::local_error;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use yoneda_core::Result;
use yoneda_store::{SqlStore, native::NativeStore};

/// Who a command runs as.
#[derive(Clone, Debug)]
pub enum Cred {
    /// A repository token (`_token`), as a caller presented it.
    Token(String),
    /// A platform role (`_system`): the merger, the projector.
    System(&'static str),
    /// The repository's owner, which only `init` uses.
    Owner,
}

/// The workspace and owner every local repository has.
pub const WORKSPACE: &str = "local";
pub const OWNER: &str = "user:local";

impl Cred {
    fn apply(&self, c: &mut Value) {
        match self {
            Self::Token(secret) => c["_token"] = json!(secret),
            Self::System(role) => c["_system"] = json!(role),
            Self::Owner => {
                c["_session"] =
                    json!({ "workspace": WORKSPACE, "principal": OWNER, "human": true });
            }
        }
    }
}

type Job = (Value, mpsc::Sender<Result<Value>>);

#[derive(Clone)]
pub struct Authority {
    jobs: Arc<Mutex<mpsc::Sender<Job>>>,
    clock: Arc<AtomicI64>,
}

impl Authority {
    /// Opens (creating and migrating) the authority at `path` on its own thread.
    pub fn open(path: &Path) -> Result<Self> {
        let (jobs, inbox) = mpsc::channel::<Job>();
        let (ready, opened) = mpsc::channel::<Result<()>>();
        let path = path.to_owned();
        std::thread::Builder::new()
            .name("authority".into())
            .spawn(move || {
                let db = match open_store(&path) {
                    Ok(db) => {
                        let _ = ready.send(Ok(()));
                        db
                    }
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                for (command, reply) in inbox {
                    let _ = reply.send(yoneda_platform::execute_migrated(&db, command));
                }
            })
            .map_err(|e| local_error(format!("Cannot start the authority: {e}")))?;
        opened
            .recv()
            .map_err(|_| local_error("The authority stopped while opening"))??;
        Ok(Self {
            jobs: Arc::new(Mutex::new(jobs)),
            clock: Arc::new(AtomicI64::new(0)),
        })
    }

    /// Runs `command` as `cred`, in one transaction.
    pub fn call(&self, cred: &Cred, mut command: Value) -> Result<Value> {
        command["now"] = json!(self.now());
        command["_hold"] = json!("off");
        cred.apply(&mut command);
        let (reply, answer) = mpsc::channel();
        self.jobs
            .lock()
            .map_err(|_| local_error("The authority is unavailable"))?
            .send((command, reply))
            .map_err(|_| local_error("The authority stopped"))?;
        answer
            .recv()
            .map_err(|_| local_error("The authority stopped"))?
    }

    /// Wall-clock milliseconds, never repeating or going back.
    fn now(&self) -> i64 {
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
        let mut last = self.clock.load(Ordering::SeqCst);
        loop {
            let next = wall.max(last + 1);
            match self
                .clock
                .compare_exchange(last, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return next,
                Err(seen) => last = seen,
            }
        }
    }
}

/// WAL with full fsync: an acknowledged command survives power loss; a reader in another
/// process (`status`) waits for the writer instead of failing.
fn open_store(path: &Path) -> Result<NativeStore> {
    let db = NativeStore::open(path)?;
    for pragma in [
        "PRAGMA journal_mode=WAL",
        "PRAGMA synchronous=FULL",
        "PRAGMA busy_timeout=10000",
    ] {
        db.query(pragma, &[])?;
    }
    yoneda_platform::migrate_repo_store(&db)?;
    Ok(db)
}
