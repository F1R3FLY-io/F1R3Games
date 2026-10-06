//! Envelopes sealed by the JavaScript client open in the Rust wallet, only
//! for their recipients and only under the game and instance they were made
//! for; and payments are signed only from the portal, always with a prompt.

use f1r3games_core::deploy::DeployData;
use f1r3games_core::template::Template;
use f1r3games_core::{catalogue, keyfile, Value};
use f1r3games_wallet::envelope::{self, EnvelopeError};
use f1r3games_wallet::keystore::Keystore;
use f1r3games_wallet::policy::{Allowance, Decision, Origin, Policy, PolicyError, SignRequest};
use f1r3games_wallet::wallet::{Wallet, WalletError};
use k256::ecdsa::SigningKey;
use std::collections::{BTreeMap, BTreeSet};

const ENV: &str = "rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j";

fn vectors() -> serde_json::Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../F1R3Pix/vectors/pix-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn key(hex_sk: &str) -> SigningKey {
    SigningKey::from_slice(&hex::decode(hex_sk).unwrap()).unwrap()
}

#[test]
fn the_clients_sealed_vector_opens_for_each_party() {
    let v = vectors();
    let e = &v["envelope"];
    let (game, instance, bytes) = (e["game"].as_str().unwrap(), e["instance"].as_str().unwrap(), hex::decode(e["hex"].as_str().unwrap()).unwrap());
    for (address, sk) in e["keys"].as_object().unwrap() {
        let (sender, pt) = envelope::open(game, instance, address, &key(sk.as_str().unwrap()), &bytes).unwrap();
        assert_eq!(sender, e["sender"].as_str().unwrap());
        assert_eq!(String::from_utf8(pt).unwrap(), e["text"].as_str().unwrap());
    }
    // The wire form round-trips byte for byte.
    assert_eq!(envelope::Envelope::from_bytes(&bytes).unwrap().to_bytes(), bytes);
}

#[test]
fn envelopes_bind_their_game_and_instance_and_refuse_strangers() {
    let v = vectors();
    let e = &v["envelope"];
    let bytes = hex::decode(e["hex"].as_str().unwrap()).unwrap();
    let (address, sk) = e["keys"].as_object().unwrap().iter().nth(1).unwrap();
    let k = key(sk.as_str().unwrap());
    let inst = e["instance"].as_str().unwrap();
    assert_eq!(envelope::open("f1r3ink", inst, address, &k, &bytes), Err(EnvelopeError::WrongScope));
    assert_eq!(envelope::open("f1r3pix", "another", address, &k, &bytes), Err(EnvelopeError::WrongScope));
    assert_eq!(envelope::open("f1r3pix", inst, "1111stranger", &keyfile::generate(), &bytes), Err(EnvelopeError::NotAddressed));
    // A recipient's address with someone else's key does not open it either.
    assert_eq!(envelope::open("f1r3pix", inst, address, &keyfile::generate(), &bytes), Err(EnvelopeError::WrongScope));
    // Altered ciphertext, or a sender rewritten in the clear, fails authentication.
    let mut env = envelope::Envelope::from_bytes(&bytes).unwrap();
    env.ciphertext[0] ^= 1;
    assert_eq!(envelope::open("f1r3pix", inst, address, &k, &env.to_bytes()), Err(EnvelopeError::WrongScope));
    let mut env = envelope::Envelope::from_bytes(&bytes).unwrap();
    env.sender = "1111impostor".into();
    assert_eq!(envelope::open("f1r3pix", inst, address, &k, &env.to_bytes()), Err(EnvelopeError::WrongScope));
    assert_eq!(envelope::Envelope::from_bytes(&bytes[..10]), Err(EnvelopeError::Corrupt));
}

