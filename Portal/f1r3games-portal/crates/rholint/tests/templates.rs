//! Every template the portal can render parses with the node's own parser.

use f1r3games_core::{catalogue, keyfile, registry, Value};
use std::collections::BTreeMap;

fn sample(hole: &str) -> Value {
    match hole {
        "env_uri" => Value::Uri("rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j".into()),
        "version" | "uses" | "expiresAt" | "amount" | "day" => Value::Int(7),
        "public_key" | "invitePk" => Value::Bytes(keyfile::public_key_bytes(&keyfile::generate())),
        "sig" | "body" | "ciphertext" => Value::Bytes(vec![0x30, 0x44, 1, 2, 3]),
        "profile" | "manifest" | "header" | "config" => Value::map([("name", Value::str("Ada")), ("tags", Value::List(vec![Value::str("x")]))]),
        "terms" => Value::map([
            ("name", Value::str("Acme")),
            ("games", Value::Set([Value::str("f1r3pix")].into_iter().collect())),
            ("stipend", Value::Int(10)),
            ("maxPerAddress", Value::Int(1)),
            ("expiresAt", Value::Int(1000)),
            ("creative", Value::Bytes(vec![1, 2])),
        ]),
        "sponsorship" => Value::Nil,
        "version_" => Value::Int(-1),
        _ => Value::str(format!("{hole}-value")),
    }
}

#[test]
fn every_template_parses() {
    let mut failures = vec![];
    for t in catalogue::all() {
        let args: BTreeMap<String, Value> = t.holes().unwrap().into_iter().map(|h| { let v = sample(&h); (h, v) }).collect();
        let src = t.render(&args).unwrap();
        if let Err(e) = f1r3games_rholint::parse(&src) {
            failures.push(format!("{}: {}", t.id, &e[..e.len().min(2000)]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn the_environment_renders_with_a_real_registry_signature_and_parses() {
    let env_key = keyfile::generate();
    let service = keyfile::generate();
    let env_pk = keyfile::public_key_bytes(&env_key);
    let mut args = BTreeMap::new();
    args.insert("env_uri".to_string(), Value::Uri(registry::uri_for_public_key(&env_pk)));
    args.insert("version".to_string(), Value::Int(1));
    args.insert("public_key".to_string(), Value::Bytes(env_pk));
    args.insert("sig".to_string(), Value::Bytes(registry::insert_signed_signature(&env_key, 1, &keyfile::public_key_bytes(&service), 1)));
    args.insert("coop".to_string(), Value::str("1111PXDQTDEd4XNuX4YWoB6XeL7ssWvhePGD2XmkENkG5sHfAMW9Q"));
    let src = catalogue::get(catalogue::ENV).unwrap().render(&args).unwrap();
    f1r3games_rholint::parse(&src).unwrap();
}

#[test]
fn the_parser_does_reject_broken_rholang() {
    assert!(f1r3games_rholint::parse("new x in { x!(").is_err());
    assert!(f1r3games_rholint::parse("for (@a <- x) { a!(1) | }").is_err());
}
