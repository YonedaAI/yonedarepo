//! `yoneda login`: the device flow (RFC 8628 shape). The CLI asks for a code, the person
//! approves it in the browser (signed in on the website), and the CLI polls until the
//! platform hands over a personal access token, stored 0600. `--with-token` reads a
//! token from stdin instead (CI); `YONEDA_TOKEN` overrides whatever is stored.
use crate::api::Api;
use crate::credentials::{self, Token};
use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::time::Duration;

/// What `POST /device/code` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

/// An approved login.
#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub token: String,
    pub account: Option<String>,
    pub expires_at: Option<String>,
}

/// One poll's answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Poll {
    Pending,
    SlowDown,
    Granted(Grant),
    Expired,
    Denied,
}

/// The two device-flow calls (the platform, or a stub in tests).
pub(crate) trait DeviceFlow {
    async fn code(&self) -> Result<DeviceCode>;
    async fn poll(&self, device_code: &str) -> Result<Poll>;
}

/// Waiting between polls (real time, or recorded in tests).
pub(crate) trait Clock {
    async fn sleep(&mut self, seconds: u64);
}

pub(crate) struct RealClock;

impl Clock for RealClock {
    async fn sleep(&mut self, seconds: u64) {
        tokio::time::sleep(Duration::from_secs(seconds)).await;
    }
}

/// Polls until the code is approved, denied or expired. `SLOW_DOWN` adds 5 seconds to
/// the interval, as RFC 8628 asks.
pub(crate) async fn wait_for_grant(
    flow: &impl DeviceFlow,
    clock: &mut impl Clock,
    code: &DeviceCode,
) -> Result<Grant> {
    let mut interval = code.interval;
    let mut waited = 0u64;
    loop {
        if waited >= code.expires_in {
            return Err(Error::new(
                "the login code expired before it was approved; run `yoneda login` again",
            ));
        }
        clock.sleep(interval).await;
        waited += interval.max(1);
        match flow.poll(&code.device_code).await? {
            Poll::Pending => {}
            Poll::SlowDown => interval += 5,
            Poll::Granted(grant) => return Ok(grant),
            Poll::Expired => {
                return Err(Error::new(
                    "the login code expired or was already used; run `yoneda login` again",
                ));
            }
            Poll::Denied => return Err(Error::new("the login was denied in the browser")),
        }
    }
}

/// The device flow against the platform's account API.
pub(crate) struct HttpFlow(pub Api);

fn field(value: &Value, name: &str) -> Result<String> {
    value[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::new(format!("the platform's device login sent no {name}")))
}

impl DeviceFlow for HttpFlow {
    async fn code(&self) -> Result<DeviceCode> {
        let value = self
            .0
            .post("/device/code", &json!({ "client_name": "yoneda-cli" }))
            .await?;
        Ok(DeviceCode {
            device_code: field(&value, "device_code")?,
            user_code: field(&value, "user_code")?,
            verification_uri: field(&value, "verification_uri")?,
            verification_uri_complete: value["verification_uri_complete"]
                .as_str()
                .map(str::to_owned),
            expires_in: value["expires_in"].as_u64().unwrap_or(600),
            interval: value["interval"].as_u64().unwrap_or(5),
        })
    }

    async fn poll(&self, device_code: &str) -> Result<Poll> {
        let body = json!({ "device_code": device_code });
        match self.0.post("/device/token", &body).await {
            Ok(value) => Ok(Poll::Granted(Grant {
                token: field(&value, "token")?,
                account: value["account"]
                    .as_str()
                    .or_else(|| value["account"]["name"].as_str())
                    .map(str::to_owned),
                expires_at: value["expires_at"].as_str().map(str::to_owned),
            })),
            Err(f) => match f.code.as_str() {
                "AUTHORIZATION_PENDING" => Ok(Poll::Pending),
                "SLOW_DOWN" => Ok(Poll::SlowDown),
                "EXPIRED_TOKEN" => Ok(Poll::Expired),
                "ACCESS_DENIED" => Ok(Poll::Denied),
                _ => Err(f.into()),
            },
        }
    }
}

