//! Rholang templates.
//!
//! A template is Rholang source with `{{name}}` holes. Rendering fills every
//! hole with a typed [`Value`] and nothing else: every hole must be bound and
//! every binding must name a hole. A template's identity is the BLAKE2b-256 of
//! its source, so a wallet can recognise a prepared term by re-rendering the
//! named template with the named values and comparing bytes.

use crate::hash::blake2b256;
use crate::rho::{RhoError, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateKind {
    /// Signed and deployed to a validator.
    Deploy,
    /// Run read-only on an observer (`POST /api/explore-deploy`).
    Explore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Template {
    pub id: String,
    pub kind: TemplateKind,
    pub source: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TemplateError {
    #[error("unknown template {0}")]
    Unknown(String),
    #[error("hole {{{{{0}}}}} is not bound")]
    Unbound(String),
    #[error("{0} names no hole in the template")]
    Extra(String),
    #[error("argument {0}: {1}")]
    Value(String, RhoError),
    #[error("unterminated hole")]
    Unterminated,
}

impl Template {
    pub fn new(id: impl Into<String>, kind: TemplateKind, source: impl Into<String>) -> Template {
        Template { id: id.into(), kind, source: source.into() }
    }

    pub fn hash(&self) -> [u8; 32] {
        blake2b256(self.source.as_bytes())
    }

    pub fn hash_hex(&self) -> String {
        hex::encode(self.hash())
    }

    /// The names of the holes, in order of first appearance.
    pub fn holes(&self) -> Result<Vec<String>, TemplateError> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut rest = self.source.as_str();
        while let Some(i) = rest.find("{{") {
            let after = &rest[i + 2..];
            let j = after.find("}}").ok_or(TemplateError::Unterminated)?;
            let name = after[..j].trim().to_string();
            if seen.insert(name.clone()) {
                out.push(name);
            }
            rest = &after[j + 2..];
        }
        Ok(out)
    }

    pub fn render(&self, args: &BTreeMap<String, Value>) -> Result<String, TemplateError> {
        let holes: BTreeSet<String> = self.holes()?.into_iter().collect();
        for k in args.keys() {
            if !holes.contains(k) {
                return Err(TemplateError::Extra(k.clone()));
            }
        }
        let mut out = String::with_capacity(self.source.len() + 256);
        let mut rest = self.source.as_str();
        while let Some(i) = rest.find("{{") {
            out.push_str(&rest[..i]);
            let after = &rest[i + 2..];
            let j = after.find("}}").ok_or(TemplateError::Unterminated)?;
            let name = after[..j].trim();
            let v = args.get(name).ok_or_else(|| TemplateError::Unbound(name.to_string()))?;
            out.push_str(&v.render().map_err(|e| TemplateError::Value(name.to_string(), e))?);
            rest = &after[j + 2..];
        }
        out.push_str(rest);
        Ok(out)
    }

    /// The system names (`` `rho:...` `` URIs) the source binds.
    pub fn uris(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let mut rest = self.source.as_str();
        while let Some(i) = rest.find("`rho:") {
            let after = &rest[i + 1..];
            if let Some(j) = after.find('`') {
                out.insert(after[..j].to_string());
                rest = &after[j + 1..];
            } else {
                break;
            }
        }
        out
    }
}
