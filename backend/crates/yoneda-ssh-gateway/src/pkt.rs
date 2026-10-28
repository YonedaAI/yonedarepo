//! Git pkt-lines as the bridge needs them: framing a request (up to its flush), reading
//! push commands, and stripping smart HTTP's `# service=` preamble.

/// The largest pkt-line Git sends (length included).
pub const MAX_PKT: usize = 65520;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pkt {
    Flush,
    Delim,
    ResponseEnd,
    Data(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("malformed pkt-line")]
pub struct Malformed;

/// The first pkt-line of `buf` and the bytes it spans, or `None` when more are needed.
pub fn parse(buf: &[u8]) -> Result<Option<(Pkt, usize)>, Malformed> {
    let Some(head) = buf.get(..4) else {
        return Ok(None);
    };
    let text = std::str::from_utf8(head).map_err(|_| Malformed)?;
    if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Malformed);
    }
    let len = usize::from_str_radix(text, 16).map_err(|_| Malformed)?;
    Ok(match len {
        0 => Some((Pkt::Flush, 4)),
        1 => Some((Pkt::Delim, 4)),
        2 => Some((Pkt::ResponseEnd, 4)),
        3 => return Err(Malformed),
        n if n > MAX_PKT => return Err(Malformed),
        n => buf.get(4..n).map(|data| (Pkt::Data(data.to_vec()), n)),
    })
}

/// Smart HTTP's advertisement preamble (`# service=…` and its flush), which Git over SSH
/// does not send, removed from the front of `body` when present.
pub fn strip_service_preamble(body: &[u8]) -> &[u8] {
    if let Ok(Some((Pkt::Data(line), used))) = parse(body)
        && line.starts_with(b"# service=")
        && let Ok(Some((Pkt::Flush, flush))) = parse(&body[used..])
    {
        return &body[used + flush..];
    }
    body
}

/// What a push's command list says about what follows it.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PushPlan {
    /// At least one ref command (an empty list means nothing to push).
    pub commands: usize,
    /// A command creates or updates a ref, so a pack follows (delete-only pushes send none).
    pub pack: bool,
    /// The client asked for `push-options`: a second pkt-line section follows the commands.
    pub options: bool,
}

impl PushPlan {
    /// Notes one command pkt-line (`<old> <new> <ref>[\0caps]`; `shallow <oid>` lines are
    /// not commands).
    pub fn note(&mut self, line: &[u8]) {
        if line.starts_with(b"shallow ") {
            return;
        }
        let (command, caps) = match line.iter().position(|&b| b == 0) {
            Some(nul) => (&line[..nul], Some(&line[nul + 1..])),
            None => (line, None),
        };
        if self.commands == 0
            && let Some(caps) = caps
        {
            self.options = caps
                .split(|&b| b == b' ' || b == b'\n')
                .any(|c| c == b"push-options");
        }
        self.commands += 1;
        let new = command.split(|&b| b == b' ').nth(1).unwrap_or_default();
        if new.is_empty() || new.iter().any(|&b| b != b'0') {
            self.pack = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> Vec<u8> {
        format!("{:04x}{text}", text.len() + 4).into_bytes()
    }

    #[test]
    fn frames_specials_data_and_partial_input() {
        assert_eq!(parse(b"0000rest").unwrap(), Some((Pkt::Flush, 4)));
        assert_eq!(parse(b"0001").unwrap(), Some((Pkt::Delim, 4)));
        assert_eq!(parse(b"0002").unwrap(), Some((Pkt::ResponseEnd, 4)));
        assert_eq!(parse(b"0004").unwrap(), Some((Pkt::Data(vec![]), 4)));
        assert_eq!(
            parse(&line("command=ls-refs\n")).unwrap(),
            Some((Pkt::Data(b"command=ls-refs\n".to_vec()), 20))
        );
        assert_eq!(parse(b"00").unwrap(), None);
        assert_eq!(parse(b"0010abc").unwrap(), None);
        assert_eq!(parse(b"0003"), Err(Malformed));
        assert_eq!(parse(b"zzzz"), Err(Malformed));
        assert_eq!(parse(b"fff1"), Err(Malformed));
    }

    #[test]
    fn the_http_preamble_is_stripped_only_when_present() {
        let mut body = line("# service=git-receive-pack\n");
        body.extend_from_slice(b"0000");
        body.extend_from_slice(&line("abc refs/heads/main\0report-status\n"));
        assert_eq!(
            strip_service_preamble(&body),
            &line("abc refs/heads/main\0report-status\n")[..]
        );
        let v2 = line("version 2\n");
        assert_eq!(strip_service_preamble(&v2), &v2[..]);
    }

    #[test]
    fn push_plans_tell_deletes_options_and_shallows_apart() {
        let zero = "0".repeat(40);
        let oid = "a".repeat(40);
        let mut delete = PushPlan::default();
        delete.note(format!("{oid} {zero} refs/heads/x\0report-status atomic").as_bytes());
        delete.note(format!("{oid} {zero} refs/heads/y").as_bytes());
        assert_eq!(
            delete,
            PushPlan {
                commands: 2,
                pack: false,
                options: false
            }
        );
        let mut update = PushPlan::default();
        update.note(format!("shallow {oid}").as_bytes());
        update.note(format!("{zero} {oid} refs/heads/x\0report-status push-options\n").as_bytes());
        assert_eq!(
            update,
            PushPlan {
                commands: 1,
                pack: true,
                options: true
            }
        );
        // Capabilities count on the first command only.
        let mut later = PushPlan::default();
        later.note(format!("{oid} {zero} refs/heads/x").as_bytes());
        later.note(format!("{oid} {zero} refs/heads/y\0push-options").as_bytes());
        assert!(!later.options);
    }
}
