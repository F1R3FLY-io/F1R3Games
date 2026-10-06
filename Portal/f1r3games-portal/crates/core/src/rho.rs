//! Typed Rholang values.
//!
//! Rendering follows Embers' `firefly-client` (`rendering.rs`): strings are
//! double-quoted with `\` and `"` escaped, bytes become `"<hex>".hexToBytes()`,
//! URIs are back-quoted, collections are comma-separated. Two tightenings:
//! strings containing control characters are refused (how the parser treats
//! a raw newline inside a literal is not something the portal relies on), and
//! one-element tuples render as `(x,)`. There is no "inline" variant: nothing
//! a person types ever reaches a template except as a literal.
//!
//! [`Value::from_rho_expr`] decodes the node's `RhoExpr` JSON
//! (`docs/node/README.md`, "Rholang Type System").

use serde_json::{json, Map as JsonMap, Value as Json};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Value {
    Nil,
    Bool(bool),
    Int(i64),
    String(String),
    Bytes(Vec<u8>),
    Uri(String),
    Tuple(Vec<Value>),
    List(Vec<Value>),
    Set(BTreeSet<Value>),
    Map(BTreeMap<String, Value>),
    /// Read-only: an unforgeable name returned by the node (hex). Never
    /// rendered.
    Unforgeable(String),
    /// Read-only: anything else the node returned. Never rendered.
    Opaque(String),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RhoError {
    #[error("strings may not contain control characters")]
    ControlCharacter,
    #[error("URI is not of the form rho:...")]
    BadUri,
    #[error("value cannot be rendered: {0}")]
    NotRenderable(&'static str),
    #[error("malformed typed JSON: {0}")]
    TypedJson(String),
    #[error("malformed RhoExpr: {0}")]
    RhoExpr(String),
}

fn escape(s: &str) -> Result<String, RhoError> {
    if s.chars().any(|c| c.is_control()) {
        return Err(RhoError::ControlCharacter);
    }
    Ok(s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Undo [`escape`]. F1R3Node-Rust keeps a string literal's text verbatim
/// (it does not process `\"` or `\\` escapes), so a string written with
/// quotes inside it comes back from the shard with the backslashes still in it.
/// Readers that check a hash (game template sources) try the text as read and,
/// failing that, this unescaped form.
pub fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some(n @ ('"' | '\\')) => out.push(n),
                Some(n) => {
                    out.push('\\');
                    out.push(n)
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c)
        }
    }
    out
}

impl Value {
    pub fn str(s: impl Into<String>) -> Value {
        Value::String(s.into())
    }

    pub fn map<K: Into<String>>(kv: impl IntoIterator<Item = (K, Value)>) -> Value {
        Value::Map(kv.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    pub fn render(&self) -> Result<String, RhoError> {
        let mut out = String::new();
        self.render_into(&mut out)?;
        Ok(out)
    }

    fn render_seq(items: &[&Value], out: &mut String) -> Result<(), RhoError> {
        for (i, v) in items.iter().enumerate() {
            if i > 0 {
                out.push_str(", ");
            }
            v.render_into(out)?;
        }
        Ok(())
    }

    fn render_into(&self, out: &mut String) -> Result<(), RhoError> {
        match self {
            Value::Nil => out.push_str("Nil"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Int(n) => write!(out, "{n}").unwrap(),
            Value::String(s) => write!(out, "\"{}\"", escape(s)?).unwrap(),
            Value::Bytes(b) => write!(out, "\"{}\".hexToBytes()", hex::encode(b)).unwrap(),
            Value::Uri(u) => {
                if !u.starts_with("rho:") || !u.chars().all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '.' || c == '_' || c == '-') {
                    return Err(RhoError::BadUri);
                }
                write!(out, "`{u}`").unwrap()
            }
            Value::Tuple(vs) => {
                out.push('(');
                Self::render_seq(&vs.iter().collect::<Vec<_>>(), out)?;
                if vs.len() == 1 {
                    out.push(',');
                }
                out.push(')');
            }
            Value::List(vs) => {
                out.push('[');
                Self::render_seq(&vs.iter().collect::<Vec<_>>(), out)?;
                out.push(']');
            }
            Value::Set(vs) => {
                out.push_str("Set(");
                Self::render_seq(&vs.iter().collect::<Vec<_>>(), out)?;
                out.push(')');
            }
            Value::Map(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    write!(out, "\"{}\": ", escape(k)?).unwrap();
                    v.render_into(out)?;
                }
                out.push('}');
            }
            Value::Unforgeable(_) => return Err(RhoError::NotRenderable("unforgeable name")),
            Value::Opaque(_) => return Err(RhoError::NotRenderable("opaque value")),
        }
        Ok(())
    }

    // ---- typed JSON: the wire form of arguments between client, service and wallet

    /// `null`, booleans, integers, strings and arrays (lists) are themselves;
    /// `{"bytes":hex}`, `{"uri":s}`, `{"tuple":[..]}`, `{"set":[..]}`,
    /// `{"map":{..}}`, `{"unforgeable":hex}`, `{"opaque":s}` are tagged.
    pub fn to_typed_json(&self) -> Json {
        match self {
            Value::Nil => Json::Null,
            Value::Bool(b) => json!(b),
            Value::Int(n) => json!(n),
            Value::String(s) => json!(s),
            Value::Bytes(b) => json!({ "bytes": hex::encode(b) }),
            Value::Uri(u) => json!({ "uri": u }),
            Value::Tuple(vs) => json!({ "tuple": vs.iter().map(|v| v.to_typed_json()).collect::<Vec<_>>() }),
            Value::List(vs) => Json::Array(vs.iter().map(|v| v.to_typed_json()).collect()),
            Value::Set(vs) => json!({ "set": vs.iter().map(|v| v.to_typed_json()).collect::<Vec<_>>() }),
            Value::Map(m) => {
                let mut o = JsonMap::new();
                for (k, v) in m {
                    o.insert(k.clone(), v.to_typed_json());
                }
                json!({ "map": Json::Object(o) })
            }
            Value::Unforgeable(h) => json!({ "unforgeable": h }),
            Value::Opaque(s) => json!({ "opaque": s }),
        }
    }

    pub fn from_typed_json(j: &Json) -> Result<Value, RhoError> {
        let bad = |m: &str| RhoError::TypedJson(m.to_string());
        Ok(match j {
            Json::Null => Value::Nil,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::Int(n.as_i64().ok_or_else(|| bad("only 64-bit integers"))?),
            Json::String(s) => Value::String(s.clone()),
            Json::Array(a) => Value::List(a.iter().map(Value::from_typed_json).collect::<Result<_, _>>()?),
            Json::Object(o) => {
                if o.len() != 1 {
                    return Err(bad("a tagged value has exactly one key"));
                }
                let (k, v) = o.iter().next().unwrap();
                match (k.as_str(), v) {
                    ("bytes", Json::String(h)) => Value::Bytes(hex::decode(h).map_err(|_| bad("bytes must be hex"))?),
                    ("uri", Json::String(u)) => Value::Uri(u.clone()),
                    ("tuple", Json::Array(a)) => Value::Tuple(a.iter().map(Value::from_typed_json).collect::<Result<_, _>>()?),
                    ("set", Json::Array(a)) => Value::Set(a.iter().map(Value::from_typed_json).collect::<Result<_, _>>()?),
                    ("map", Json::Object(m)) => Value::Map(
                        m.iter()
                            .map(|(k, v)| Ok((k.clone(), Value::from_typed_json(v)?)))
                            .collect::<Result<_, RhoError>>()?,
                    ),
                    ("unforgeable", Json::String(h)) => Value::Unforgeable(h.clone()),
                    ("opaque", Json::String(s)) => Value::Opaque(s.clone()),
                    _ => return Err(bad("unknown tag")),
                }
            }
        })
    }

    // ---- reading the node's RhoExpr JSON

    pub fn from_rho_expr(j: &Json) -> Result<Value, RhoError> {
        let bad = |m: String| RhoError::RhoExpr(m);
        let Json::Object(o) = j else { return Err(bad(format!("not an object: {j}"))) };
        let Some((k, v)) = o.iter().next() else { return Err(bad("empty object".into())) };
        let data = v.get("data");
        let list = |d: Option<&Json>| -> Result<Vec<Value>, RhoError> {
            match d {
                Some(Json::Array(a)) => a.iter().map(Value::from_rho_expr).collect(),
                _ => Err(RhoError::RhoExpr(format!("{k}: data is not a list"))),
            }
        };
        Ok(match k.as_str() {
            "ExprBool" => Value::Bool(data.and_then(Json::as_bool).ok_or_else(|| bad("ExprBool".into()))?),
            "ExprInt" => Value::Int(data.and_then(Json::as_i64).ok_or_else(|| bad("ExprInt".into()))?),
            "ExprString" => Value::String(data.and_then(Json::as_str).ok_or_else(|| bad("ExprString".into()))?.to_string()),
            "ExprUri" => Value::Uri(data.and_then(Json::as_str).ok_or_else(|| bad("ExprUri".into()))?.to_string()),
            "ExprBytes" => Value::Bytes(
                hex::decode(data.and_then(Json::as_str).ok_or_else(|| bad("ExprBytes".into()))?)
                    .map_err(|_| bad("ExprBytes: not hex".into()))?,
            ),
            "ExprTuple" => Value::Tuple(list(data)?),
            "ExprList" => Value::List(list(data)?),
            "ExprSet" => Value::Set(list(data)?.into_iter().collect()),
            "ExprPar" => {
                let mut items = list(data)?;
                if items.len() == 1 {
                    items.pop().unwrap()
                } else if items.is_empty() {
                    Value::Nil
                } else {
                    Value::Opaque(j.to_string())
                }
            }
            "ExprMap" => match data {
                Some(Json::Object(m)) => Value::Map(
                    m.iter()
                        .map(|(k, v)| Ok((k.clone(), Value::from_rho_expr(v)?)))
                        .collect::<Result<_, RhoError>>()?,
                ),
                _ => return Err(bad("ExprMap: data is not an object".into())),
            },
            "ExprUnforg" => {
                let inner = data.and_then(|d| d.as_object()).and_then(|m| m.values().next());
                match inner.and_then(|i| i.get("data")).and_then(Json::as_str) {
                    Some(h) => Value::Unforgeable(h.to_string()),
                    None => Value::Opaque(j.to_string()),
                }
            }
            "ExprNil" => Value::Nil,
            _ => Value::Opaque(j.to_string()),
        })
    }

    // ---- accessors for reading results

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(m) => m.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Value::Int(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The portal's methods answer `(true, value)` or `(false, reason)`.
    ///
    /// F1R3Node-Rust's web API drops Nil from tuples and lists when it renders
    /// a result as JSON (`expr_from_par_proto` maps an empty Par to nothing, and
    /// tuples and lists `filter_map` over their elements), so `(true, Nil)`
    /// arrives as `(true)`. A one-element outcome therefore means a Nil value.
    pub fn into_outcome(self) -> Result<Value, String> {
        match self {
            Value::Tuple(v) if v.len() == 1 => match v[0] {
                Value::Bool(true) => Ok(Value::Nil),
                Value::Bool(false) => Err("refused".into()),
                ref other => Err(format!("unexpected outcome flag {other:?}")),
            },
            Value::Tuple(mut v) if v.len() == 2 => {
                let value = v.pop().unwrap();
                match v.pop().unwrap() {
                    Value::Bool(true) => Ok(value),
                    Value::Bool(false) => Err(value.as_str().map(str::to_string).unwrap_or_else(|| format!("{value:?}"))),
                    other => Err(format!("unexpected outcome flag {other:?}")),
                }
            }
            other => Err(format!("unexpected outcome {other:?}")),
        }
    }
}

#[cfg(test)]
mod unescape_tests {
    #[test]
    fn unescape_inverts_escape() {
        for s in ["@env!(\"seat\", {{instance}})", "a\\b", "plain", "\\\"", "tail\\"] {
            assert_eq!(super::unescape(&super::escape(s).unwrap()), s);
        }
        assert_eq!(super::unescape("no escapes here"), "no escapes here");
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::Value;

    #[test]
    fn a_nil_value_dropped_by_the_node_reads_as_nil() {
        assert_eq!(Value::Tuple(vec![Value::Bool(true)]).into_outcome(), Ok(Value::Nil));
        assert_eq!(Value::Tuple(vec![Value::Bool(false)]).into_outcome(), Err("refused".to_string()));
        assert_eq!(Value::Tuple(vec![Value::Bool(true), Value::Int(3)]).into_outcome(), Ok(Value::Int(3)));
        assert!(Value::Tuple(vec![Value::Int(1)]).into_outcome().is_err());
        assert!(Value::Int(1).into_outcome().is_err());
    }
}
