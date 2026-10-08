//! Sealed inks (F1R3Ink design §7): what the JavaScript client seals opens in
//! the Rust wallet for the target and the inker only, under its game,
//! instance and stripe only; Rust seals byte for byte as the client does; a
//! disclosed content key opens exactly one envelope; and the wallet signs
//! relay requests only for its own address.

use f1r3games_core::{keyfile, relay, Address};
use f1r3games_wallet::envelope::{self, EnvelopeError};
use f1r3games_wallet::keystore::Keystore;
use f1r3games_wallet::policy::Policy;
use f1r3games_wallet::wallet::{Wallet, WalletError};
use k256::ecdsa::SigningKey;
use k256::SecretKey;

fn vectors() -> serde_json::Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../F1R3Ink/vectors/ink-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn key(hex_sk: &str) -> SigningKey {
    SigningKey::from_slice(&hex::decode(hex_sk).unwrap()).unwrap()
}

#[test]
fn the_clients_sealed_inks_open_for_their_two_parties_only() {
    let v = vectors();
    let inst = v["instance"].as_str().unwrap();
    let keys: Vec<String> = v["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()).collect();
    for s in v["sealed"].as_array().unwrap() {
        let bytes = hex::decode(s["envelope"].as_str().unwrap()).unwrap();
        assert_eq!(envelope::version(&bytes).unwrap(), envelope::INK_VERSION);
        let parties: Vec<usize> = s["parties"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect();
        for (i, k) in keys.iter().enumerate() {
            let r = envelope::open_ink("f1r3ink", inst, &key(k), &bytes);
            if parties.contains(&i) {
                let o = r.unwrap();
                assert_eq!(o.colour as u64, s["colour"].as_u64().unwrap());
                assert_eq!((o.target.as_str(), o.sid.as_str(), o.seq), (s["target"].as_str().unwrap(), s["sid"].as_str().unwrap(), s["seq"].as_u64().unwrap()));
                assert_eq!(hex::encode(o.key), s["key"].as_str().unwrap());
            } else {
                assert_eq!(r, Err(EnvelopeError::NotAddressed));
            }
        }
        // Not under another game or instance.
        let k0 = key(&keys[parties[0]]);
        assert!(envelope::open_ink("f1r3pix", inst, &k0, &bytes).is_err());
        assert!(envelope::open_ink("f1r3ink", "another", &k0, &bytes).is_err());
        // A disclosed key opens it for anyone.
        let ck: [u8; 32] = hex::decode(s["key"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert_eq!(envelope::open_ink_with_key("f1r3ink", inst, &ck, &bytes).unwrap().colour as u64, s["colour"].as_u64().unwrap());
        // The wire form round-trips byte for byte.
        assert_eq!(envelope::InkEnvelope::from_bytes(&bytes).unwrap().to_bytes(), bytes);
    }
}

#[test]
fn rust_seals_as_the_client_does() {
    let v = vectors();
    let inst = v["instance"].as_str().unwrap();
    let keys: Vec<String> = v["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_string()).collect();
    for (s, salt) in v["sealed"].as_array().unwrap().iter().zip(["88", "99"]) {
        let pks: Vec<Vec<u8>> = s["parties"].as_array().unwrap().iter().map(|i| keyfile::public_key_bytes(&key(&keys[i.as_u64().unwrap() as usize]))).collect();
        let refs: Vec<&[u8]> = pks.iter().map(|p| p.as_slice()).collect();
        let eph = SecretKey::from_slice(&hex::decode(salt.repeat(32)).unwrap()).unwrap();
        let b = envelope::seal_ink_with(
            "f1r3ink", inst, s["target"].as_str().unwrap(), s["sid"].as_str().unwrap(), s["seq"].as_u64().unwrap(), &refs,
            s["colour"].as_u64().unwrap() as u8, &eph, [0x44; 32], [0x55; 12], &[[0x66; 12], [0x77; 12]],
        )
        .unwrap();
        assert_eq!(hex::encode(b), s["envelope"].as_str().unwrap());
    }
}

#[test]
fn a_sealed_ink_cannot_be_moved_to_another_stripe_or_place() {
    let v = vectors();
    let s = &v["sealed"][0];
    let bytes = hex::decode(s["envelope"].as_str().unwrap()).unwrap();
    let mut e = envelope::InkEnvelope::from_bytes(&bytes).unwrap();
    let k = key(v["keys"][1].as_str().unwrap());
    let inst = v["instance"].as_str().unwrap();
    e.seq += 1;
    assert_eq!(envelope::open_ink("f1r3ink", inst, &k, &e.to_bytes()), Err(EnvelopeError::WrongScope));
    let mut e = envelope::InkEnvelope::from_bytes(&bytes).unwrap();
    e.sid = "anon:00".into();
    assert_eq!(envelope::open_ink("f1r3ink", inst, &k, &e.to_bytes()), Err(EnvelopeError::WrongScope));
    let mut e = envelope::InkEnvelope::from_bytes(&bytes).unwrap();
    e.target = v["addresses"][2].as_str().unwrap().into();
    assert_eq!(envelope::open_ink("f1r3ink", inst, &k, &e.to_bytes()), Err(EnvelopeError::WrongScope));
}

#[test]
fn the_wallet_opens_inks_and_signs_relay_requests_only_for_itself() {
    let v = vectors();
    let inst = v["instance"].as_str().unwrap();
    let file = keyfile::serialize(&key(v["keys"][1].as_str().unwrap()));
    let (mut ks, u) = Keystore::create("pass", 1000);
    let a = ks.import_key_file(&u, &file, "inker").unwrap();
    ks.set_active(a.as_str()).unwrap();
    let mut w = Wallet::new(ks, Policy::new("root", "rho:id:x", 1_000_000));
    w.unlock_with_passphrase("pass").unwrap();
    let s = &v["sealed"][0];
    let o = w.open_ink("f1r3ink", inst, &hex::decode(s["envelope"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(o.colour as u64, s["colour"].as_u64().unwrap());

    let me = w.active_address().unwrap().to_string();
    let msg = |a: &str| serde_json::json!({ "v": 1, "game": "f1r3ink", "instance": inst, "relay": "https://r.example/api/relay/f1r3ink",
                                            "op": "ink", "params": {}, "address": a, "at": 5 }).to_string();
    let m = msg(&me);
    let sig = w.relay_signature(&m).unwrap();
    let pk = keyfile::public_key_bytes(&key(v["keys"][1].as_str().unwrap()));
    assert_eq!(relay::verify(&m, &pk, &sig, 5).unwrap().address, me);
    let someone = Address::from_public_key(key(v["keys"][0].as_str().unwrap()).verifying_key()).to_string();
    assert!(matches!(w.relay_signature(&msg(&someone)), Err(WalletError::Relay(_))));
    assert!(matches!(w.relay_signature("not json"), Err(WalletError::Relay(_))));
}
