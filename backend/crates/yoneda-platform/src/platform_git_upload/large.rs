//! Files too large to hold (repo-large-files.ts) in a fetch's pack: the adapter streams
//! each one's content from R2 and its zlib stream into the pack; the session writes the
//! entry header, hashes the content (checked against the id) and the bytes written (for
//! the trailer). Such a file is sent whole and is never a delta base.
use super::UploadSession;
use crate::storage::bad;
use yoneda_core::{
    Error, Result,
    git_object::{ObjectHasher, ObjectId, ObjectKind},
};

impl UploadSession {
    /// Starts a file too large to hold, whole: its entry header. The adapter streams its
    /// content (`large_data`: the content, for its id, and the zlib stream it wrote) and
    /// ends it (`large_end`). It is never a delta base.
    pub fn large_start(&mut self, id: &str, size: usize) -> Result<Vec<u8>> {
        if self.large.is_some() {
            return Err(bad("A streamed file is already open"));
        }
        let id = ObjectId::parse(id)?;
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| bad("The pack has not started"))?;
        let header = writer.entry_start(ObjectKind::Blob, size);
        self.large = Some((id, ObjectHasher::new(ObjectKind::Blob, size)));
        Ok(header)
    }

    /// The streamed file's `content` seen so far, and the `packed` bytes written for it.
    pub fn large_data(&mut self, content: &[u8], packed: &[u8]) -> Result<()> {
        let (_, hasher) = self
            .large
            .as_mut()
            .ok_or_else(|| bad("No streamed file is open"))?;
        hasher.update(content);
        self.writer
            .as_mut()
            .ok_or_else(|| bad("The pack has not started"))?
            .raw(packed);
        Ok(())
    }

    /// Ends the streamed file: its content must have hashed to its id.
    pub fn large_end(&mut self) -> Result<()> {
        let (id, hasher) = self
            .large
            .take()
            .ok_or_else(|| bad("No streamed file is open"))?;
        if hasher.finish()? != id {
            return Err(Error::new(
                "GIT_OBJECT_INVALID",
                format!("Stored blob does not hash to {id}"),
            ));
        }
        let partners = self.partners.get(&id).cloned().unwrap_or_default();
        self.wrote(id, &partners);
        Ok(())
    }
}
