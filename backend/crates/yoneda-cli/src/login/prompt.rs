//! The login's terminal: the sign-in screen and its two keys. It runs only with a person at a
//! terminal; a script, a pipe or `--json` gets the plain line and waits. Keys are read in raw
//! mode from their own thread while the login polls, and raw mode always ends with the wait.
use super::{DeviceCode, open_browser};
use crate::output;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use std::io::{IsTerminal, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

/// How often the key thread looks up to see whether the wait is over.
const TICK: Duration = Duration::from_millis(100);
/// The exit status of a command stopped by Ctrl-C.
const INTERRUPTED: i32 = 130;

/// Whether a person is here to press a key. `--no-browser` means a machine with no browser,
/// so there is nothing for the keys to do.
pub fn interactive(browser: bool) -> bool {
    browser && !output::json() && std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// The site a URL is on: `https://host[:port]`.
pub fn site_of(url: &str) -> &str {
    let after_scheme = url.find("://").map_or(0, |at| at + 3);
    match url[after_scheme..].find('/') {
        Some(slash) => &url[..after_scheme + slash],
        None => url,
    }
}

/// What a person sees while the login waits. The code stays on screen so it can be matched with
/// the one the browser shows: a link alone must not approve someone else's login.
pub fn screen(code: &DeviceCode, link: &str) -> String {
    format!(
        "Logging in to {}\n\nLogin URL:\n  {link}\n\nYour code: {}\n\n[Enter] Open browser  [c] Copy URL\nWaiting for sign-in…",
        site_of(&code.verification_uri),
        code.user_code
    )
}

/// The last line of a login.
pub fn done(code: &DeviceCode) -> String {
    format!(
        "✓ Login complete (signed in at {}).",
        site_of(&code.verification_uri)
    )
}

#[derive(Debug, PartialEq, Eq)]
enum Key {
    Open,
    Copy,
    Interrupt,
}

fn key(event: KeyEvent) -> Option<Key> {
    if event.kind == KeyEventKind::Release {
        return None;
    }
    match event.code {
        KeyCode::Char('c') if event.modifiers.contains(KeyModifiers::CONTROL) => {
            Some(Key::Interrupt)
        }
        KeyCode::Enter => Some(Key::Open),
        KeyCode::Char('c' | 'C') => Some(Key::Copy),
        _ => None,
    }
}

/// A line in raw mode, where a new line needs its carriage return.
fn say(text: &str) {
    let mut out = std::io::stdout();
    let _ = write!(out, "{text}\r\n");
    let _ = out.flush();
}

fn act(pressed: Key, link: &str) {
    match pressed {
        Key::Open => {
            open_browser(link);
            say("Opened your browser.");
        }
        Key::Copy => match crate::ssh_setup::copy(link) {
            Some(_) => say("Copied the URL."),
            None => say("No clipboard here: copy the URL above."),
        },
        Key::Interrupt => {
            let _ = disable_raw_mode();
            std::process::exit(INTERRUPTED);
        }
    }
}

/// The keys, listening until dropped.
pub struct Keys {
    over: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Keys {
    /// Starts listening; `None` where the terminal has no raw mode (the login just waits).
    pub fn listen(link: &str) -> Option<Self> {
        enable_raw_mode().ok()?;
        let over = Arc::new(AtomicBool::new(false));
        let (flag, link) = (over.clone(), link.to_owned());
        let thread = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                if !event::poll(TICK).unwrap_or(false) {
                    continue;
                }
                if let Ok(Event::Key(event)) = event::read()
                    && let Some(pressed) = key(event)
                {
                    act(pressed, &link);
                }
            }
        });
        Some(Self {
            over,
            thread: Some(thread),
        })
    }
}

impl Drop for Keys {
    fn drop(&mut self) {
        self.over.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = disable_raw_mode();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code() -> DeviceCode {
        DeviceCode {
            device_code: "dev-1".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://dev.yonedarepo.com/device".into(),
            verification_uri_complete: None,
            expires_in: 600,
            interval: 5,
        }
    }

    #[test]
    fn the_screen_names_the_site_the_link_and_the_code_and_says_what_keys_do() {
        let link = "https://dev.yonedarepo.com/device?code=ABCD-EFGH";
        assert_eq!(
            screen(&code(), link),
            "Logging in to https://dev.yonedarepo.com\n\
             \n\
             Login URL:\n  https://dev.yonedarepo.com/device?code=ABCD-EFGH\n\
             \n\
             Your code: ABCD-EFGH\n\
             \n\
             [Enter] Open browser  [c] Copy URL\n\
             Waiting for sign-in…"
        );
    }

    #[test]
    fn the_last_line_names_the_site() {
        assert_eq!(
            done(&code()),
            "✓ Login complete (signed in at https://dev.yonedarepo.com)."
        );
    }

    #[test]
    fn finds_the_site_of_a_url() {
        assert_eq!(site_of("https://a.test/device?x=1"), "https://a.test");
        assert_eq!(
            site_of("http://127.0.0.1:8787/device"),
            "http://127.0.0.1:8787"
        );
        assert_eq!(site_of("https://a.test"), "https://a.test");
    }

    #[test]
    fn enter_opens_c_copies_ctrl_c_stops_and_nothing_else_acts() {
        let press = |code, modifiers| key(KeyEvent::new(code, modifiers));
        let none = KeyModifiers::NONE;
        assert_eq!(press(KeyCode::Enter, none), Some(Key::Open));
        assert_eq!(press(KeyCode::Char('c'), none), Some(Key::Copy));
        assert_eq!(
            press(KeyCode::Char('C'), KeyModifiers::SHIFT),
            Some(Key::Copy)
        );
        assert_eq!(
            press(KeyCode::Char('c'), KeyModifiers::CONTROL),
            Some(Key::Interrupt)
        );
        assert_eq!(press(KeyCode::Char('x'), none), None);
        let mut released = KeyEvent::new(KeyCode::Enter, none);
        released.kind = KeyEventKind::Release;
        assert_eq!(key(released), None);
    }

    #[test]
    fn a_test_run_has_no_person_to_ask() {
        assert!(!interactive(false));
    }
}
