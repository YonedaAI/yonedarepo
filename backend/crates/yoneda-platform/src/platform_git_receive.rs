//! The receiving side of a stock `git push` over HTTPS, as Worker compute: the request
//! streams in (command list, then the pack, resolved as it arrives), verification asks the
//! adapter for what only the repository holds, and the verified objects stream out for the
//! adapter to store. Nothing here moves a ref: the adapter records the commits and then
//! applies the ref updates through the authority's compare-and-swap paths.
use crate::platform_git_verify::{Step, Verifier};
use crate::platform_objects::supplied_tree;
use crate::storage::{bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{
        CommandList, ObjectId, ObjectKind, PackLimits, PackReader, RefCommand, command_list,
    },
};

/// Larger pushes go through `git-remote-yoneda`, which uploads commit by commit.
pub const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 1024 * 1024;
pub const LIMITS: PackLimits = PackLimits {
    max_objects: 40_000,
    max_object_bytes: 16 * 1024 * 1024,
    max_total_bytes: 512 * 1024 * 1024,
};

pub struct ReceiveSession {
    head: Vec<u8>,
    commands: Option<Vec<RefCommand>>,
    capabilities: Vec<String>,
    /// The read set the push options declare (validated as they arrive).
    reads: Vec<String>,
    pack: Option<PackReader>,
    verifier: Verifier,
    /// Verified objects to store, in order, and how many were handed out.
    writes: Vec<(ObjectId, ObjectKind)>,
    written: usize,
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
        }
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
    /// is read, when its new value is an annotated tag object), the capabilities the
    /// client asked for and the read set its push options declare; none before the
    /// command list is complete.
    pub fn commands(&self) -> Value {
        let annotated = |id: &Option<ObjectId>| {
            id.and_then(|id| self.pack.as_ref()?.kind(&id)) == Some(ObjectKind::Tag)
        };
        let listed: Vec<Value> = self
            .commands
            .iter()
            .flatten()
            .map(|c| {
                json!({ "ref": c.refname, "old": c.old, "new": c.new,
                        "protected": crate::repo_store::protected_ref(&c.refname),
                        "annotated": annotated(&c.new) })
            })
            .collect();
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
        while let Some((id, kind)) = self.writes.get(self.written).copied() {
            if !out.is_empty() && out.len() >= budget {
                break;
            }
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
