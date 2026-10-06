//! Conformance with F1R3Node-Rust and with the key/address/signature
//! behaviour shared by F1R3Sky and F1R3Gaze.

use f1r3games_core::address::Address;
use f1r3games_core::deploy::{self, DeployData};
use f1r3games_core::{catalogue, ids, invite, keyfile, registry, Value};
use k256::ecdsa::SigningKey;
use std::collections::BTreeMap;

/// (private key, address, key file, signature over CONTRACT) produced by the
/// Embers SDK's own code (Address.fromPublicKey, serializeKey, signContract),
/// as recorded in F1R3Gaze's `gaze-wallet/tests/wallet.rs`.
const VECTORS: &[(&str, &str, &str, &str)] = &[
    ("0000000000000000000000000000000000000000000000000000000000000001", "1111PXDQTDEd4XNuX4YWoB6XeL7ssWvhePGD2XmkENkG5sHfAMW9Q", r#"{"keyType":"secp256k1","value":"0000000000000000000000000000000000000000000000000000000000000001","valueFormat":"hex"}"#, "3045022100b707752315d8ae184eb2e761e2f1a3a78596274550d21c03f9ee791998f87a1202200c6bb93971ae04fbc8926f8311098a772b7ca96c949809f7ffeb637400d000b7"),
    ("a0b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f", "11112dz5hKK18bRqrfY5puLbKURCjKEhf2KrDDwZDufqiAuVqDrkMS", r#"{"keyType":"secp256k1","value":"A0B1C2D3E4F5061728394A5B6C7D8E9FA0B1C2D3E4F5061728394A5B6C7D8E9F","valueFormat":"hex"}"#, "3045022100f8d9abe4fe7763bf943e92988d8de6b51cbdb9dd11294d8494aedae4a011b76702207b0bdff0de6d85b8b7107e838537be6c2ae87be7e1c77c47a3a4c425ffbc1b26"),
    ("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140", "11112oK2fv3B4ZHyjVgT5CsahvRjEeJrjpZ4DSrbGqp9xo5GHHTafg", r#"{"keyType":"secp256k1","value":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140","valueFormat":"hex"}"#, "3045022100dbbc911b2ceb229a9211fe36e68c75b70bb1110a0462682c4df9c347dd4603fd0220698f2ebed0a568874641e252303d479d068bcbf1dd3e01bfd0cb7364b660edd3"),
];
const CONTRACT: &[u8] = b"gaze-wallet test contract";

fn key(h: &str) -> SigningKey {
    SigningKey::from_slice(&hex::decode(h).unwrap()).unwrap()
}

#[test]
fn addresses_key_files_and_signatures_match_the_shared_vectors() {
    for (k, addr, file, sig) in VECTORS {
        let sk = key(k);
        assert_eq!(Address::from_public_key(sk.verifying_key()).as_str(), *addr);
        assert!(Address::parse(addr).is_ok());
        assert_eq!(keyfile::serialize(&sk), *file);
        assert_eq!(keyfile::deserialize(file).unwrap().to_bytes(), sk.to_bytes());
        assert_eq!(hex::encode(deploy::sign_bytes(&sk, CONTRACT)), *sig);
        assert!(deploy::verify_bytes(&keyfile::public_key_bytes(&sk), CONTRACT, &hex::decode(sig).unwrap()));
    }
    assert!(Address::parse("1111NypGkNrhxpLKFwiZ8gLKmiwLQUyzuEe1p3nEKQCSKMvd1YHY3").is_ok());
    assert!(Address::parse("1111NypGkNrhxpLKFwiZ8gLKmiwLQUyzuEe1p3nEKQCSKMvd1YHY4").is_err());
    assert!(keyfile::deserialize(&VECTORS[1].0.to_lowercase()).is_ok());
    assert!(keyfile::deserialize(r#"{"keyType":"ed25519","value":"00","valueFormat":"hex"}"#).is_err());
}

#[test]
fn deploy_encoding_matches_prost_and_signatures_bind_every_field() {
    let d = DeployData {
        term: "Nil".into(),
        timestamp: 1,
        phlo_price: 1,
        phlo_limit: 300,
        valid_after_block_number: 0,
        shard_id: "root".into(),
        expiration_timestamp: None,
    };
    assert_eq!(
        d.signing_bytes(),
        vec![0x12, 3, b'N', b'i', b'l', 0x18, 1, 0x38, 1, 0x40, 0xac, 0x02, 0x5a, 4, b'r', b'o', b'o', b't']
    );
    assert_eq!(DeployData::decode(&d.signing_bytes()).unwrap(), d);
    let mut neg = d.clone();
    neg.valid_after_block_number = -1;
    assert_eq!(DeployData::decode(&neg.signing_bytes()).unwrap(), neg);

    // Strict decoding: a signer field, a repeated field, or trailing junk is refused.
    let mut with_sig = d.signing_bytes();
    with_sig.extend_from_slice(&[0x22, 1, 0]);
    assert!(DeployData::decode(&with_sig).is_err());
    let mut repeated = d.signing_bytes();
    repeated.extend_from_slice(&[0x18, 2]);
    assert!(DeployData::decode(&repeated).is_err());

    let k = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let s = deploy::sign(&k, DeployData { expiration_timestamp: Some(9), ..d.clone() });
    assert!(s.verify());
    let mut t = s.clone();
    t.data.shard_id = "other".into();
    assert!(!t.verify());
    let j = s.to_json();
    assert_eq!(j["sigAlgorithm"], "secp256k1");
    assert_eq!(j["data"]["expiration_timestamp"], 9);
    assert_eq!(j["data"]["phloLimit"], 300);
}

/// The worked example in F1R3Node-Rust's own `SystemVault.rho` header.
#[test]
fn insert_signed_matches_the_node_system_vault_vector() {
    let sk = key("27e5718bf55dd673cc09f13c2bcf12ed7949b178aef5dcb6cd492ad422d05e9d");
    let pk = keyfile::public_key_bytes(&sk);
    assert_eq!(hex::encode(&pk), "040f035630a5d2199184890b4b6b83440c842da0b6becca539f788f7b35d6e873561f673cd6ebe2e32236398a86f29dad992e8fba32534734300fcc5104bcfea0e");
    let pre = registry::insert_signed_preimage(1559156183943, &pk, i64::MAX);
    assert_eq!(hex::encode(&pre), "2a65aa01620a092a07108ece9acfe05a0a462a44ca0141040f035630a5d2199184890b4b6b83440c842da0b6becca539f788f7b35d6e873561f673cd6ebe2e32236398a86f29dad992e8fba32534734300fcc5104bcfea0e0a0d2a0b10feffffffffffffffff01");
    let sig = registry::insert_signed_signature(&sk, 1559156183943, &pk, i64::MAX);
    assert_eq!(hex::encode(sig), "3045022100c58cd73cd1a5c153d4edb3fc6e48aa2344c549a9225bde3def9b98c35e44399902205c3b615a1f19b8b2de23aecfea24dea30ae96eecd5f8bda1c125f47cb92a08d2");
    assert_eq!(registry::uri_for_public_key(&pk), "rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j");
}

/// Embers' `firefly-client` test vector for `insert_signed_signature`.
#[test]
fn insert_signed_matches_the_embers_vector() {
    let sk = key("f450b26bac63e5dd9343cd46f5fae1986d367a893cd21eedd98a4cb3ac699abc");
    let pk = keyfile::public_key_bytes(&sk);
    let sig = registry::insert_signed_signature(&sk, 1_559_156_356_769, &pk, i64::MAX);
    assert_eq!(hex::encode(sig), "3044022038044777f2faccfc503363ce70d5701ae64969ca98e64049f92d8477fdea0c1402200843c073c6f0121f580f38bb2940f16cef54fc24ea325ebc00230fa6e3117549");
}

#[test]
fn values_render_as_rholang_literals_and_refuse_control_characters() {
    let v = Value::map([
        ("name", Value::str("Ada \"the\" \\ Lovelace")),
        ("tags", Value::List(vec![Value::str("a"), Value::Int(-3)])),
        ("raw", Value::Bytes(vec![0xde, 0xad])),
        ("one", Value::Tuple(vec![Value::Nil])),
        ("set", Value::Set([Value::str("g")].into_iter().collect())),
        ("uri", Value::Uri("rho:id:abc".into())),
    ]);
    assert_eq!(
        v.render().unwrap(),
        r#"{"name": "Ada \"the\" \\ Lovelace", "one": (Nil,), "raw": "dead".hexToBytes(), "set": Set("g"), "tags": ["a", -3], "uri": `rho:id:abc`}"#
    );
    assert!(Value::str("line\nbreak").render().is_err());
    assert!(Value::Uri("rho:id:x`} | evil".into()).render().is_err());
    assert!(Value::Unforgeable("00".into()).render().is_err());
    let back = Value::from_typed_json(&v.to_typed_json()).unwrap();
    assert_eq!(back, v);
}

#[test]
fn rho_expr_json_decodes() {
    let j = serde_json::json!({"ExprTuple": {"data": [
        {"ExprBool": {"data": true}},
        {"ExprMap": {"data": {"id": {"ExprString": {"data": "abc"}}, "n": {"ExprInt": {"data": 4}},
                              "b": {"ExprBytes": {"data": "0a0b"}},
                              "s": {"ExprSet": {"data": [{"ExprString": {"data": "x"}}]}}}}}
    ]}});
    let v = Value::from_rho_expr(&j).unwrap();
    let out = v.into_outcome().unwrap();
    assert_eq!(out.get("id").unwrap().as_str(), Some("abc"));
    assert_eq!(out.get("n").unwrap().as_int(), Some(4));
    assert_eq!(out.get("b").unwrap(), &Value::Bytes(vec![10, 11]));
}

#[test]
fn templates_render_strictly_and_cover_every_method() {
    let t = catalogue::get("profiles.save").unwrap();
    assert_eq!(t.holes().unwrap(), vec!["env_uri".to_string(), "profile".to_string()]);
    let mut args = BTreeMap::new();
    args.insert("env_uri".to_string(), Value::Uri("rho:id:abc".into()));
    assert!(matches!(t.render(&args), Err(f1r3games_core::TemplateError::Unbound(_))));
    args.insert("profile".to_string(), Value::map([("name", Value::str("Ada"))]));
    let term = t.render(&args).unwrap();
    assert!(term.contains(r#"@env!("profiles", "save", {"name": "Ada"}, *deployId)"#));
    args.insert("extra".to_string(), Value::Nil);
    assert!(matches!(t.render(&args), Err(f1r3games_core::TemplateError::Extra(_))));

    let env = catalogue::get(catalogue::ENV).unwrap();
    let holes = env.holes().unwrap();
    for h in ["env_uri", "version", "public_key", "sig", "coop"] {
        assert!(holes.contains(&h.to_string()), "{h}");
    }
    // Every generated call names a method the environment defines.
    for (domain, op, _, _) in catalogue::METHODS {
        assert!(env.source.contains(&format!("contract env(@\"{domain}\", @\"{op}\"")), "{domain}.{op}");
    }
    let explore = catalogue::get("profiles.get").unwrap();
    assert!(explore.source.starts_with("new ret, rl("));
    assert!(!catalogue::get("profiles.get").unwrap().uris().contains("rho:system:deployerId"));
}

#[test]
fn invitations_round_trip_and_bind_the_guest() {
    let inv = invite::InviteKey::generate();
    let guest = Address::from_public_key(keyfile::generate().verifying_key());
    let other = Address::from_public_key(keyfile::generate().verifying_key());
    let sig = inv.sign_redemption(&guest);
    assert!(invite::verify_redemption(&inv.public_key(), &guest, &sig));
    assert!(!invite::verify_redemption(&inv.public_key(), &other, &sig));
    let funded = keyfile::generate();
    let link = inv.link("https://games.f1r3fly.io/", "0a1b2c", Some(&funded));
    let p = invite::parse_link(&link).unwrap();
    assert_eq!(p.instance_id, "0a1b2c");
    assert_eq!(p.invite_key.public_key(), inv.public_key());
    assert_eq!(p.funded_key.unwrap().to_bytes(), funded.to_bytes());
    assert!(invite::parse_link("https://x/i/zz#i=AAAA").is_err());
}

#[test]
fn identifiers_are_stable_and_distinct() {
    let pk = [4u8; 65];
    assert_eq!(ids::derive("instance", &pk, 5), ids::derive("instance", &pk, 5));
    assert_ne!(ids::derive("instance", &pk, 5), ids::derive("play", &pk, 5));
    assert_eq!(ids::derive("instance", &pk, 5).len(), 32);
    assert_eq!(ids::day(86_400_000 * 3 + 5), 3);
}
