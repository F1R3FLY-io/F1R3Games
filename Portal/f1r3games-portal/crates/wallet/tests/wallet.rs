use f1r3games_core::deploy::DeployData;
use f1r3games_core::template::{Template, TemplateKind};
use f1r3games_core::{catalogue, keyfile, Value};
use f1r3games_wallet::contacts::{Channel, ContactBook, StorageMode};
use f1r3games_wallet::keystore::{Keystore, KeystoreError};
use f1r3games_wallet::policy::{Allowance, Decision, Origin, Policy, PolicyError, SignRequest};
use f1r3games_wallet::wallet::{Consent, Wallet, WalletError};
use std::collections::BTreeMap;

const ENV: &str = "rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j";

fn prepared(template: &Template, args: &BTreeMap<String, Value>, limit: i64, shard: &str) -> Vec<u8> {
    DeployData {
        term: template.render(args).unwrap(),
        timestamp: 1_700_000_000_000,
        phlo_price: 1,
        phlo_limit: limit,
        valid_after_block_number: 3,
        shard_id: shard.into(),
        expiration_timestamp: Some(1_700_000_600_000),
    }
    .signing_bytes()
}

fn profile_args() -> BTreeMap<String, Value> {
    let mut a = BTreeMap::new();
    a.insert("env_uri".into(), Value::Uri(ENV.into()));
    a.insert("profile".into(), Value::map([("name", Value::str("Ada"))]));
    a
}

#[test]
fn keystore_unlocks_by_passphrase_or_passkey_and_nothing_else() {
    let (mut ks, u) = Keystore::create("correct horse", 1000);
    let k = keyfile::generate();
    let a = ks.add_key(&u, &k, "main").unwrap();
    ks.add_passkey(&u, "cred-1", &[9u8; 32]);
    let ks = Keystore::from_json(&ks.to_json()).unwrap();
    assert!(!ks.to_json().contains(&hex::encode(k.to_bytes())));
    assert!(!ks.to_json().to_uppercase().contains(&hex::encode_upper(k.to_bytes())));

    let u1 = ks.unlock_with_passphrase("correct horse").unwrap();
    assert_eq!(ks.key(&u1, a.as_str()).unwrap().to_bytes(), k.to_bytes());
    let u2 = ks.unlock_with_passkey("cred-1", &[9u8; 32]).unwrap();
    assert_eq!(ks.key(&u2, a.as_str()).unwrap().to_bytes(), k.to_bytes());

    assert_eq!(ks.unlock_with_passphrase("wrong").err(), Some(KeystoreError::BadSecret));
    assert_eq!(ks.unlock_with_passkey("cred-1", &[8u8; 32]).err(), Some(KeystoreError::BadSecret));
    assert!(matches!(ks.unlock_with_passkey("cred-2", &[9u8; 32]), Err(KeystoreError::NoSuchPasskey(_))));
    // The exported key file is the shared format.
    assert_eq!(&*ks.export_key_file(&u1, a.as_str()).unwrap(), &keyfile::serialize(&k));
}

#[test]
fn the_wallet_signs_only_what_it_can_read() {
    let (mut ks, u) = Keystore::create("pw", 1000);
    ks.add_key(&u, &keyfile::generate(), "main").unwrap();
    let mut w = Wallet::new(ks, Policy::new("root", ENV, 10_000_000));
    w.unlock_with_passphrase("pw").unwrap();
    let t = catalogue::get("profiles.save").unwrap();
    let args = profile_args();
    let ok = SignRequest { origin: Origin::Portal, template: t.id.clone(), args: args.clone(), prepared: prepared(t, &args, 1000, "root"), instance: None };

    let d = w.review(&ok, 0).unwrap();
    assert!(matches!(d, Decision::Prompt { .. }));
    assert!(matches!(w.sign(&ok, Consent::Refused, 0), Err(WalletError::NotApproved)));
    let s = w.sign(&ok, Consent::Approved, 0).unwrap();
    assert!(s.verify());

    // A term that differs from the template's rendering.
    let mut evil_args = args.clone();
    evil_args.insert("profile".into(), Value::map([("name", Value::str("Eve"))]));
    let evil = SignRequest { prepared: prepared(t, &evil_args, 1000, "root"), ..ok.clone() };
    assert!(matches!(w.review(&evil, 0), Err(WalletError::Policy(PolicyError::TermMismatch))));
    // Another shard.
    let other = SignRequest { prepared: prepared(t, &args, 1000, "other"), ..ok.clone() };
    assert!(matches!(w.review(&other, 0), Err(WalletError::Policy(PolicyError::Shard(..)))));
    // Over the fee cap.
    let costly = SignRequest { prepared: prepared(t, &args, 20_000_000, "root"), ..ok.clone() };
    assert!(matches!(w.review(&costly, 0), Err(WalletError::Policy(PolicyError::FeeCap(..)))));
    // Another environment.
    let mut swapped = args.clone();
    swapped.insert("env_uri".into(), Value::Uri("rho:id:aaaa".into()));
    let swapped = SignRequest { args: swapped.clone(), prepared: prepared(t, &swapped, 1000, "root"), ..ok.clone() };
    assert!(matches!(w.review(&swapped, 0), Err(WalletError::Policy(PolicyError::EnvUri(..)))));
    // Extra bytes hidden after the deploy.
    let mut hidden = ok.prepared.clone();
    hidden.extend_from_slice(&[0x22, 1, 0]);
    let hidden = SignRequest { prepared: hidden, ..ok.clone() };
    assert!(matches!(w.review(&hidden, 0), Err(WalletError::Policy(PolicyError::Decode(_)))));
    // The environment deploy is never the wallet's to sign; transfers only from the portal.
    let env_req = SignRequest { template: catalogue::ENV.into(), ..ok.clone() };
    assert!(matches!(w.review(&env_req, 0), Err(WalletError::Policy(PolicyError::EnvDeploy))));
    let tr = SignRequest { origin: Origin::Game("f1r3pix".into()), template: catalogue::TRANSFER.into(), ..ok.clone() };
    assert!(matches!(w.review(&tr, 0), Err(WalletError::Policy(PolicyError::TransferFromGame))));
}

