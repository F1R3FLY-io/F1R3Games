//! The Rust side of F1R3Ink held to the vectors the JavaScript client generates
//! (F1R3Ink/vectors/ink-vectors.json), and the environment held to its design.

use f1r3games_core::Value;
use f1r3games_games::ink::*;
use serde_json::Value as J;

fn vectors() -> J {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../F1R3Ink/vectors/ink-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file")).unwrap()
}

/// Plain JSON → a typed value, as the portal would pass a configuration.
fn typed(j: &J) -> Value {
    match j {
        J::Null => Value::Nil,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Int(n.as_i64().unwrap()),
        J::String(s) => Value::str(s.clone()),
        J::Array(xs) => Value::List(xs.iter().map(typed).collect()),
        J::Object(o) => Value::Map(o.iter().map(|(k, v)| (k.clone(), typed(v))).collect()),
    }
}

fn decay_of(j: &J) -> Option<Decay> {
    j.as_object().map(|d| Decay { unit: d["unit"].as_i64().unwrap(), steps: d["steps"].as_i64().unwrap() })
}

fn sid(s: &str) -> Sid {
    Sid::parse(s)
}

fn event(e: &J) -> Event {
    let s = |k: &str| e[k].as_str().unwrap().to_string();
    let kind = match e["type"].as_str().unwrap() {
        "visibility" => Kind::Visibility { player: s("player"), public: e["public"].as_bool().unwrap() },
        "tags" => Kind::Tags { player: s("player"), tags: e["tags"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect() },
        "veil" => Kind::Veil { player: s("player"), sids: e["sids"].as_array().unwrap().iter().map(|x| sid(x.as_str().unwrap())).collect() },
        "reveal" => Kind::Reveal { target: s("target"), handle: s("handle"), player: s("player") },
        "ink" => {
            let k = &e["ink"];
            let ink = if k.get("lifted").is_some() {
                Ink::Lifted
            } else if let Some(c) = k.get("c") {
                Ink::Colour(c.as_u64().unwrap() as u8)
            } else {
                Ink::Sealed { colour: k["colour"].as_u64().map(|c| c as u8), hash: hex::decode(k["hash"].as_str().unwrap()).unwrap().try_into().unwrap() }
            };
            Kind::Ink { target: s("target"), sid: sid(e["sid"].as_str().unwrap()), ink }
        }
        other => panic!("{other}"),
    };
    Event { h: e["h"].as_i64().unwrap(), t: e["t"].as_i64().unwrap(), kind }
}

#[test]
fn configurations_match_the_vectors() {
    let v = vectors();
    for c in v["configs"].as_array().unwrap() {
        assert_eq!(config(&typed(&c["config"])).is_some(), c["ok"].as_bool().unwrap(), "{}", c["config"]);
    }
    let ok = config(&typed(&v["configs"][0]["config"])).unwrap();
    assert_eq!(ok.palette, DEFAULT_PALETTE.map(String::from).to_vec());
    assert_eq!(ok.decay, Some(Decay { unit: 3_600_000, steps: 24 }));
}

#[test]
fn decay_matches_the_vectors() {
    for d in vectors()["decay"].as_array().unwrap() {
        let dec = decay_of(&d["decay"]);
        let (last, now) = (d["last"].as_i64().unwrap(), d["now"].as_i64().unwrap());
        assert_eq!(remaining(dec, last, now), d["remaining"].as_i64(), "{d}");
        assert!((opacity(dec, last, now) - d["opacity"].as_f64().unwrap()).abs() < 1e-12);
    }
}

#[test]
fn handles_match_the_vectors() {
    let v = vectors();
    let secret = hex::decode(v["secret"].as_str().unwrap()).unwrap();
    let inst = v["instance"].as_str().unwrap();
    for h in v["handles"].as_array().unwrap() {
        assert_eq!(handle(&secret, inst, h["target"].as_str().unwrap(), h["inker"].as_str().unwrap()), h["handle"].as_str().unwrap());
    }
    // Different inkers, targets and instances get different handles.
    let a = handle(&secret, inst, "t", "i");
    assert_ne!(a, handle(&secret, inst, "i", "t"));
    assert_ne!(a, handle(&secret, "other", "t", "i"));
    assert_eq!(a.len(), 32);
}

#[test]
fn history_order_matches_the_vectors() {
    let v = vectors();
    let shuffled: Vec<Event> = v["order"]["shuffled"].as_array().unwrap().iter().map(event).collect();
    let want: Vec<Event> = v["order"]["ordered"].as_array().unwrap().iter().map(event).collect();
    assert_eq!(order_events(shuffled), want);
}

#[test]
fn the_round_body_matches_the_vectors_and_round_trips() {
    let v = vectors();
    let events: Vec<Event> = v["order"]["ordered"].as_array().unwrap().iter().map(event).collect();
    let r = &v["round"];
    let palette: Vec<String> = r["palette"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    let round = Round { from: r["from"].as_i64().unwrap(), to: r["to"].as_i64().unwrap(), palette, decay: decay_of(&r["decay"]), events };
    let b = encode_round(&round).unwrap();
    assert_eq!(hex::encode(&b), r["hex"].as_str().unwrap());
    assert_eq!(decode_round(&b).unwrap(), round);
    assert_eq!(decode_round(&b[..b.len() - 1]), Err(BodyError::Truncated));
    let mut extra = b.clone();
    extra.push(0);
    assert_eq!(decode_round(&extra), Err(BodyError::Trailing));
    // Out of order is refused.
    let mut bad = round.clone();
    bad.events.swap(0, 5);
    assert_eq!(encode_round(&bad), Err(BodyError::Order));
}

#[test]
fn the_portrait_body_matches_the_vectors_and_round_trips() {
    let v = vectors();
    let f = &v["flag"];
    let events: Vec<Event> = f["events"].as_array().unwrap().iter().map(event).collect();
    let palette: Vec<String> = f["palette"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    let keys = f["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| (k[0].as_u64().unwrap() as usize, hex::decode(k[1].as_str().unwrap()).unwrap().try_into().unwrap()))
        .collect();
    let p = Portrait {
        owner: f["owner"].as_str().unwrap().into(),
        round: Round { from: f["from"].as_i64().unwrap(), to: f["to"].as_i64().unwrap(), palette, decay: None, events },
        keys,
    };
    let b = encode_flag(&p).unwrap();
    assert_eq!(hex::encode(&b), f["hex"].as_str().unwrap());
    assert_eq!(decode_flag(&b).unwrap(), p);
    // A portrait carries only its owner's events.
    let mut other = p.clone();
    other.owner = v["addresses"][0].as_str().unwrap().into();
    assert!(encode_flag(&other).is_err());
}

#[test]
fn the_environment_follows_the_design() {
    let g = f1r3games_games::get("f1r3ink").unwrap();
    let env = g.env_template().source;
    // ink names its target, never a stripe; the relay alone writes anonymous stripes.
    assert!(env.contains(r#"contract env(@"ink", @instance, @target, @ink, ret)"#));
    assert!(env.contains(r#"if (relay == Nil or by != relay) { ret!((false, "only the relay may write anonymous stripes")) }"#));
    assert!(env.contains(r#"vaultAddress!("fromPublicKey", key, *aCh)"#));
    // The clock is the block's, never the deploy's (D5).
    assert!(env.contains("for (@n, @t, _ <- bd) { ret!(n, t) }"));
    assert!(!env.contains("rho:vault:system") && !env.contains("deployerId"));
    assert!(!env.contains(r#"@"state""#));
    assert_eq!(g.capabilities, ["pay", "open", "relay"]);
    let kinds: Vec<_> = g.galleries.iter().map(|x| x.kind).collect();
    assert_eq!(kinds, ["round", "flag"]);
    // The relay's moves are never play templates.
    for m in g.methods {
        if m.name.starts_with("relay") || m.name == "setRelay" {
            assert!(!m.play, "{}", m.name);
        }
    }
    let man = g.manifest_with("rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j", "https://games.example/play", Some("https://games.example/api/relay/"));
    assert_eq!(man.get("relay").and_then(Value::as_str), Some("https://games.example/api/relay/f1r3ink"));
    assert!(g.manifest("rho:id:x", "https://games.example/play").get("relay").is_none());
    // Games that do not declare the relay never get one.
    let pix = f1r3games_games::get("f1r3pix").unwrap();
    assert!(pix.manifest_with("rho:id:x", "https://e", Some("https://r")).get("relay").is_none());
}
