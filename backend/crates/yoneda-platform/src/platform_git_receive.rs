//! The receiving side of a stock `git push` over HTTPS, as Worker compute: the request
//! streams in (command list, then the pack, resolved as it arrives), verification asks the
//! adapter for what only the repository holds, and the verified objects stream out for the
//! adapter to store. Nothing here moves a ref: the adapter records the commits and then
//! applies the ref updates through the authority's compare-and-swap paths, with each
//! command's old id as the expected-old lease (`git_land` takes none; see `repo_store::land`).
use crate::platform_git_verify::{Step, Verifier};
use crate::platform_objects::supplied_tree;
use crate::secret_scan::StreamScan;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{AnnotatedTag, ObjectId, ObjectKind, PackLimits, PackReader, Spill},
    transport::{CommandList, RefCommand, command_list},
};

/// Pack bytes a push may hold here at once (files over SPILL_BYTES are not held); larger
/// pushes go through `git-remote-yoneda`, which uploads commit by commit.
pub const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
/// Files over this are spilled: handed to the adapter as they inflate, stored as their
/// own R2 objects, never held whole in this isolate's memory.
pub const SPILL_BYTES: usize = 8 * 1024 * 1024;
/// GitHub's per-file block; it warns over 50 MiB (the adapter does too).
pub const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 1024 * 1024;
/// Pushes of more objects than the adapter stages in its authority (STAGE_OBJECTS in
/// repo-git-receive.ts) keep their commits and trees out of their files' bundles.
const SPLIT_OBJECTS: usize = 256;
pub const LIMITS: PackLimits = PackLimits {
    max_objects: 40_000,
    max_object_bytes: MAX_FILE_BYTES,
    max_total_bytes: 2 * 1024 * 1024 * 1024,
    spill_blob_bytes: SPILL_BYTES,
};

pub struct ReceiveSession {
    head: Vec<u8>,
    commands: Option<Vec<RefCommand>>,
    capabilities: Vec<String>,
    /// The read set the push options declare (validated as they arrive).
    reads: Vec<String>,
    pack: Option<PackReader>,
    verifier: Verifier,
    /// Verified objects to store, in bundle order, and how many were handed out.
    writes: Vec<(ObjectId, ObjectKind)>,
    written: usize,
    /// The spilled file streaming out now, scanned for credentials as it goes.
    scanning: Option<StreamScan>,
}

impl Default for ReceiveSession {
    fn default() -> Self {
        Self::new()
    }
}

impl ReceiveSession {
    pub fn new() -> Self {
        Self {
            head: Vec::new(),
            commands: None,
            capabilities: Vec::new(),
            reads: Vec::new(),
            pack: None,
            verifier: Verifier::default(),
            writes: Vec::new(),
            written: 0,
            scanning: None,
        }
    }

    /// Spilled files' content since the last call, framed: 1 and an 8-byte size (a file
    /// begins), 2 and a 4-byte length and bytes, 3 and the 20-byte id (it ends, verified).
    pub fn spilled(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for event in self
            .pack
            .as_mut()
            .map(PackReader::take_spilled)
            .into_iter()
            .flatten()
        {
            match event {
                Spill::Begin { size } => {
                    self.scanning = Some(StreamScan::default());
                    out.push(1);
                    out.extend_from_slice(&(size as u64).to_be_bytes());
                }
                Spill::Data(bytes) => {
                    if let Some(scan) = self.scanning.as_mut() {
                        scan.feed(&bytes);
                    }
                    out.push(2);
                    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
                    out.extend_from_slice(&bytes);
                }
                Spill::End { id } => {
                    let hits = self.scanning.take().map(StreamScan::finish);
                    self.verifier.streamed.insert(id, hits.unwrap_or_default());
                    out.push(3);
                    out.extend_from_slice(id.as_bytes());
                }
            }
        }
        out
    }

    /// Whether the pack waits for spilled content to be taken (then feed an empty chunk).
    pub fn paused(&self) -> bool {
        self.pack.as_ref().is_some_and(PackReader::paused)
    }

    /// Request bytes this session holds.
    pub fn buffered(&self) -> usize {
        self.head.len() + self.pack.as_ref().map_or(0, PackReader::received)
    }

