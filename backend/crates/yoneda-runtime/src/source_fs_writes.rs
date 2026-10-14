//! FUSE callbacks grouped by responsibility within one trait implementation.
macro_rules! callbacks {
    () => {
        fn write(
            &self,
            _req: &Request,
            _ino: INodeNo,
            fh: FileHandle,
            offset: u64,
            data: &[u8],
            _write_flags: WriteFlags,
            _flags: OpenFlags,
            _owner: Option<LockOwner>,
            reply: ReplyWrite,
        ) {
            let result = self.state.handle(fh).and_then(|handle| {
                if !handle.writable {
                    return Err(failure("SOURCE_READ_ONLY", "Source handle is not writable"));
                }
                let node = self
                    .state
                    .apply(&SourceChange::Write {
                        path: handle.path,
                        expected: handle.version,
                        offset,
                        bytes: data.to_vec(),
                    })?
                    .ok_or_else(|| failure("SOURCE_FENCED", "Write returned no source file"))?;
                self.state.update_handle(fh, &node)
            });
            match result {
                Ok(()) => reply.written(data.len() as u32),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn create(
            &self,
            _req: &Request,
            parent: INodeNo,
            name: &OsStr,
            mode: u32,
            _umask: u32,
            flags: i32,
            reply: ReplyCreate,
        ) {
            let result = mutations::create(&self.state, parent, name, mode, OpenFlags(flags))
                .and_then(|node| {
                    let attr = self.state.attr(&node)?;
                    let handle = self
                        .state
                        .open(&node, OpenFlags(flags).acc_mode() != OpenAccMode::O_RDONLY)?;
                    Ok((attr, handle))
                });
            match result {
                Ok((attr, handle)) => reply.created(
                    &Duration::ZERO,
                    &attr,
                    Generation(0),
                    handle,
                    FopenFlags::empty(),
                ),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
            let result = self
                .state
                .child(parent, name)
                .and_then(|path| self.state.source.stat(&path))
                .and_then(|node| {
                    self.state.apply(&SourceChange::Delete {
                        path: node.path,
                        expected: node.version,
                    })
                });
            match result {
                Ok(_) => reply.ok(),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn rename(
            &self,
            _req: &Request,
            parent: INodeNo,
            name: &OsStr,
            newparent: INodeNo,
            newname: &OsStr,
            flags: RenameFlags,
            reply: ReplyEmpty,
        ) {
            match mutations::rename(&self.state, parent, name, newparent, newname, flags) {
                Ok(()) => reply.ok(),
                Err(error) => reply.error(errno(error)),
            }
        }
        fn setattr(
            &self,
            _req: &Request,
            ino: INodeNo,
            mode: Option<u32>,
            uid: Option<u32>,
            gid: Option<u32>,
            size: Option<u64>,
            _atime: Option<TimeOrNow>,
            _mtime: Option<TimeOrNow>,
            _ctime: Option<std::time::SystemTime>,
            fh: Option<FileHandle>,
            _crtime: Option<std::time::SystemTime>,
            _chgtime: Option<std::time::SystemTime>,
            _bkuptime: Option<std::time::SystemTime>,
            flags: Option<BsdFileFlags>,
            reply: ReplyAttr,
        ) {
            let result = if uid.is_some() || gid.is_some() || flags.is_some() {
                Err(failure(
                    "INVALID_SOURCE",
                    "Source ownership changes are unsupported",
                ))
            } else {
                mutations::setattr(&self.state, ino, mode, size, fh)
                    .and_then(|node| self.state.attr(&node))
            };
            match result {
                Ok(attr) => reply.attr(&Duration::ZERO, &attr),
                Err(error) => reply.error(errno(error)),
            }
        }
    };
}
pub(super) use callbacks;