#[test]
fn game_templates_cannot_reach_the_vault_and_allowances_bound_unprompted_play() {
    let (mut ks, u) = Keystore::create("pw", 1000);
    ks.add_key(&u, &keyfile::generate(), "main").unwrap();
    let mut policy = Policy::new("root", ENV, 10_000_000);

    let thief = Template::new("pix.steal", TemplateKind::Deploy, "new d(`rho:system:deployerId`) in { Nil }");
    let h = thief.hash_hex();
    assert!(matches!(policy.register_game_template("f1r3pix", thief, &h), Err(PolicyError::Forbidden(..))));

    let place = Template::new("pix.place", TemplateKind::Deploy, "new deployId(`rho:system:deployId`) in { deployId!(({{x}}, {{y}}, {{colour}})) }");
    let h = place.hash_hex();
    policy.register_game_template("f1r3pix", place.clone(), &h).unwrap();
    policy.grant(Allowance {
        game: "f1r3pix".into(),
        instance: "inst1".into(),
        templates: ["pix.place".to_string()].into_iter().collect(),
        budget: 2500,
        spent: 0,
        expires_at: 10_000,
    });
    let mut w = Wallet::new(ks, policy);
    w.unlock_with_passphrase("pw").unwrap();

    let mut args = BTreeMap::new();
    args.insert("x".into(), Value::Int(1));
    args.insert("y".into(), Value::Int(2));
    args.insert("colour".into(), Value::str("#F3D630"));
    let req = SignRequest {
        origin: Origin::Game("f1r3pix".into()),
        template: "pix.place".into(),
        args: args.clone(),
        prepared: prepared(&place, &args, 1000, "root"),
        instance: Some("inst1".into()),
    };
    assert!(matches!(w.review(&req, 0).unwrap(), Decision::Within { .. }));
    w.sign(&req, Consent::Refused, 0).unwrap();
    w.sign(&req, Consent::Refused, 0).unwrap();
    // Third move would exceed the 2500 budget: back to a prompt.
    assert!(matches!(w.review(&req, 0).unwrap(), Decision::Prompt { .. }));
    // Expired allowance prompts too.
    let mut w2 = w;
    w2.policy.allowances[0].spent = 0;
    assert!(matches!(w2.review(&req, 20_000).unwrap(), Decision::Prompt { .. }));
    // Another game may not use pix's template.
    let foreign = SignRequest { origin: Origin::Game("f1r3beat".into()), ..req.clone() };
    assert!(matches!(w2.review(&foreign, 0), Err(WalletError::Policy(PolicyError::NotGranted(..)))));
}

#[test]
fn contacts_are_encrypted_under_the_key_and_padded() {
    let k = keyfile::generate();
    let mut book = ContactBook::default();
    assert_eq!(book.mode, StorageMode::ClientOnly);
    book.add("Ada", vec![Channel { kind: "email".into(), handle: "ada@example.org".into() }], 1);
    let rejected = book.import_csv("Bob, discord, bob_builds\nbroken line\n", 2);
    assert_eq!(rejected, vec!["broken line".to_string()]);
    let n = book.import_vcard("BEGIN:VCARD\nVERSION:3.0\nFN:Cy Young\nEMAIL;TYPE=home:cy@example.org\nTEL:+1 555 0100\nEND:VCARD\n", 3);
    assert_eq!(n, 1);
    assert_eq!(book.contacts.len(), 3);
    let ct = book.encrypt(&k);
    assert_eq!((ct.len() - 13 - 16) % 4096, 0);
    assert!(!String::from_utf8_lossy(&ct).contains("ada@example.org"));
    assert_eq!(ContactBook::decrypt(&k, &ct).unwrap(), book);
    assert!(ContactBook::decrypt(&keyfile::generate(), &ct).is_err());
}

#[test]
fn methods_that_move_funds_are_announced_as_payments() {
    let (mut ks, u) = Keystore::create("pw", 1000);
    ks.add_key(&u, &keyfile::generate(), "main").unwrap();
    let mut w = Wallet::new(ks, Policy::new("root", ENV, 1_000_000_000));
    w.unlock_with_passphrase("pw").unwrap();
    let t = catalogue::get("sponsors.fund").unwrap();
    let mut args = BTreeMap::new();
    args.insert("env_uri".into(), Value::Uri(ENV.into()));
    args.insert("id".into(), Value::str("s1"));
    args.insert("amount".into(), Value::Int(5000));
    let req = SignRequest { origin: Origin::Portal, template: t.id.clone(), args: args.clone(), prepared: prepared(t, &args, 1000, "root"), instance: None };
    match w.review(&req, 0).unwrap() {
        Decision::Prompt { summary, .. } => assert!(summary.starts_with("PAYMENT of 5000 from your vault"), "{summary}"),
        d => panic!("{d:?}"),
    }
}
