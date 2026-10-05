//! The signing policy (design §7.2) and allowances (§7.3).
//!
//! Before signing prepared bytes the wallet
//! 1. decodes them strictly as `DeployData`;
//! 2. checks the shard id, and that `phloPrice × phloLimit` is within the fee
//!    cap (and within the remaining allowance when signing without a prompt);
//! 3. recognises the term: re-renders the named template with the named
//!    values and requires byte equality, with `env_uri` pinned to the
//!    environment the wallet was configured with;
//! 4. refuses game templates that bind deployer authority;
//! 5. refuses to sign the environment deploy, and never signs the vault
//!    transfer without an explicit prompt.

use f1r3games_core::catalogue;
use f1r3games_core::deploy::{DecodeError, DeployData};
use f1r3games_core::template::{Template, TemplateError, TemplateKind};
use f1r3games_core::Value;
use std::collections::{BTreeMap, BTreeSet};

/// System names a game's template may not bind: from any of them a program
/// can reach the deployer's identity and through it the vault.
pub const FORBIDDEN_FOR_GAMES: &[&str] = &[
    "rho:system:deployerId",
    "rho:rchain:deployerId",
    "rho:system:deployerId:ops",
    "rho:deploy:data",
    "rho:vault:system",
    "rho:vault:multiSig",
    "rho:system:authKey",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    /// The portal shell itself.
    Portal,
    /// A game frame, identified by its registered game id.
    Game(String),
}

