//! # f1r3games-games
//!
//! The games already contemplated for F1R3Games — F1R3Pix, F1R3Beat, F1R3Ink,
//! F1R3SideChat and F1R3Skein — as registrations the portal understands.
//!
//! For each game this crate provides:
//! * its **environment** (`templates/games/<id>.rho` inside the shared
//!   `prelude.rho`): the game's live state per instance, installed under the
//!   game's own registry key and checking membership against the portal's
//!   `games` environment. Game environments read the caller's identity and
//!   never touch a vault.
//! * its **call templates**, one per method, with the environment's URI fixed
//!   in the source, so a template's hash pins the environment it calls;
//! * its **manifest** for `games.register`: name, entry, platforms, gallery
//!   kinds with preview renderers, and the templates with their hashes.
//!
//! The previous F1R3Games contracts were the research behind the methods
//! here (pixel placement, the beat grid, inking, story threads, Skein's
//! tunes and performances); their global, public-channel state is replaced by
//! per-instance state behind an environment.

use f1r3games_core::deploy::{self, DeployData, SignedDeploy};
use f1r3games_core::template::{Template, TemplateKind};
use f1r3games_core::{keyfile, registry, Value};
use k256::ecdsa::SigningKey;
use std::collections::BTreeMap;

pub const PRELUDE: &str = include_str!("../../../templates/games/prelude.rho");

#[derive(Clone, Copy, Debug)]
pub struct Method {
    pub name: &'static str,
    pub kind: TemplateKind,
    pub params: &'static [&'static str],
    /// Signed without a prompt within the allowance granted at launch.
    pub play: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Gallery {
    pub kind: &'static str,
    pub label: &'static str,
}

#[derive(Clone, Copy, Debug)]
pub struct GameSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub tagline: &'static str,
    pub platforms: &'static [&'static str],
    pub galleries: &'static [Gallery],
    pub contacts_dialogue: bool,
    pub reader_tier: bool,
    pub body: &'static str,
    pub methods: &'static [Method],
}

const D: TemplateKind = TemplateKind::Deploy;
const E: TemplateKind = TemplateKind::Explore;

const fn m(name: &'static str, kind: TemplateKind, params: &'static [&'static str], play: bool) -> Method {
    Method { name, kind, params, play }
}

pub const GAMES: &[GameSpec] = &[
    GameSpec {
        id: "f1r3pix",
        name: "F1R3Pix",
        tagline: "Paint one canvas together, pixel by pixel",
        platforms: &["web"],
        galleries: &[Gallery { kind: "canvas", label: "Canvases" }],
        contacts_dialogue: true,
        reader_tier: false,
        body: include_str!("../../../templates/games/f1r3pix.rho"),
        methods: &[m("place", D, &["instance", "x", "y", "colour"], true), m("state", E, &["instance"], false)],
    },
    GameSpec {
        id: "f1r3beat",
        name: "F1R3Beat",
        tagline: "Grow rhythms together; the ones people love reproduce",
        platforms: &["web"],
        galleries: &[Gallery { kind: "pattern", label: "Patterns" }],
        contacts_dialogue: true,
        reader_tier: false,
        body: include_str!("../../../templates/games/f1r3beat.rho"),
        methods: &[
            m("toggle", D, &["instance", "voice", "step", "on"], true),
            m("tempo", D, &["instance", "bpm"], true),
            m("state", E, &["instance"], false),
        ],
    },
    GameSpec {
        id: "f1r3ink",
        name: "F1R3Ink",
        tagline: "Colour one another with what you see in them",
        platforms: &["web"],
        galleries: &[Gallery { kind: "round", label: "Rounds" }],
        contacts_dialogue: true,
        reader_tier: false,
        body: include_str!("../../../templates/games/f1r3ink.rho"),
        methods: &[
            m("tags", D, &["instance", "tags"], true),
            m("ink", D, &["instance", "target", "colour"], true),
            m("state", E, &["instance"], false),
        ],
    },
    GameSpec {
        id: "f1r3sidechat",
        name: "F1R3SideChat",
        tagline: "Write a story together; take the wheel of a character",
        platforms: &["web"],
        galleries: &[Gallery { kind: "story", label: "Stories" }],
        contacts_dialogue: true,
        reader_tier: true,
        body: include_str!("../../../templates/games/f1r3sidechat.rho"),
        methods: &[
            m("meta", D, &["instance", "meta"], false),
            m("addCharacter", D, &["instance", "charId", "name", "role"], true),
            m("takeWheel", D, &["instance", "charId"], true),
            m("release", D, &["instance", "charId"], true),
            m("addChapter", D, &["instance", "chapter", "title"], true),
            m("write", D, &["instance", "chapter", "charId", "text"], true),
            m("publishChapter", D, &["instance", "chapter", "index"], false),
            m("comment", D, &["instance", "chapter", "text"], true),
            m("state", E, &["instance"], false),
            m("chapter", E, &["instance", "chapter"], false),
        ],
    },
    GameSpec {
        id: "f1r3skein",
        name: "F1R3Skein",
        tagline: "Play the ribbons; snip tunes from your performances",
        platforms: &["visionos", "web"],
        galleries: &[Gallery { kind: "performance", label: "Performances" }, Gallery { kind: "tune", label: "Tunes" }],
        // The Skein browser does not use the contact dialogue (design §9).
        contacts_dialogue: false,
        reader_tier: false,
        body: include_str!("../../../templates/games/f1r3skein.rho"),
        methods: &[
            m("setScale", D, &["instance", "scale"], true),
            m("setDistribution", D, &["instance", "which", "machine"], true),
            m("perform", D, &["instance", "device"], true),
            m("session", E, &["instance"], false),
        ],
    },
];

pub fn get(id: &str) -> Option<&'static GameSpec> {
    GAMES.iter().find(|g| g.id == id)
}

