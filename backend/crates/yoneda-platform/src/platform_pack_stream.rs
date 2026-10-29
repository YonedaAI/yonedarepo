//! A pack written piece by piece by the adapter, for pushes whose files are too large to
//! hold (the Artifacts projection of a large file): whole small objects are compressed
//! here; a large file's zlib stream is written by the adapter from its R2 body, its content
//! hashed here (checked against its id) and its bytes hashed into the trailer.
use yoneda_core::{
    Error, Result,
    git_object::{ObjectHasher, ObjectId, ObjectKind, PackWriter},
};

pub struct PackStream {
    writer: PackWriter,
    header: Option<Vec<u8>>,
    large: Option<(ObjectId, ObjectHasher)>,
}

impl PackStream {
    /// A pack of `count` objects.
    pub fn new(count: u32) -> Self {
        let (writer, header) = PackWriter::new(count);
        Self {
            writer,
            header: Some(header),
            large: None,
        }
    }

    /// The pack header, once.
    pub fn header(&mut self) -> Vec<u8> {
        self.header.take().unwrap_or_default()
    }

    /// A whole object of `kind` (`commit`, `tree` or `blob`).
    pub fn entry(&mut self, kind: &str, data: &[u8]) -> Result<Vec<u8>> {
        let kind = match kind {
            "commit" => ObjectKind::Commit,
            "tree" => ObjectKind::Tree,
            "blob" => ObjectKind::Blob,
            _ => {
                return Err(Error::new(
                    "INVALID_INPUT",
                    "kind must be commit, tree or blob",
                ));
            }
        };
        Ok(self.writer.entry(kind, data))
    }

    /// Starts a file the adapter streams: its entry header.
    pub fn large_start(&mut self, id: &str, size: usize) -> Result<Vec<u8>> {
        let id = ObjectId::parse(id)?;
        self.large = Some((id, ObjectHasher::new(ObjectKind::Blob, size)));
        Ok(self.writer.entry_start(ObjectKind::Blob, size))
    }

    /// The streamed file's `content` seen so far, and the `packed` bytes written for it.
    pub fn large_data(&mut self, content: &[u8], packed: &[u8]) -> Result<()> {
        let (_, hasher) = self
            .large
            .as_mut()
            .ok_or_else(|| Error::new("INVALID_INPUT", "No streamed file is open"))?;
        hasher.update(content);
        self.writer.raw(packed);
        Ok(())
    }

    /// Ends the streamed file: its content must have hashed to its id.
    pub fn large_end(&mut self) -> Result<()> {
        let (id, hasher) = self
            .large
            .take()
            .ok_or_else(|| Error::new("INVALID_INPUT", "No streamed file is open"))?;
        if hasher.finish()? != id {
            return Err(Error::new(
                "GIT_OBJECT_INVALID",
                format!("Stored blob does not hash to {id}"),
            ));
        }
        Ok(())
    }

    /// The trailer; the stream is spent.
    pub fn finish(self) -> Vec<u8> {
        self.writer.finish().to_vec()
    }
}
