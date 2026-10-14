//! FUSE callbacks grouped by responsibility within one trait implementation.
macro_rules! callbacks {
    () => {
        fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
            match self
                .state
                .child(parent, name)
                .and_then(|path| self.state.directories.stat(&path))
                .and_then(|node| self.state.attr(&node))
            {
                Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(0)),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
            match self
                .state
                .path(ino)
                .and_then(|path| self.state.directories.stat(&path))
                .and_then(|node| self.state.attr(&node))
            {
                Ok(attr) => reply.attr(&Duration::ZERO, &attr),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
            let result = self
                .state
                .path(ino)
                .and_then(|path| self.state.directories.stat(&path))
                .and_then(|mut node| {
                    if node.directory() {
                        return Err(failure(
                            "SOURCE_IS_DIRECTORY",
                            "Cannot open source directory as a file",
                        ));
                    }
                    let writable = flags.acc_mode() != OpenAccMode::O_RDONLY;
                    if flags.0 & libc::O_TRUNC != 0 {
                        if !writable {
                            return Err(failure("INVALID_SOURCE", "Read-only truncate rejected"));
                        }
                        node = self
                            .state
                            .apply(&SourceChange::Truncate {
                                path: node.path,
                                expected: node.version,
                                size: 0,
                            })?
                            .ok_or_else(|| {
                                failure("SOURCE_FENCED", "Truncate returned no source file")
                            })?;
                    }
                    self.state.open(&node, writable)
                });
            match result {
                Ok(handle) => reply.opened(handle, FopenFlags::empty()),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn read(
            &self,
            _req: &Request,
            ino: INodeNo,
            _fh: FileHandle,
            offset: u64,
            size: u32,
            _flags: OpenFlags,
            _owner: Option<LockOwner>,
            reply: ReplyData,
        ) {
            match self
                .state
                .path(ino)
                .and_then(|path| self.state.source.read(&path, offset, size as usize))
            {
                Ok(bytes) => reply.data(&bytes),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn readdir(
            &self,
            _req: &Request,
            ino: INodeNo,
            _fh: FileHandle,
            offset: u64,
            mut reply: ReplyDirectory,
        ) {
            let result = self
                .state
                .path(ino)
                .and_then(|path| self.state.directories.list(&path));
            match result {
                Ok(entries) => {
                    let mut all = vec![
                        (ino, FileType::Directory, ".".to_string()),
                        (INodeNo(1), FileType::Directory, "..".into()),
                    ];
                    for entry in entries {
                        let inode = match self.state.inode(&entry.path) {
                            Ok(inode) => inode,
                            Err(error) => {
                                reply.error(errno(error));
                                return;
                            }
                        };
                        all.push((
                            inode,
                            if entry.directory() {
                                FileType::Directory
                            } else {
                                FileType::RegularFile
                            },
                            entry.path.rsplit('/').next().unwrap_or_default().into(),
                        ));
                    }
                    for (index, (inode, kind, name)) in
                        all.into_iter().enumerate().skip(offset as usize)
                    {
                        if reply.add(inode, (index + 1) as u64, kind, name) {
                            break;
                        }
                    }
                    reply.ok();
                }
                Err(error) => reply.error(errno(error)),
            }
        }
    };
}
pub(super) use callbacks;
