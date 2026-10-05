use f1r3games_core::template::TemplateKind;
use f1r3games_core::{catalogue, keyfile, registry, Value};
use f1r3games_games::{env_uri, get, GAMES};
use f1r3games_wallet::policy::Policy;
use std::collections::BTreeMap;

const PORTAL_ENV: &str = "rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j";

#[test]
fn every_game_has_a_manifest_the_wallet_accepts() {
    for g in GAMES {
        let key = keyfile::generate();
        let uri = env_uri(&key);
        let man = g.manifest(&uri, "https://games.f1r3fly.io/play");
        assert_eq!(man.get("id").unwrap().as_str(), Some(g.id));
        let Some(Value::List(ts)) = man.get("templates") else { panic!() };
        assert_eq!(ts.len(), g.methods.len());
        let mut policy = Policy::new("root", PORTAL_ENV, 1_000_000_000);
        for (t, _) in g.templates(&uri) {
            assert!(t.id.starts_with(&format!("{}.", g.id)));
            assert!(catalogue::get(&t.id).is_none(), "{} collides with the portal catalogue", t.id);
            assert!(t.source.contains(&format!("`{uri}`")), "the template pins its environment");
            assert!(!t.holes().unwrap().contains(&"env_uri".to_string()));
            if t.kind == TemplateKind::Deploy {
                // The wallet's game-template rule: no deployer authority in the term.
                policy.register_game_template(g.id, t.clone(), &t.hash_hex()).unwrap();
            }
        }
        // Each env method the templates call is defined by the environment.
        let env = g.env_template();
        for m in g.methods {
            assert!(env.source.contains(&format!("contract env(@\"{}\"", m.name)), "{}.{}", g.id, m.name);
        }
        // The environment never binds vault authority.
        for u in env.uris() {
            assert!(!u.starts_with("rho:vault:system") && !u.contains("deployerId"), "{}: {u}", g.id);
        }
    }
}

#[test]
fn skein_has_two_cross_linkable_galleries_and_no_contact_dialogue() {
    let s = get("f1r3skein").unwrap();
    let kinds: Vec<_> = s.galleries.iter().map(|g| g.kind).collect();
    assert_eq!(kinds, ["performance", "tune"]);
    assert!(!s.contacts_dialogue);
    assert!(s.platforms.contains(&"visionos"));
    assert!(get("f1r3sidechat").unwrap().reader_tier);
}

#[test]
fn environment_deploys_carry_a_valid_registry_signature() {
    let g = get("f1r3pix").unwrap();
    let (env_key, service) = (keyfile::generate(), keyfile::generate());
    let d = g.env_deploy(&env_key, &service, PORTAL_ENV, 1, 1_700_000_000_000, 5, "root", 1, 10_000_000, 600_000);
    assert!(d.verify());
    let sig = registry::insert_signed_signature(&env_key, d.data.timestamp, &keyfile::public_key_bytes(&service), 1);
    assert!(d.data.term.contains(&format!("\"{}\".hexToBytes()", hex::encode(sig))));
    assert!(d.data.term.contains(&format!("`{PORTAL_ENV}`")));
    assert!(d.data.term.contains(&format!("`{}`", env_uri(&env_key))));
}

#[test]
fn a_call_renders_with_typed_arguments() {
    let g = get("f1r3pix").unwrap();
    let t = g.call_template(&g.methods[0], "rho:id:abc");
    let mut a = BTreeMap::new();
    a.insert("instance".to_string(), Value::str("i1"));
    a.insert("x".to_string(), Value::Int(3));
    a.insert("y".to_string(), Value::Int(4));
    a.insert("colour".to_string(), Value::str("#F3D630"));
    assert!(t.render(&a).unwrap().contains(r##"@env!("place", "i1", 3, 4, "#F3D630", *deployId)"##));
}