/// Opens `url` in the person's browser; failure is fine (the URL is printed).
fn open_browser(url: &str) {
    let opener: &[&str] = if cfg!(target_os = "macos") {
        &["open"]
    } else if cfg!(windows) {
        &["cmd", "/C", "start", ""]
    } else {
        &["xdg-open"]
    };
    let _ = std::process::Command::new(opener[0])
        .args(&opener[1..])
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// `yoneda login`.
pub async fn login(origin: &str, with_token: bool, browser: bool) -> Result<()> {
    let path = credentials::default_path()?;
    if with_token {
        let mut line = String::new();
        std::io::stdin()
            .read_line(&mut line)
            .map_err(|e| Error::new(format!("reading the token from stdin: {e}")))?;
        credentials::store(&path, origin, &Token::new(&line)?)?;
        println!(
            "Stored a token for {origin} in {} (mode 0600)",
            path.display()
        );
        return Ok(());
    }
    let flow = HttpFlow(Api::account(origin, None)?);
    let code = flow.code().await?;
    let link = code
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| code.verification_uri.clone());
    println!(
        "Open {} and enter the code {}",
        code.verification_uri, code.user_code
    );
    if browser {
        open_browser(&link);
    }
    let grant = wait_for_grant(&flow, &mut RealClock, &code).await?;
    credentials::store(&path, origin, &Token::new(&grant.token)?)?;
    println!(
        "Logged in to {origin}{}{}; token stored in {} (mode 0600)",
        grant
            .account
            .map(|a| format!(" as {a}"))
            .unwrap_or_default(),
        grant
            .expires_at
            .map(|e| format!(", expires {e}"))
            .unwrap_or_default(),
        path.display()
    );
    Ok(())
}

/// `yoneda logout`.
pub fn logout(origin: Option<&str>) -> Result<()> {
    let path = credentials::default_path()?;
    if credentials::remove(&path, origin)? {
        println!("Removed the stored token ({})", path.display());
    } else {
        println!("No stored token to remove");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Stub {
        answers: RefCell<Vec<Poll>>,
        polls: RefCell<usize>,
    }

    impl DeviceFlow for Stub {
        async fn code(&self) -> Result<DeviceCode> {
            Ok(code(5, 600))
        }
        async fn poll(&self, device_code: &str) -> Result<Poll> {
            assert_eq!(device_code, "dev-1");
            *self.polls.borrow_mut() += 1;
            Ok(self.answers.borrow_mut().remove(0))
        }
    }

    #[derive(Default)]
    struct Recorded(Vec<u64>);

    impl Clock for Recorded {
        async fn sleep(&mut self, seconds: u64) {
            self.0.push(seconds);
        }
    }

    fn code(interval: u64, expires_in: u64) -> DeviceCode {
        DeviceCode {
            device_code: "dev-1".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://dev.yonedarepo.com/device".into(),
            verification_uri_complete: None,
            expires_in,
            interval,
        }
    }

    fn grant() -> Grant {
        Grant {
            token: "ypat_x".into(),
            account: Some("alice".into()),
            expires_at: None,
        }
    }

    fn stub(answers: Vec<Poll>) -> Stub {
        Stub {
            answers: RefCell::new(answers),
            polls: RefCell::new(0),
        }
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .map(|rt| rt.block_on(future))
            .unwrap_or_else(|e| panic!("runtime: {e}"))
    }

    #[test]
    fn polls_at_the_interval_and_slows_down_when_asked() -> Result<()> {
        let flow = stub(vec![
            Poll::Pending,
            Poll::SlowDown,
            Poll::Pending,
            Poll::Granted(grant()),
        ]);
        let mut clock = Recorded::default();
        let got = run(wait_for_grant(&flow, &mut clock, &code(5, 600)))?;
        assert_eq!(got.token, "ypat_x");
        assert_eq!(clock.0, [5, 5, 10, 10]);
        assert_eq!(*flow.polls.borrow(), 4);
        Ok(())
    }

    #[test]
    fn stops_on_denial_expiry_and_the_deadline() {
        let denied = run(wait_for_grant(
            &stub(vec![Poll::Denied]),
            &mut Recorded::default(),
            &code(1, 600),
        ));
        assert!(denied.is_err_and(|e| e.message.contains("denied")));
        let expired = run(wait_for_grant(
            &stub(vec![Poll::Expired]),
            &mut Recorded::default(),
            &code(1, 600),
        ));
        assert!(expired.is_err_and(|e| e.message.contains("expired")));
        // A code good for 10 s polled every 5 s: two polls, then the CLI gives up.
        let flow = stub(vec![Poll::Pending, Poll::Pending, Poll::Granted(grant())]);
        let late = run(wait_for_grant(
            &flow,
            &mut Recorded::default(),
            &code(5, 10),
        ));
        assert!(late.is_err_and(|e| e.message.contains("expired")));
        assert_eq!(*flow.polls.borrow(), 2);
    }
}
