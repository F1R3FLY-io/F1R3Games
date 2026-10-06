//! The Rust side of F1R3Pix held to the vectors the JavaScript client generates
//! (F1R3Pix/vectors/pix-vectors.json), and the environment held to its design.

use f1r3games_games::pix::*;
use serde_json::Value as J;
use std::collections::{BTreeMap, BTreeSet};

fn vectors() -> J {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../F1R3Pix/vectors/pix-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file")).unwrap()
}

#[test]
fn spiral_and_radius_match_the_vectors() {
    let v = vectors();
    for (i, c) in v["spiral"].as_array().unwrap().iter().enumerate() {
        let want = (c[0].as_i64().unwrap(), c[1].as_i64().unwrap());
        assert_eq!(idx_to_cell(i as i64), want, "index {i}");
        assert_eq!(cell_to_idx(want.0, want.1), i as i64);
    }
    for (cap, r) in v["radius"].as_object().unwrap() {
        assert_eq!(radius_for(cap.parse().unwrap()), Some(r.as_i64().unwrap()));
    }
    assert_eq!(radius_for(6), None);
    assert_eq!(radius_for(470), None);
}

#[test]
fn seating_matches_the_vectors() {
    let v = vectors();
    let instance = v["seats"][0]["instance"].as_str().unwrap();
    for s in v["seats"].as_array().unwrap() {
        assert_eq!(seat_start(instance, s["address"].as_str().unwrap()) as u64, s["start"].as_u64().unwrap());
    }
    for r in v["random"].as_array().unwrap() {
        let taken: BTreeSet<(i64, i64)> = r["taken"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| {
                let (a, b) = k.as_str().unwrap().split_once(',').unwrap();
                (a.parse().unwrap(), b.parse().unwrap())
            })
            .collect();
        let got = random_seat(instance, r["address"].as_str().unwrap(), r["radius"].as_i64().unwrap(), &taken).unwrap();
        assert_eq!(got, (r["cell"][0].as_i64().unwrap(), r["cell"][1].as_i64().unwrap()));
    }
}

fn paint(p: &J) -> Paint {
    Paint {
        h: p["h"].as_i64().unwrap(),
        ts: 0,
        owner: p["owner"].as_str().unwrap().into(),
        q: p["q"].as_i64().unwrap(),
        r: p["r"].as_i64().unwrap(),
        colour: p["colour"].as_str().map(String::from),
    }
}

#[test]
fn the_body_and_preview_match_the_vectors() {
    let v = vectors();
    let b = &v["body"];
    let paints: Vec<Paint> = b["paints"].as_array().unwrap().iter().map(paint).collect();
    let bytes = encode_body(2, b["from"].as_i64().unwrap(), b["to"].as_i64().unwrap(), &paints).unwrap();
    assert_eq!(hex::encode(&bytes), b["hex"].as_str().unwrap());
    let d = decode_body(&bytes).unwrap();
    assert_eq!(d.paints, paints);
    assert!(decode_body(&bytes[..bytes.len() - 1]).is_err());
    let mut extra = bytes.clone();
    extra.push(0);
    assert_eq!(decode_body(&extra), Err(BodyError::Trailing));

    let pv = &v["preview"];
    let cells: BTreeMap<(i64, i64), Option<String>> = pv["cells"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let (a, c) = e[0].as_str().unwrap().split_once(',').unwrap();
            ((a.parse().unwrap(), c.parse().unwrap()), e[1].as_str().map(String::from))
        })
        .collect();
    let (palette, frame) = encode_preview(2, &cells);
    assert_eq!(frame, pv["frame"].as_str().unwrap());
    assert_eq!(serde_json::to_value(&palette).unwrap(), pv["palette"]);
}

#[test]
fn bodies_refuse_out_of_order_history_and_bad_colours() {
    let p = |h, c: &str| Paint { h, ts: 0, owner: "a".into(), q: 0, r: 0, colour: Some(c.into()) };
    assert_eq!(encode_body(1, 5, 9, &[p(4, "#000000")]), Err(BodyError::Order));
    assert!(matches!(encode_body(1, 0, 9, &[p(1, "#f3d630")]), Err(BodyError::Colour(_))));
    let ordered = order_paints(vec![
        Paint { h: 5, ts: 2, owner: "b".into(), q: 0, r: 0, colour: None },
        Paint { h: 3, ts: 9, owner: "c".into(), q: 1, r: 0, colour: None },
        Paint { h: 5, ts: 2, owner: "a".into(), q: 0, r: 1, colour: None },
    ]);
    assert_eq!(ordered.iter().map(|p| p.owner.as_str()).collect::<Vec<_>>(), ["c", "a", "b"]);
}

#[test]
fn the_environment_follows_the_design() {
    let g = f1r3games_games::get("f1r3pix").unwrap();
    let env = g.env_template().source;
    // paint names no cell; seat checks the key; nothing binds vault authority.
    assert!(env.contains(r#"contract env(@"paint", @instance, @colour, ret)"#));
    assert!(env.contains(r#"vaultAddress!("fromPublicKey", pk, *aCh)"#));
    assert!(!env.contains("rho:vault:system") && !env.contains("deployerId"));
    // The retired canvas methods are gone.
    assert!(!env.contains(r#"@"place""#) && !env.contains(r#"@"state""#));
    assert_eq!(g.capabilities, ["pay", "open"]);
    let man = g.manifest("rho:id:6zcfqnwnaqcwpeyuysx1rm48ndr6sgsbbgjuwf45i5nor3io7dr76j", "https://games.example/play");
    let caps = man.get("capabilities").unwrap();
    assert_eq!(caps, &f1r3games_core::Value::List(vec![f1r3games_core::Value::str("pay"), f1r3games_core::Value::str("open")]));
}
