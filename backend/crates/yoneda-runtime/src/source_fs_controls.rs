//! FUSE callbacks grouped by responsibility within one trait implementation.
macro_rules! callbacks {
    () => {
        fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> io::Result<()> {
            config
                .add_capabilities(InitFlags::FUSE_AUTO_INVAL_DATA)
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::Unsupported,
                        "FUSE data invalidation unavailable",
                    )
                })?;
            config
                .set_max_write(SOURCE_READ_MAX as u32)
                .map_err(|_| io::Error::other("FUSE write limit unavailable"))?;
            // WRITEBACK_CACHE is never requested; acknowledgment follows server commit.
            // Directory enumeration never starts content hydration.
            Ok(())
        }
        fn flush(
            &self,
            _req: &Request,
            _ino: INodeNo,
            fh: FileHandle,
            _owner: LockOwner,
            reply: ReplyEmpty,
        ) {
            match self
                .state
                .handle(fh)
                .and_then(|handle| self.state.source.stat(&handle.path))
            {
                Ok(_) => reply.ok(),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn fsync(
            &self,
            _req: &Request,
            _ino: INodeNo,
            fh: FileHandle,
            _datasync: bool,
            reply: ReplyEmpty,
        ) {
            match self
                .state
                .handle(fh)
                .and_then(|handle| self.state.source.stat(&handle.path))
            {
                Ok(_) => reply.ok(),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn release(
            &self,
            _req: &Request,
            _ino: INodeNo,
            fh: FileHandle,
            _flags: OpenFlags,
            _owner: Option<LockOwner>,
            _flush: bool,
            reply: ReplyEmpty,
        ) {
            match self.state.handles.lock() {
                Ok(mut handles) => {
                    handles.remove(&fh);
                    reply.ok();
                }
                Err(_) => reply.error(Errno::EIO),
            }
        }
        fn mkdir(
            &self,
            _req: &Request,
            parent: INodeNo,
            name: &OsStr,
            _mode: u32,
            _umask: u32,
            reply: ReplyEntry,
        ) {
            match self
                .state
                .child(parent, name)
                .and_then(|path| self.state.directories.mkdir(&path))
                .and_then(|node| self.state.attr(&node))
            {
                Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(0)),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
            match self
                .state
                .child(parent, name)
                .and_then(|path| self.state.directories.rmdir(&path))
            {
                Ok(()) => reply.ok(),
                Err(error) => reply.error(errno(error)),
            }
        }
    };
}
pub(super) use callbacks;