#[test]
fn rust_sealing_round_trips_and_is_fresh_each_time() {
    let (a, b) = (keyfile::generate(), keyfile::generate());
    let (pa, pb) = (keyfile::public_key_bytes(&a), keyfile::public_key_bytes(&b));
    let s1 = envelope::seal("f1r3pix", "i", ("1111a", &pa), &[("1111b", &pb)], b"hello").unwrap();
    let s2 = envelope::seal("f1r3pix", "i", ("1111a", &pa), &[("1111b", &pb)], b"hello").unwrap();
    assert_ne!(s1, s2);
    assert_eq!(envelope::open("f1r3pix", "i", "1111b", &b, &s1).unwrap(), ("1111a".to_string(), b"hello".to_vec()));
    assert_eq!(envelope::open("f1r3pix", "i", "1111a", &a, &s2).unwrap().1, b"hello");
}

#[test]
fn the_wallet_opens_only_for_its_active_address() {
    let (mut ks, u) = Keystore::create("pw", 1000);
    let k = keyfile::generate();
    let me = ks.add_key(&u, &k, "main").unwrap().to_string();
    let mut w = Wallet::new(ks, Policy::new("root", ENV, 1_000_000_000));
    w.unlock_with_passphrase("pw").unwrap();
    let other = keyfile::generate();
    let env = envelope::seal("f1r3pix", "inst", ("1111x", &keyfile::public_key_bytes(&other)), &[(me.as_str(), &keyfile::public_key_bytes(&k))], b"blue").unwrap();
    assert_eq!(w.open_envelope("f1r3pix", "inst", &env).unwrap().1, b"blue");
    assert!(matches!(w.open_envelope("f1r3ink", "inst", &env), Err(WalletError::Envelope(EnvelopeError::WrongScope))));
    w.lock();
    assert!(w.open_envelope("f1r3pix", "inst", &env).is_err());
}

fn prepared(template: &Template, args: &BTreeMap<String, Value>) -> Vec<u8> {
    DeployData {
        term: template.render(args).unwrap(),
        timestamp: 1_700_000_000_000,
        phlo_price: 1,
        phlo_limit: 1000,
        valid_after_block_number: 3,
        shard_id: "root".into(),
        expiration_timestamp: Some(1_700_000_600_000),
    }
    .signing_bytes()
}

#[test]
fn payments_are_signed_only_from_the_portal_and_always_prompted() {
    let (mut ks, u) = Keystore::create("pw", 1000);
    ks.add_key(&u, &keyfile::generate(), "main").unwrap();
    let mut w = Wallet::new(ks, Policy::new("root", ENV, 1_000_000_000));
    w.unlock_with_passphrase("pw").unwrap();
    let t = catalogue::get("payments.send").unwrap();
    assert!(catalogue::moves_funds(&t.id));
    let mut args = BTreeMap::new();
    args.insert("env_uri".into(), Value::Uri(ENV.into()));
    args.insert("instance".into(), Value::str("inst"));
    args.insert("transfers".into(), Value::List(vec![
        Value::List(vec![Value::str("1111b"), Value::Int(10)]),
        Value::List(vec![Value::str("1111c"), Value::Int(10)]),
        Value::List(vec![Value::str("1111d"), Value::Int(10)]),
    ]));
    args.insert("memo".into(), Value::str("go blue"));
    let portal = SignRequest { origin: Origin::Portal, template: t.id.clone(), args: args.clone(), prepared: prepared(t, &args), instance: Some("inst".into()) };
    match w.review(&portal, 0).unwrap() {
        Decision::Prompt { summary, .. } => assert!(summary.starts_with("PAYMENT of 30 from your vault to 3 players"), "{summary}"),
        d => panic!("{d:?}"),
    }
    // Even with an allowance that names it, a game frame cannot have it signed.
    w.policy.grant(Allowance { game: "f1r3pix".into(), instance: "inst".into(), templates: BTreeSet::from([t.id.clone()]), budget: 1_000_000, spent: 0, expires_at: i64::MAX });
    let game = SignRequest { origin: Origin::Game("f1r3pix".into()), ..portal.clone() };
    assert!(matches!(w.review(&game, 0), Err(WalletError::Policy(PolicyError::TransferFromGame))));
    // And the portal's own signature of it is never "within" an allowance.
    assert!(matches!(w.review(&portal, 0).unwrap(), Decision::Prompt { .. }));
}