/// The registry URI of a game environment key.
pub fn env_uri(env_key: &SigningKey) -> String {
    registry::uri_for_public_key(&keyfile::public_key_bytes(env_key))
}

impl GameSpec {
    /// The environment deploy's template (holes: env_uri, version,
    /// public_key, sig, portal_env).
    pub fn env_template(&self) -> Template {
        let src = PRELUDE.replace("/*@BODY@*/", self.body).replace("/*@GAME@*/", self.id);
        Template::new(format!("{}.env", self.id), TemplateKind::Deploy, src)
    }

    pub fn template_id(&self, method: &str) -> String {
        format!("{}.{}", self.id, method)
    }

    /// A call template with the game environment's URI fixed in the source.
    pub fn call_template(&self, m: &Method, env_uri: &str) -> Template {
        let uri = Value::Uri(env_uri.to_string()).render().expect("a registry URI renders");
        let (binder, ret) = match m.kind {
            TemplateKind::Deploy => ("deployId(`rho:system:deployId`)", "deployId"),
            TemplateKind::Explore => ("ret", "ret"),
        };
        let mut args = format!("\"{}\"", m.name);
        for p in m.params {
            args.push_str(&format!(", {{{{{p}}}}}"));
        }
        Template::new(
            self.template_id(m.name),
            m.kind,
            format!("new {binder}, rl(`rho:registry:lookup`), envCh in {{\n  rl!({uri}, *envCh) |\n  for (@(_, env) <- envCh) {{\n    @env!({args}, *{ret})\n  }}\n}}\n"),
        )
    }

    pub fn templates(&self, env_uri: &str) -> Vec<(Template, bool)> {
        self.methods.iter().map(|m| (self.call_template(m, env_uri), m.play)).collect()
    }

    /// The manifest for `games.register`, as a typed value.
    /// `entry_base` hosts the game clients: `<entry_base>/<id>/` and
    /// `<entry_base>/<id>/preview/<kind>.html`.
    pub fn manifest(&self, env_uri: &str, entry_base: &str) -> Value {
        let base = entry_base.trim_end_matches('/');
        let templates = self
            .templates(env_uri)
            .into_iter()
            .map(|(t, play)| {
                Value::map([
                    ("id", Value::str(t.id.clone())),
                    ("kind", Value::str(match t.kind { TemplateKind::Deploy => "deploy", TemplateKind::Explore => "explore" })),
                    ("hash", Value::str(t.hash_hex())),
                    ("source", Value::str(t.source.clone())),
                    ("play", Value::Bool(play)),
                ])
            })
            .collect();
        Value::map([
            ("id", Value::str(self.id)),
            ("name", Value::str(self.name)),
            ("tagline", Value::str(self.tagline)),
            ("entry", Value::str(format!("{base}/{}/", self.id))),
            ("platforms", Value::List(self.platforms.iter().map(|p| Value::str(*p)).collect())),
            (
                "galleries",
                Value::List(
                    self.galleries
                        .iter()
                        .map(|g| Value::map([("kind", Value::str(g.kind)), ("label", Value::str(g.label)), ("renderer", Value::str(format!("{base}/{}/preview/{}.html", self.id, g.kind)))]))
                        .collect(),
                ),
            ),
            ("templates", Value::List(templates)),
            ("contactsDialogue", Value::Bool(self.contacts_dialogue)),
            ("readerTier", Value::Bool(self.reader_tier)),
            ("envUri", Value::str(env_uri)),
            ("protocol", Value::Int(f1r3games_core::PROTOCOL_VERSION as i64)),
        ])
    }

    /// Render and sign the environment deploy: signed by the service key
    /// (which pays), with the insertSigned signature by the game's key.
    #[allow(clippy::too_many_arguments)]
    pub fn env_deploy(
        &self,
        env_key: &SigningKey,
        service_key: &SigningKey,
        portal_env_uri: &str,
        version: i64,
        timestamp: i64,
        valid_after: i64,
        shard_id: &str,
        phlo_price: i64,
        phlo_limit: i64,
        ttl_ms: i64,
    ) -> SignedDeploy {
        let service_pk = keyfile::public_key_bytes(service_key);
        let mut args = BTreeMap::new();
        args.insert("env_uri".to_string(), Value::Uri(env_uri(env_key)));
        args.insert("version".to_string(), Value::Int(version));
        args.insert("public_key".to_string(), Value::Bytes(keyfile::public_key_bytes(env_key)));
        args.insert("sig".to_string(), Value::Bytes(registry::insert_signed_signature(env_key, timestamp, &service_pk, version)));
        args.insert("portal_env".to_string(), Value::Uri(portal_env_uri.to_string()));
        let term = self.env_template().render(&args).expect("game environment renders");
        deploy::sign(
            service_key,
            DeployData {
                term,
                timestamp,
                phlo_price,
                phlo_limit,
                valid_after_block_number: valid_after,
                shard_id: shard_id.to_string(),
                expiration_timestamp: Some(timestamp + ttl_ms),
            },
        )
    }
}

/// The key file name for a game's environment key in a keys directory.
pub fn key_file_name(id: &str) -> String {
    format!("{id}-env-key.json")
}
