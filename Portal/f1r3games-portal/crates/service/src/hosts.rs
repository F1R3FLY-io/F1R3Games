//! The `Host` allow-list (F4).
//!
//! A portal reached at `http://localhost:P` keeps its keystore, pinned
//! environment and passkeys under that origin. The same pages reached as
//! `127.0.0.1:P` or `[::1]:P` would be another origin, with an empty
//! keystore and passkeys that cannot work (WebAuthn refuses IP literals as
//! relying-party ids), so those are redirected to the public host. Any other
//! `Host` is refused, which also defeats DNS rebinding: a remote page that
//! points its own name at 127.0.0.1 still sends its own name as `Host`.

use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Redirect,
    Refuse,
}

fn port_of(authority: &str) -> Option<&str> {
    let (_, port) = authority.rsplit_once(':')?;
    (!port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && !port.contains(']')).then_some(port)
}

/// What to do with a request whose `Host` is `host`, for an origin whose
/// only public authority is `public` (`localhost:40700`).
pub fn decide(public: &str, host: &str) -> Verdict {
    let host = host.trim();
    if host.eq_ignore_ascii_case(public) {
        return Verdict::Pass;
    }
    let Some(port) = port_of(public) else { return Verdict::Refuse };
    for lit in ["127.0.0.1", "[::1]"] {
        if host == format!("{lit}:{port}") {
            return Verdict::Redirect;
        }
    }
    Verdict::Refuse
}

async fn check(public: String, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    match decide(&public, &host) {
        Verdict::Pass => next.run(req).await,
        Verdict::Redirect => {
            let pq = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
            let loc = format!("http://{public}{pq}");
            let mut r = StatusCode::PERMANENT_REDIRECT.into_response();
            if let Ok(v) = HeaderValue::from_str(&loc) {
                r.headers_mut().insert(header::LOCATION, v);
            }
            r
        }
        Verdict::Refuse => (StatusCode::MISDIRECTED_REQUEST, format!("this server answers only to {public}\n")).into_response(),
    }
}

/// Wrap `router` in the allow-list when a public host is configured.
pub fn guard(router: Router, public: Option<&str>) -> Router {
    match public {
        None => router,
        Some(p) => {
            let p = p.to_string();
            router.layer(middleware::from_fn(move |req: Request, next: Next| check(p.clone(), req, next)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, Verdict::*};

    #[test]
    fn localhost_passes_literals_redirect_others_refused() {
        let p = "localhost:40700";
        assert_eq!(decide(p, "localhost:40700"), Pass);
        assert_eq!(decide(p, "LOCALHOST:40700"), Pass);
        assert_eq!(decide(p, "127.0.0.1:40700"), Redirect);
        assert_eq!(decide(p, "[::1]:40700"), Redirect);
        assert_eq!(decide(p, "127.0.0.1:40701"), Refuse);
        assert_eq!(decide(p, "localhost:40701"), Refuse);
        assert_eq!(decide(p, "evil.example"), Refuse);
        assert_eq!(decide(p, "evil.example:40700"), Refuse);
        assert_eq!(decide(p, ""), Refuse);
    }
}