    /// The next chunk of the request body.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<()> {
        if let Some(pack) = self.pack.as_mut() {
            return pack.feed(chunk);
        }
        if self.commands.is_some() {
            return if chunk.is_empty() {
                Ok(())
            } else {
                Err(bad("A push that only deletes carries no pack"))
            };
        }
        self.head.extend_from_slice(chunk);
        if self.head.len() > MAX_COMMAND_BYTES {
            return Err(bad("The push's command list is too long"));
        }
        let Some(CommandList {
            commands,
            capabilities,
            push_options,
            used,
        }) = command_list(&self.head)?
        else {
            return Ok(());
        };
        self.reads = crate::platform_push_reads::from_push_options(&push_options)?;
        let rest = self.head.split_off(used);
        self.head = Vec::new();
        // Only a push that creates or moves a ref sends a pack.
        if commands.iter().any(|c| c.new.is_some()) {
            let mut pack = PackReader::new(LIMITS, MAX_PACK_BYTES);
            pack.feed(&rest)?;
            self.pack = Some(pack);
        } else if !rest.is_empty() {
            return Err(bad("A push that only deletes carries no pack"));
        }
        self.commands = Some(commands);
        self.capabilities = capabilities;
        Ok(())
    }

    /// The commands parsed so far (each marked when its ref is protected, and once the pack
    /// is read, when its new value is an annotated tag object: `tag` holds the tagged
    /// commit and the object's bytes, or `tag_error` why the object is refused), the
    /// capabilities the client asked for and the read set its push options declare; none
    /// before the command list is complete.
    pub fn commands(&mut self) -> Value {
        let mut listed = Vec::new();
        for c in self.commands.iter().flatten() {
            let mut command = json!({ "ref": c.refname, "old": c.old, "new": c.new,
                    "protected": crate::repo_store::protected_ref(&c.refname),
                    "annotated": false });
            if let Some(pack) = self.pack.as_mut()
                && let Some(id) = c.new.filter(|id| pack.kind(id) == Some(ObjectKind::Tag))
            {
                command["annotated"] = json!(true);
                match pack.content(&id).and_then(|data| {
                    let tag = AnnotatedTag::decode(&data)?;
                    Ok(json!({ "commit": tag.object, "data_b64": STANDARD.encode(data.as_slice()) }))
                }) {
                    Ok(tag) => command["tag"] = tag,
                    Err(e) => command["tag_error"] = json!(format!("{}: {}", e.code, e.message)),
                }
            }
            listed.push(command);
        }
        json!({ "commands": listed, "capabilities": self.capabilities, "reads": self.reads })
    }

    /// Once the body has ended: `commands`, with the pack checked whole. An empty command
    /// list is Git's probe request.
    pub fn finish(&mut self) -> Result<Value> {
        if self.commands.is_none() {
            return Err(bad("The push's command list is truncated"));
        }
        if let Some(pack) = self.pack.as_mut() {
            pack.finish()?;
        }
        Ok(self.commands())
    }

    /// One verification round. `input` adds what the adapter fetched since the last
    /// (`commits: {id: tree}`, `trees: [{id, data_b64} | {id, entries}]`, `present: [id]`,
    /// and once the policy's `secret_allow`) to verify `tips`; answers `{need: ...}` or the
    /// verified commits to record. A carried file holding a credential refuses the push.
    pub fn verify(&mut self, input: &Value) -> Result<Value> {
        for (id, tree) in input["commits"].as_object().into_iter().flatten() {
            let tree = ObjectId::parse(tree.as_str().unwrap_or_default())?;
            self.verifier.add_commit(ObjectId::parse(id)?, tree);
        }
        for tree in input["trees"].as_array().into_iter().flatten() {
            let id = ObjectId::parse(&string(tree, "id")?)?;
            self.verifier.add_tree(id, supplied_tree(&id, tree)?);
        }
        if let Some(allow) = input.get("secret_allow").filter(|a| !a.is_null()) {
            self.verifier.secret_allow = serde_json::from_value(allow.clone())
                .map_err(|_| bad("secret_allow must list {path, rule}"))?;
        }
        for id in input["present"].as_array().into_iter().flatten() {
            self.verifier
                .add_present(ObjectId::parse(id.as_str().unwrap_or_default())?);
        }
        let tips = input["tips"]
            .as_array()
            .ok_or_else(|| bad("tips must be a list"))?
            .iter()
            .map(|t| ObjectId::parse(t.as_str().unwrap_or_default()))
            .collect::<Result<Vec<_>>>()?;
        let Some(pack) = self.pack.as_mut() else {
            return Ok(json!({ "commits": [] }));
        };
        match self.verifier.verify(pack, &tips)? {
            Step::Need(need) => Ok(json!({ "need": need })),
            Step::Done(verified) => {
                self.writes = verified.iter().flat_map(|v| v.objects.clone()).collect();
                // Commits, then trees, then files: a clone's walk reads every commit, then
                // trees a directory level per round, so those sit together in the first
                // bundles and not one ranged read apart between the files.
                self.writes.sort_by_key(|(_, kind)| match kind {
                    ObjectKind::Commit => 0,
                    ObjectKind::Tree => 1,
                    _ => 2,
                });
                self.written = 0;
                let mut commits = Vec::with_capacity(verified.len());
                for v in verified {
                    let data = pack.content(&v.commit)?;
                    let objects: Vec<Value> = v
                        .objects
                        .iter()
                        .map(|(id, kind)| json!({ "id": id, "kind": kind.name() }))
                        .collect();
                    commits.push(json!({
                        "commit": v.commit, "data_b64": STANDARD.encode(data.as_slice()),
                        "touches": v.touches, "objects": objects,
                    }));
                }
                Ok(json!({ "commits": commits, "objects": self.writes.len() }))
            }
        }
    }

    /// The next verified objects to store, up to about `budget` bytes, each framed as
    /// kind (1: commit, 2: tree, 3: blob), 20-byte id, 4-byte big-endian length, content.
    /// Empty once every object has been handed out.
    pub fn next_objects(&mut self, budget: usize) -> Result<Vec<u8>> {
        let Some(pack) = self.pack.as_mut() else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        // A large push's commits and trees end their batch before its first file, so they
        // fill bundles of their own: a walk or a partial clone never reads across files.
        let split = self.writes.len() > SPLIT_OBJECTS;
        let mut last = None;
        while let Some((id, kind)) = self.writes.get(self.written).copied() {
            let files_start = split && kind == ObjectKind::Blob && last.is_some_and(|k| k != kind);
            if !out.is_empty() && (out.len() >= budget || files_start) {
                break;
            }
            // Spilled files went to the adapter as they arrived.
            if pack.spilled(&id) {
                self.written += 1;
                continue;
            }
            last = Some(kind);
            let data = pack.content(&id)?;
            let length = u32::try_from(data.len()).map_err(|_| bad("Object is too large"))?;
            out.push(match kind {
                ObjectKind::Commit => 1,
                ObjectKind::Tree => 2,
                _ => 3,
            });
            out.extend_from_slice(id.as_bytes());
            out.extend_from_slice(&length.to_be_bytes());
            out.extend_from_slice(&data);
            self.written += 1;
        }
        Ok(out)
    }
}