#[derive(Clone, Debug)]
pub struct SignRequest {
    pub origin: Origin,
    pub template: String,
    pub args: BTreeMap<String, Value>,
    pub prepared: Vec<u8>,
    /// The instance the request concerns, for allowance accounting.
    pub instance: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Show the person this and sign only on approval.
    Prompt { template: String, max_fee: i128, summary: String },
    /// Within an allowance: sign without prompting.
    Within { template: String, max_fee: i128, remaining_after: i128 },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PolicyError {
    #[error("prepared bytes: {0}")]
    Decode(#[from] DecodeError),
    #[error("deploy is for shard {0}, not {1}")]
    Shard(String, String),
    #[error("fee {0} exceeds the cap {1}")]
    FeeCap(i128, i128),
    #[error("unknown template {0}")]
    UnknownTemplate(String),
    #[error("template {0} is not a deploy template")]
    NotDeploy(String),
    #[error("the environment deploy is signed only by the service's own keys")]
    EnvDeploy,
    #[error("the transfer template may be signed only from the portal")]
    TransferFromGame,
    #[error("env_uri {0} is not the pinned environment {1}")]
    EnvUri(String, String),
    #[error("the term is not the template rendered with the given values")]
    TermMismatch,
    #[error("template: {0}")]
    Template(#[from] TemplateError),
    #[error("game template {0} binds forbidden system name {1}")]
    Forbidden(String, String),
    #[error("game {0} may not use template {1}")]
    NotGranted(String, String),
}

/// One allowance: within it, a game's play templates for one instance are
/// signed without prompting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allowance {
    pub game: String,
    pub instance: String,
    pub templates: BTreeSet<String>,
    pub budget: i128,
    pub spent: i128,
    /// Milliseconds since the epoch.
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub shard_id: String,
    pub env_uri: String,
    pub fee_cap: i128,
    /// Templates registered by games (from their on-chain manifests), by id.
    pub game_templates: BTreeMap<String, (String, Template)>,
    pub allowances: Vec<Allowance>,
}

impl Policy {
    pub fn new(shard_id: impl Into<String>, env_uri: impl Into<String>, fee_cap: i128) -> Policy {
        Policy {
            shard_id: shard_id.into(),
            env_uri: env_uri.into(),
            fee_cap,
            game_templates: BTreeMap::new(),
            allowances: vec![],
        }
    }

    /// Register a game's template (as listed by hash in its manifest). The
    /// source is refused if it binds deployer authority.
    pub fn register_game_template(&mut self, game: &str, template: Template, expected_hash: &str) -> Result<(), PolicyError> {
        if template.hash_hex() != expected_hash {
            return Err(PolicyError::TermMismatch);
        }
        for u in template.uris() {
            if FORBIDDEN_FOR_GAMES.contains(&u.as_str()) {
                return Err(PolicyError::Forbidden(template.id.clone(), u));
            }
        }
        self.game_templates.insert(template.id.clone(), (game.to_string(), template));
        Ok(())
    }

    pub fn grant(&mut self, a: Allowance) {
        self.allowances.retain(|x| !(x.game == a.game && x.instance == a.instance));
        self.allowances.push(a);
    }

    fn template(&self, req: &SignRequest) -> Result<&Template, PolicyError> {
        if let Some(t) = catalogue::get(&req.template) {
            if t.id == catalogue::ENV {
                return Err(PolicyError::EnvDeploy);
            }
            if t.id == catalogue::TRANSFER && req.origin != Origin::Portal {
                return Err(PolicyError::TransferFromGame);
            }
            return Ok(t);
        }
        match self.game_templates.get(&req.template) {
            Some((game, t)) => match &req.origin {
                Origin::Game(g) if g == game => Ok(t),
                Origin::Portal => Ok(t),
                Origin::Game(g) => Err(PolicyError::NotGranted(g.clone(), req.template.clone())),
            },
            None => Err(PolicyError::UnknownTemplate(req.template.clone())),
        }
    }

    /// Check a request and decide whether it needs a prompt. Does not change
    /// any allowance; [`Policy::record`] does, after signing.
    pub fn check(&self, req: &SignRequest, now_ms: i64) -> Result<(DeployData, Decision), PolicyError> {
        let d = DeployData::decode(&req.prepared)?;
        if d.shard_id != self.shard_id {
            return Err(PolicyError::Shard(d.shard_id, self.shard_id.clone()));
        }
        let fee = d.max_fee();
        if fee > self.fee_cap {
            return Err(PolicyError::FeeCap(fee, self.fee_cap));
        }
        let t = self.template(req)?;
        if t.kind != TemplateKind::Deploy {
            return Err(PolicyError::NotDeploy(t.id.clone()));
        }
        if let Some(u) = req.args.get("env_uri") {
            match u {
                Value::Uri(s) if *s == self.env_uri => {}
                Value::Uri(s) => return Err(PolicyError::EnvUri(s.clone(), self.env_uri.clone())),
                _ => return Err(PolicyError::TermMismatch),
            }
        }
        if t.render(&req.args)? != d.term {
            return Err(PolicyError::TermMismatch);
        }
        if let (Origin::Game(g), Some(inst)) = (&req.origin, &req.instance) {
            if let Some(a) = self.allowances.iter().find(|a| &a.game == g && &a.instance == inst) {
                if a.templates.contains(&t.id) && now_ms <= a.expires_at && a.spent + fee <= a.budget {
                    return Ok((
                        d,
                        Decision::Within { template: t.id.clone(), max_fee: fee, remaining_after: a.budget - a.spent - fee },
                    ));
                }
            }
        }
        let summary = summarise(&t.id, &req.args);
        Ok((d, Decision::Prompt { template: t.id.clone(), max_fee: fee, summary }))
    }

    /// Account a signature made within an allowance.
    pub fn record(&mut self, req: &SignRequest, fee: i128) {
        if let (Origin::Game(g), Some(inst)) = (&req.origin, &req.instance) {
            if let Some(a) = self.allowances.iter_mut().find(|a| &a.game == g && &a.instance == inst) {
                a.spent += fee;
            }
        }
    }
}

fn summarise(template: &str, args: &BTreeMap<String, Value>) -> String {
    let mut parts = vec![];
    for (k, v) in args {
        if k == "env_uri" {
            continue;
        }
        let shown = match v {
            Value::Bytes(b) => format!("<{} bytes>", b.len()),
            other => {
                let s = other.render().unwrap_or_else(|_| "<value>".into());
                if s.len() > 80 { format!("{}…", &s[..s.char_indices().take(80).last().map(|(i, _)| i).unwrap_or(0)]) } else { s }
            }
        };
        parts.push(format!("{k} = {shown}"));
    }
    let call = format!("{template}({})", parts.join(", "));
    if catalogue::moves_funds(template) {
        let amount = args.get("amount").and_then(Value::as_int).map(|a| a.to_string()).unwrap_or_else(|| "funds".into());
        format!("PAYMENT of {amount} from your vault: {call}")
    } else {
        call
    }
}
