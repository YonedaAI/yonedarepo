//! The little HTTP/1.1 the builder speaks with its Worker (through the container's port):
//! one request per connection, a body of `Content-Length` bytes, and answers either whole
//! or chunked (a pack streams as Git writes it). A chunked answer cut short (Git failed
//! midway) ends without its last chunk, so the Worker sees a broken body, never a short pack.
use std::io::{self, BufRead, Read, Write};

/// Header bytes a request may carry.
const MAX_HEAD: usize = 16 * 1024;
/// Body bytes a request may carry (a checkout's wanted ids: 41 bytes each).
pub const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: Option<String>,
    pub body: Vec<u8>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Reads one request (head, then its body).
pub fn read_request(reader: &mut impl BufRead) -> io::Result<Request> {
    let mut head = 0;
    let mut line = String::new();
    let mut next = |line: &mut String| -> io::Result<()> {
        line.clear();
        let read = reader.by_ref().take(MAX_HEAD as u64).read_line(line)?;
        head += read;
        if read == 0 || head > MAX_HEAD {
            return Err(invalid("request head is missing or too large"));
        }
        Ok(())
    };
    next(&mut line)?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Err(invalid("request line is malformed"));
    };
    let (method, target) = (method.to_owned(), target.to_owned());
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let mut length = 0usize;
    let mut authorization = None;
    loop {
        next(&mut line)?;
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Err(invalid("header is malformed"));
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                length = value.parse().map_err(|_| invalid("content-length"))?;
            }
            "authorization" => authorization = Some(value.to_owned()),
            "transfer-encoding" => return Err(invalid("chunked requests are not accepted")),
            _ => {}
        }
    }
    if length > MAX_BODY {
        return Err(invalid("request body is too large"));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Request {
        method,
        path: path.to_owned(),
        query: query.to_owned(),
        authorization,
        body,
    })
}

/// A whole answer.
pub fn respond(out: &mut impl Write, status: u16, kind: &str, body: &[u8]) -> io::Result<()> {
    write!(
        out,
        "HTTP/1.1 {status} {}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        reason(status),
        body.len()
    )?;
    out.write_all(body)?;
    out.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    }
}

/// A chunked answer: the head goes out first, then each write is a chunk; `finish` sends the
/// last chunk. Dropped unfinished, the body ends broken.
pub struct Chunked<W: Write> {
    out: W,
}

impl<W: Write> Chunked<W> {
    pub fn start(mut out: W, kind: &str) -> io::Result<Self> {
        write!(
            out,
            "HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
        )?;
        Ok(Self { out })
    }

    pub fn finish(mut self) -> io::Result<()> {
        self.out.write_all(b"0\r\n\r\n")?;
        self.out.flush()
    }
}

impl<W: Write> Write for Chunked<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        write!(self.out, "{:x}\r\n", bytes.len())?;
        self.out.write_all(bytes)?;
        self.out.write_all(b"\r\n")?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_request_with_its_body_and_refuses_oversized_ones() {
        let raw = b"POST /pack?filter=blob:none HTTP/1.1\r\nAuthorization: Bearer s\r\nContent-Length: 3\r\n\r\nabcrest";
        let request = read_request(&mut &raw[..]).expect("request");
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/pack")
        );
        assert_eq!(request.query, "filter=blob:none");
        assert_eq!(request.authorization.as_deref(), Some("Bearer s"));
        assert_eq!(request.body, b"abc");
        let big = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        assert!(read_request(&mut big.as_bytes()).is_err());
        assert!(
            read_request(&mut &b"GET / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"[..])
                .is_err()
        );
    }

    #[test]
    fn chunks_an_answer_and_ends_it_only_when_finished() {
        let mut out = Vec::new();
        let mut chunked = Chunked::start(&mut out, "application/x-git-packfile").expect("head");
        chunked.write_all(b"PACK").expect("chunk");
        chunked.finish().expect("end");
        let text = String::from_utf8(out).expect("utf8");
        assert!(text.ends_with("\r\n\r\n4\r\nPACK\r\n0\r\n\r\n"), "{text}");
    }
}
