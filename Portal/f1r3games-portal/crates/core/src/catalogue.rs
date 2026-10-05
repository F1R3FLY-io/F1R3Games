//! The portal's template catalogue.
//!
//! Three hand-written templates live in `templates/`: the `games` environment
//! (`env.rho`), the wallet's vault transfer (`transfer.rho`) and the
//! environment probe (`env_probe.rho`). Every call into the environment is
//! generated from the method table below by one rule, so the surface is
//! uniform and a wallet can recognise any call:
//!
//! ```text
//! deploy:  new deployId(`rho:system:deployId`), rl(`rho:registry:lookup`), envCh in {
//!            rl!({{env_uri}}, *envCh) |
//!            for (@(_, env) <- envCh) { @env!("<domain>", "<op>", {{a}}, ..., *deployId) } }
//! explore: new ret, rl(`rho:registry:lookup`), envCh in { ... *ret ... }
//! ```
//!
//! The explore form binds `ret` first and without a URI, as the node's
//! exploratory deploy requires (`docs/node/exploratory-deploy.md`).

use crate::template::{Template, TemplateKind};
use std::sync::OnceLock;

pub const ENV_SOURCE: &str = include_str!("../../../templates/env.rho");
pub const TRANSFER_SOURCE: &str = include_str!("../../../templates/transfer.rho");
pub const ENV_PROBE_SOURCE: &str = include_str!("../../../templates/env_probe.rho");

pub const ENV: &str = "env";
pub const TRANSFER: &str = "wallet.transfer";
pub const ENV_PROBE: &str = "env.probe";

/// `(domain, op, kind, parameters)`.
pub const METHODS: &[(&str, &str, TemplateKind, &[&str])] = {
    use TemplateKind::{Deploy as D, Explore as E};
    &[
        ("profiles", "save", D, &["profile"]),
        ("profiles", "get", E, &["address"]),
        ("games", "register", D, &["manifest"]),
        ("games", "retire", D, &["game"]),
        ("games", "get", E, &["game"]),
        ("games", "list", E, &[]),
        ("instances", "create", D, &["id", "game", "visibility", "config"]),
        ("instances", "join", D, &["id"]),
        ("instances", "leave", D, &["id"]),
        ("instances", "setStatus", D, &["id", "status"]),
        ("instances", "get", E, &["id"]),
        ("instances", "listPublic", E, &["game"]),
        ("plays", "publish", D, &["id", "instance", "kind", "header", "body"]),
        ("plays", "saveVersion", D, &["id", "body"]),
        ("plays", "link", D, &["id", "other"]),
        ("plays", "get", E, &["id"]),
        ("plays", "body", E, &["id", "version"]),
        ("plays", "list", E, &["game", "kind", "day"]),
        ("invites", "issue", D, &["invitePk", "instance", "uses", "expiresAt", "sponsorship"]),
        ("invites", "redeem", D, &["invitePk", "sig"]),
        ("invites", "revoke", D, &["invitePk"]),
        ("invites", "get", E, &["invitePk"]),
        ("sponsors", "create", D, &["id", "terms", "amount"]),
        ("sponsors", "fund", D, &["id", "amount"]),
        ("sponsors", "claim", D, &["id", "instance"]),
        ("sponsors", "withdraw", D, &["id"]),
        ("sponsors", "get", E, &["id"]),
        ("sponsors", "list", E, &[]),
        ("engagement", "record", D, &["play", "kind"]),
        ("engagement", "counts", E, &["play"]),
        ("contacts", "save", D, &["ciphertext"]),
        ("contacts", "delete", D, &[]),
        ("contacts", "get", E, &["address"]),
    ]
};

/// Methods whose environment code moves the caller's funds (it obtains the
/// caller's vault authority from `rho:deploy:data`). The call templates bind
/// no deployer authority themselves, so a wallet cannot see this in the term;
/// it must know it of the method. Wallets flag these as payments.
pub const MOVES_FUNDS: &[&str] = &["sponsors.create", "sponsors.fund", TRANSFER];

pub fn moves_funds(template: &str) -> bool {
    MOVES_FUNDS.contains(&template)
}

pub fn method_id(domain: &str, op: &str) -> String {
    format!("{domain}.{op}")
}

fn call_source(domain: &str, op: &str, kind: TemplateKind, params: &[&str]) -> String {
    let ret = match kind {
        TemplateKind::Deploy => "deployId",
        TemplateKind::Explore => "ret",
    };
    let binder = match kind {
        TemplateKind::Deploy => "deployId(`rho:system:deployId`)",
        TemplateKind::Explore => "ret",
    };
    let mut args = format!("\"{domain}\", \"{op}\"");
    for p in params {
        args.push_str(&format!(", {{{{{p}}}}}"));
    }
    format!(
        "new {binder}, rl(`rho:registry:lookup`), envCh in {{\n  rl!({{{{env_uri}}}}, *envCh) |\n  for (@(_, env) <- envCh) {{\n    @env!({args}, *{ret})\n  }}\n}}\n"
    )
}

fn build() -> Vec<Template> {
    let mut v = vec![
        Template::new(ENV, TemplateKind::Deploy, ENV_SOURCE),
        Template::new(TRANSFER, TemplateKind::Deploy, TRANSFER_SOURCE),
        Template::new(ENV_PROBE, TemplateKind::Explore, ENV_PROBE_SOURCE),
    ];
    for (domain, op, kind, params) in METHODS {
        v.push(Template::new(method_id(domain, op), *kind, call_source(domain, op, *kind, params)));
    }
    v
}

pub fn all() -> &'static [Template] {
    static CAT: OnceLock<Vec<Template>> = OnceLock::new();
    CAT.get_or_init(build)
}

pub fn get(id: &str) -> Option<&'static Template> {
    all().iter().find(|t| t.id == id)
}
