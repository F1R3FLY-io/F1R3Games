//! Game clients on origins of their own (F2).
//!
//! The portal frames a game only from another origin (`GameFrame.tsx`), and
//! the host protocol trusts a frame by its origin (`core/host.ts`). Each
//! `[[origins]]` entry therefore gets listeners of its own, serving one
//! game's built client at `/<id>/` and nothing else, with
//! `frame-ancestors` naming the portal and `nosniff` on every response.

use crate::config::GameOrigin;
use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::{Redirect, Response};
use axum::routing::get;
use axum::Router;
use std::path::Path;

/// The `Content-Security-Policy` value for a game origin.
pub fn csp(o: &GameOrigin, portal_origin: Option<&str>) -> Option<String> {
    let mut a: Vec<String> = o.frame_ancestors.clone();
    if a.is_empty() {
        a.extend(portal_origin.map(str::to_string));
    }
    (!a.is_empty()).then(|| format!("frame-ancestors {}", a.join(" ")))
}

async fn headers(csp: Option<String>, req: Request, next: Next) -> Response {
    let mut r = next.run(req).await;
    let h = r.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if let Some(v) = csp.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
        h.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    r
}

/// The router for one game origin.
pub fn router(o: &GameOrigin, portal_origin: Option<&str>) -> Router {
    let root = Path::new(&o.dir).join(&o.id);
    let mount = format!("/{}", o.id);
    let home = format!("/{}/", o.id);
    let serve = tower_http::services::ServeDir::new(root).append_index_html_on_directories(true);
    let csp = csp(o, portal_origin);
    let r = Router::new()
        .route("/", get(move || async move { Redirect::temporary(&home) }))
        .nest_service(&mount, serve)
        .layer(middleware::from_fn(move |req: Request, next: Next| headers(csp.clone(), req, next)));
    crate::hosts::guard(r, o.public_host.as_deref())
}

#[cfg(test)]
mod tests {
    use crate::config::{GameOrigin, Listen};

    #[test]
    fn frame_ancestors_default_to_the_portal() {
        let mut o = GameOrigin { id: "f1r3pix".into(), listen: Listen::One("127.0.0.1:0".into()), public_host: None, dir: "d".into(), frame_ancestors: vec![] };
        assert_eq!(super::csp(&o, Some("http://localhost:40700")).as_deref(), Some("frame-ancestors http://localhost:40700"));
        assert_eq!(super::csp(&o, None), None);
        o.frame_ancestors = vec!["http://localhost:5173".into(), "http://localhost:40700".into()];
        assert_eq!(super::csp(&o, None).as_deref(), Some("frame-ancestors http://localhost:5173 http://localhost:40700"));
    }
}
