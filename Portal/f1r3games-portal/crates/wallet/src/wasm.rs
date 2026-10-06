//! Browser bindings (feature `wasm`), the portal shell's `wallet` capability.
//!
//! The shell keeps the keystore JSON and the contact-book ciphertext in
//! IndexedDB, obtains passkey PRF outputs from WebAuthn, and calls these
//! functions. Private keys never cross into JavaScript, except as the key
//! file the person explicitly exports. Byte strings cross as hex.
//!
//! Every function answers a result or throws a string; the shell wraps them
//! in its `("ok", value) | ("err", code, message)` capability convention.

use crate::contacts::ContactBook;
use crate::keystore::Keystore;
use crate::policy::{Allowance, Origin, Policy, SignRequest};
use crate::wallet::{Consent, Wallet};
use f1r3games_core::invite::{self, InviteKey};
use f1r3games_core::template::{Template, TemplateKind};
use f1r3games_core::{keyfile, Address, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

thread_local! {
    static WALLET: RefCell<Option<Wallet>> = const { RefCell::new(None) };
}

fn err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn unhex(s: &str) -> Result<Vec<u8>, JsValue> {
    hex::decode(s).map_err(|_| JsValue::from_str("expected hex"))
}

fn with<T>(f: impl FnOnce(&mut Wallet) -> Result<T, JsValue>) -> Result<T, JsValue> {
    WALLET.with(|w| match w.borrow_mut().as_mut() {
        Some(w) => f(w),
        None => Err(JsValue::from_str("no keystore is open")),
    })
}

fn json(v: serde_json::Value) -> String {
    v.to_string()
}

/// Create a keystore protected by `passphrase`, with a first key. Returns
/// `{keystore, address, keyFile}`; the shell offers `keyFile` for download.
#[wasm_bindgen(js_name = createKeystore)]
pub fn create_keystore(passphrase: &str, iterations: u32, shard_id: &str, env_uri: &str, fee_cap: f64) -> Result<String, JsValue> {
    let (ks, u) = Keystore::create(passphrase, iterations);
    let mut w = Wallet::new(ks, Policy::new(shard_id, env_uri, fee_cap as i128));
    w.adopt_unlocked(u);
    let (address, key_file) = w.create_key("main").map_err(err)?;
    let out = json(serde_json::json!({ "keystore": w.keystore.to_json(), "address": address, "keyFile": key_file }));
    WALLET.with(|c| *c.borrow_mut() = Some(w));
    Ok(out)
}

/// Create a keystore around an existing key file (import path).
#[wasm_bindgen(js_name = importKeystore)]
pub fn import_keystore(passphrase: &str, iterations: u32, key_file: &str, shard_id: &str, env_uri: &str, fee_cap: f64) -> Result<String, JsValue> {
    let (ks, u) = Keystore::create(passphrase, iterations);
    let mut w = Wallet::new(ks, Policy::new(shard_id, env_uri, fee_cap as i128));
    w.adopt_unlocked(u);
    let address = w.import_key_file(key_file, "imported").map_err(err)?;
    let out = json(serde_json::json!({ "keystore": w.keystore.to_json(), "address": address }));
    WALLET.with(|c| *c.borrow_mut() = Some(w));
    Ok(out)
}

/// Open a stored keystore (locked).
#[wasm_bindgen(js_name = openKeystore)]
pub fn open_keystore(keystore_json: &str, shard_id: &str, env_uri: &str, fee_cap: f64) -> Result<(), JsValue> {
    let ks = Keystore::from_json(keystore_json).map_err(err)?;
    WALLET.with(|c| *c.borrow_mut() = Some(Wallet::new(ks, Policy::new(shard_id, env_uri, fee_cap as i128))));
    Ok(())
}

#[wasm_bindgen(js_name = keystoreJson)]
pub fn keystore_json() -> Result<String, JsValue> {
    with(|w| Ok(w.keystore.to_json()))
}

#[wasm_bindgen(js_name = unlockWithPassphrase)]
pub fn unlock_with_passphrase(passphrase: &str) -> Result<(), JsValue> {
    with(|w| w.unlock_with_passphrase(passphrase).map_err(err))
}

#[wasm_bindgen(js_name = unlockWithPasskey)]
pub fn unlock_with_passkey(credential_id: &str, prf_output_hex: &str) -> Result<(), JsValue> {
    let prf = unhex(prf_output_hex)?;
    with(|w| w.unlock_with_passkey(credential_id, &prf).map_err(err))
}

/// Enrol a passkey, proving knowledge of the passphrase.
#[wasm_bindgen(js_name = enrolPasskey)]
pub fn enrol_passkey(passphrase: &str, credential_id: &str, prf_output_hex: &str) -> Result<(), JsValue> {
    let prf = unhex(prf_output_hex)?;
    with(|w| {
        let u = w.keystore.unlock_with_passphrase(passphrase).map_err(err)?;
        w.keystore.add_passkey(&u, credential_id, &prf);
        Ok(())
    })
}

#[wasm_bindgen(js_name = passkeys)]
pub fn passkeys() -> Result<Vec<String>, JsValue> {
    with(|w| Ok(w.keystore.passkeys()))
}

#[wasm_bindgen]
pub fn lock() -> Result<(), JsValue> {
    with(|w| {
        w.lock();
        Ok(())
    })
}

#[wasm_bindgen(js_name = isUnlocked)]
pub fn is_unlocked() -> bool {
    WALLET.with(|c| c.borrow().as_ref().map(|w| w.is_unlocked()).unwrap_or(false))
}

/// `[{address, label, active}]` as JSON.
#[wasm_bindgen(js_name = listKeys)]
pub fn list_keys() -> Result<String, JsValue> {
    with(|w| {
        let active = w.keystore.active.clone();
        Ok(json(serde_json::Value::Array(
            w.keystore
                .entries
                .iter()
                .map(|e| serde_json::json!({ "address": e.address, "label": e.label, "active": Some(&e.address) == active.as_ref() }))
                .collect(),
        )))
    })
}

/// Create another key; returns `{address, keyFile}`.
#[wasm_bindgen(js_name = createKey)]
pub fn create_key(label: &str) -> Result<String, JsValue> {
    with(|w| w.create_key(label).map(|(a, f)| json(serde_json::json!({ "address": a, "keyFile": f }))).map_err(err))
}

#[wasm_bindgen(js_name = importKeyFile)]
pub fn import_key_file(text: &str, label: &str) -> Result<String, JsValue> {
    with(|w| w.import_key_file(text, label).map(|a| a.to_string()).map_err(err))
}

#[wasm_bindgen(js_name = setActive)]
pub fn set_active(address: &str) -> Result<(), JsValue> {
    with(|w| w.keystore.set_active(address).map_err(err))
}

/// Export the key file (re-authenticating with the passphrase).
#[wasm_bindgen(js_name = exportKeyFile)]
pub fn export_key_file(passphrase: &str, address: &str) -> Result<String, JsValue> {
    with(|w| {
        let u = w.keystore.unlock_with_passphrase(passphrase).map_err(err)?;
        Ok(w.keystore.export_key_file(&u, address).map_err(err)?.to_string())
    })
}

#[wasm_bindgen(js_name = activeAddress)]
pub fn active_address() -> Result<String, JsValue> {
    with(|w| w.active_address().map(|a| a.to_string()).map_err(err))
}

#[wasm_bindgen(js_name = activePublicKey)]
pub fn active_public_key() -> Result<String, JsValue> {
    with(|w| w.active_public_key_hex().map_err(err))
}

#[wasm_bindgen(js_name = isAddress)]
pub fn is_address(s: &str) -> bool {
    Address::parse(s).is_ok()
}

// ------------------------------------------------------------- policy

/// Register a game's template, as listed (by hash) in its on-chain manifest.
#[wasm_bindgen(js_name = registerGameTemplate)]
pub fn register_game_template(game: &str, id: &str, source: &str, expected_hash: &str) -> Result<(), JsValue> {
    with(|w| {
        w.policy
            .register_game_template(game, Template::new(id, TemplateKind::Deploy, source), expected_hash)
            .map_err(err)
    })
}

/// Grant an allowance for a game instance.
#[wasm_bindgen(js_name = grantAllowance)]
pub fn grant_allowance(game: &str, instance: &str, templates_json: &str, budget: f64, expires_at_ms: f64) -> Result<(), JsValue> {
    let templates: Vec<String> = serde_json::from_str(templates_json).map_err(err)?;
    with(|w| {
        w.policy.grant(Allowance {
            game: game.into(),
            instance: instance.into(),
            templates: templates.into_iter().collect(),
            budget: budget as i128,
            spent: 0,
            expires_at: expires_at_ms as i64,
        });
        Ok(())
    })
}

/// `[{game, instance, budget, spent, expiresAt}]`.
#[wasm_bindgen]
pub fn allowances() -> Result<String, JsValue> {
    with(|w| {
        Ok(json(serde_json::Value::Array(
            w.policy
                .allowances
                .iter()
                .map(|a| serde_json::json!({ "game": a.game, "instance": a.instance, "budget": a.budget as f64, "spent": a.spent as f64, "expiresAt": a.expires_at }))
                .collect(),
        )))
    })
}

fn request(origin: &str, template: &str, args_json: &str, prepared_hex: &str, instance: Option<String>) -> Result<SignRequest, JsValue> {
    let args: serde_json::Value = serde_json::from_str(args_json).map_err(err)?;
    let obj = args.as_object().ok_or_else(|| JsValue::from_str("args must be an object"))?;
    let mut map = BTreeMap::new();
    for (k, v) in obj {
        map.insert(k.clone(), Value::from_typed_json(v).map_err(err)?);
    }
    Ok(SignRequest {
        origin: if origin == "portal" { Origin::Portal } else { Origin::Game(origin.to_string()) },
        template: template.to_string(),
        args: map,
        prepared: unhex(prepared_hex)?,
        instance,
    })
}

/// Review a request. Returns `{kind: "prompt"|"within", template, maxFee,
/// summary?, remainingAfter?}`; throws if the policy refuses it.
#[wasm_bindgen]
pub fn review(origin: &str, template: &str, args_json: &str, prepared_hex: &str, instance: Option<String>, now_ms: f64) -> Result<String, JsValue> {
    let req = request(origin, template, args_json, prepared_hex, instance)?;
    with(|w| {
        Ok(match w.review(&req, now_ms as i64).map_err(err)? {
            crate::policy::Decision::Prompt { template, max_fee, summary } => {
                json(serde_json::json!({ "kind": "prompt", "template": template, "maxFee": max_fee as f64, "summary": summary }))
            }
            crate::policy::Decision::Within { template, max_fee, remaining_after } => {
                json(serde_json::json!({ "kind": "within", "template": template, "maxFee": max_fee as f64, "remainingAfter": remaining_after as f64 }))
            }
        })
    })
}

/// Sign after review; `approved` is the person's answer to any prompt.
/// Returns `{deployer, signature}` (hex).
#[wasm_bindgen]
pub fn sign(origin: &str, template: &str, args_json: &str, prepared_hex: &str, instance: Option<String>, approved: bool, now_ms: f64) -> Result<String, JsValue> {
    let req = request(origin, template, args_json, prepared_hex, instance)?;
    with(|w| {
        let s = w
            .sign(&req, if approved { Consent::Approved } else { Consent::Refused }, now_ms as i64)
            .map_err(err)?;
        Ok(json(serde_json::json!({ "deployer": hex::encode(&s.deployer), "signature": hex::encode(&s.sig) })))
    })
}

// ------------------------------------------------------------- invitations

/// A fresh invitation key and its link: `{publicKey, link}`.
/// Open a message envelope (hex) addressed to the active key. The host passes
/// the hosted game's id and instance (F1R3Pix design R3). Returns {sender, text}.
#[wasm_bindgen(js_name = openEnvelope)]
pub fn open_envelope(game: &str, instance: &str, envelope_hex: &str) -> Result<String, JsValue> {
    let b = unhex(envelope_hex)?;
    with(|w| {
        let (sender, pt) = w.open_envelope(game, instance, &b).map_err(err)?;
        let text = String::from_utf8(pt).map_err(|_| JsValue::from_str("the message is not text"))?;
        Ok(json(serde_json::json!({ "sender": sender, "text": text })))
    })
}

#[wasm_bindgen(js_name = newInvitation)]
pub fn new_invitation(base_url: &str, instance_id: &str) -> String {
    let k = InviteKey::generate();
    json(serde_json::json!({ "publicKey": hex::encode(k.public_key()), "link": k.link(base_url, instance_id, None) }))
}

/// Parse an invitation link and sign its redemption for the active address:
/// `{instanceId, invitePublicKey, signature, fundedKeyFile?}`.
#[wasm_bindgen(js_name = redeemInvitation)]
pub fn redeem_invitation(link: &str) -> Result<String, JsValue> {
    let p = invite::parse_link(link).map_err(err)?;
    with(|w| {
        let sig = w.redemption_signature(&p.invite_key).map_err(err)?;
        Ok(json(serde_json::json!({
            "instanceId": p.instance_id,
            "invitePublicKey": hex::encode(p.invite_key.public_key()),
            "signature": hex::encode(sig),
            "fundedKeyFile": p.funded_key.as_ref().map(keyfile::serialize),
        })))
    })
}

/// The instance an invitation link names, without the wallet.
#[wasm_bindgen(js_name = invitationInstance)]
pub fn invitation_instance(link: &str) -> Result<String, JsValue> {
    invite::parse_link(link).map(|p| p.instance_id).map_err(err)
}

// ------------------------------------------------------------- contacts

#[wasm_bindgen(js_name = contactsEncrypt)]
pub fn contacts_encrypt(book_json: &str) -> Result<String, JsValue> {
    let book: ContactBook = serde_json::from_str(book_json).map_err(err)?;
    with(|w| Ok(hex::encode(book.encrypt(&w.active_key().map_err(err)?))))
}

#[wasm_bindgen(js_name = contactsDecrypt)]
pub fn contacts_decrypt(cipher_hex: &str) -> Result<String, JsValue> {
    let ct = unhex(cipher_hex)?;
    with(|w| {
        let book = ContactBook::decrypt(&w.active_key().map_err(err)?, &ct).map_err(err)?;
        Ok(serde_json::to_string(&book).unwrap())
    })
}

/// Import CSV (`name,kind,handle`) or vCard text into a book: returns
/// `{book, rejected}`.
#[wasm_bindgen(js_name = contactsImport)]
pub fn contacts_import(book_json: &str, format: &str, text: &str, now_ms: f64) -> Result<String, JsValue> {
    let mut book: ContactBook = serde_json::from_str(book_json).map_err(err)?;
    let rejected = match format {
        "csv" => book.import_csv(text, now_ms as i64),
        "vcard" => {
            book.import_vcard(text, now_ms as i64);
            vec![]
        }
        _ => return Err(JsValue::from_str("format is csv or vcard")),
    };
    Ok(json(serde_json::json!({ "book": book, "rejected": rejected })))
}
