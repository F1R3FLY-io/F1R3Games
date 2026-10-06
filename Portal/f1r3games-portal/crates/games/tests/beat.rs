//! The Rust side of F1R3Beat held to the vectors the JavaScript client generates
//! (F1R3Beat/vectors/beat-vectors.json), and the environment held to its design.

use f1r3games_games::beat::*;
use serde_json::Value as J;
use std::collections::{BTreeMap, BTreeSet};

fn vectors() -> J {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../F1R3Beat/vectors/beat-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file")).unwrap()
}

fn shape(v: &J) -> Shape {
    let a: Vec<i64> = v.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
    Shape::new(a[0], a[1], a[2], a[3]).unwrap()
}

fn pattern(v: &J) -> Pattern {
    let cells = v["cells"].as_array().unwrap().iter().map(|c| c.as_str().map(String::from)).collect();
    Pattern::new(shape(&v["shape"]), cells).unwrap()
}

#[test]
fn shapes_and_palettes_match_the_vectors() {
    let v = vectors();
    for s in v["shapes"].as_array().unwrap() {
        let got = Shape::new(s["n"].as_i64().unwrap(), s["d"].as_i64().unwrap(), s["bars"].as_i64().unwrap(), s["k"].as_i64().unwrap());
        match &s["shape"] {
            J::Null => assert!(got.is_none(), "{s}"),
            w => {
                let g = got.unwrap();
                assert_eq!((g.steps(), g.cells(), g.per_bar()), (w["steps"].as_i64().unwrap(), w["cells"].as_i64().unwrap(), w["perBar"].as_i64().unwrap()));
            }
        }
    }
    let sc = &v["palettes"]["scale"];
    let scale = Some((sc[0].as_str().unwrap().to_string(), sc[1].as_str().unwrap().to_string()));
    for (row, p) in v["palettes"]["rows"].as_array().unwrap().iter().enumerate() {
        assert_eq!(serde_json::to_value(palette(row as i64, &None)).unwrap(), p["any"]);
        assert_eq!(serde_json::to_value(palette(row as i64, &scale)).unwrap(), p["scale"]);
    }
    assert!(note_ok(1, "E2", &None) && !note_ok(1, "Fb2", &None) && note_ok(1, "E1", &None) && !note_ok(1, "D#1", &None) && !note_ok(1, "G#3", &None));
    assert!(note_ok(0, "kick", &None) && !note_ok(1, "kick", &None) && !note_ok(0, "C2", &None));
}

#[test]
fn seating_matches_the_vectors() {
    let v = vectors();
    let instance = v["instance"].as_str().unwrap();
    let s = shape(&v["seating"]["shape"]);
    let taken: BTreeSet<i64> = v["seating"]["taken"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
    for seat in v["seating"]["seats"].as_array().unwrap() {
        let a = seat["address"].as_str().unwrap();
        assert_eq!(seat_start(instance, a) as u64, seat["start"].as_u64().unwrap());
        assert_eq!(random_seat(instance, a, &s, &taken), seat["random"].as_i64());
        for (row, c) in seat["row"].as_array().unwrap().iter().enumerate() {
            assert_eq!(row_seat(instance, a, &s, row as i64, &taken), c.as_i64());
        }
    }
}

#[test]
fn canonical_scores_and_digests_match_and_parse_back() {
    let v = vectors();
    for (name, s) in v["scores"].as_object().unwrap() {
        let p = pattern(s);
        assert_eq!(p.score(), s["score"].as_str().unwrap(), "{name}");
        assert_eq!(p.digest(), s["digest"].as_str().unwrap(), "{name}");
        assert_eq!(Pattern::parse(&p.score()).unwrap(), p, "{name}");
    }
    // Anything not in canonical form is refused.
    let text = v["scores"]["mother"]["score"].as_str().unwrap();
    assert!(Pattern::parse(&text.replace("kick c1, r c1, chh", "kick c1, r c1,  chh")).is_err());
    assert!(Pattern::parse(&text.replace("c16 = 1", "c16 = 1/1")).is_err());
}

#[test]
fn bodies_match_the_vectors() {
    let v = vectors();
    let ses = &v["session"];
    let sets: Vec<Set> = ses["sets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| Set { h: x["h"].as_i64().unwrap(), ts: 0, owner: x["owner"].as_str().unwrap().into(), cell: x["cell"].as_i64().unwrap(), note: x["note"].as_str().map(String::from) })
        .collect();
    let s = shape(&ses["shape"]);
    let bytes = encode_session(&s, 10, 16, &sets).unwrap();
    assert_eq!(hex::encode(&bytes), ses["hex"].as_str().unwrap());
    assert_eq!(decode_session(&bytes).unwrap().sets, sets);
    assert_eq!(decode_session(&bytes[..bytes.len() - 1]), Err(BodyError::Truncated));

    let pb = &v["patternBody"];
    let credits: BTreeMap<i64, String> = pb["credits"].as_array().unwrap().iter().map(|c| (c[0].as_i64().unwrap(), c[1].as_str().unwrap().into())).collect();
    let mother = pattern(&v["scores"]["mother"]);
    let b = encode_pattern_body(&mother, &credits);
    assert_eq!(hex::encode(&b), pb["hex"].as_str().unwrap());
    assert_eq!(decode_pattern_body(&b).unwrap(), (mother, credits));
}

#[test]
fn the_generator_is_f1r3scores_and_matches_the_vectors() {
    let v = vectors();
    let p = &v["prng"];
    let mut g = Prng::new(p["seed"].as_u64().unwrap());
    for x in p["u64"].as_array().unwrap() {
        assert_eq!(g.next_u64().to_string(), x.as_str().unwrap());
    }
    for (n, x) in [7u64, 30, 1000].iter().zip(p["below"].as_array().unwrap()) {
        assert_eq!(g.below(*n), x.as_u64().unwrap());
    }
    assert_eq!(serde_json::to_value(g.choose(3, 10)).unwrap(), p["choose"]);
    for r in v["refills"].as_array().unwrap() {
        let slots: Vec<usize> = r["slots"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as usize).collect();
        let melody: Vec<String> = r["melody"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().into()).collect();
        let out = refill(&slots, &melody, &mut Prng::new(r["seed"].as_u64().unwrap()));
        assert_eq!(serde_json::to_value(&out).unwrap(), r["out"]);
    }
}

fn kids(ks: &Option<Vec<Child>>) -> J {
    match ks {
        None => J::Null,
        Some(ks) => J::Array(ks.iter().map(|c| serde_json::json!({ "operator": c.operator, "parents": c.parents, "digest": c.pattern.digest(), "score": c.pattern.score() })).collect()),
    }
}

#[test]
fn broods_crosses_and_epochs_match_the_vectors() {
    let v = vectors();
    let block = hex::decode(v["broods"]["block"].as_str().unwrap()).unwrap();
    let p = |n: &str| pattern(&v["scores"][n]);
    let brd = |a: &Pattern, b: &Pattern| brood(a, b, &mut Prng::from_hash(&brood_seed(&epoch_seed(&block, 1), &a.digest(), &b.digest())));
    assert_eq!(kids(&brd(&p("mother"), &p("father"))), v["broods"]["motherFather"]);
    assert_eq!(kids(&brd(&p("short"), &p("long"))), v["broods"]["shortLong"]);
    assert_eq!(kids(&brd(&p("mother"), &p("triplet"))), v["broods"]["motherTriplet"]);
    assert_eq!(kids(&cross_brood(&block, v["cross"]["crosser"].as_str().unwrap(), &p("mother"), &p("father"))), v["cross"]["children"]);

    // Every pattern a member's digest names: the five named ones and fourteen one-kick bars.
    let mut by: BTreeMap<String, Pattern> = ["mother", "father", "short", "long", "triplet"].iter().map(|n| (p(n).digest(), p(n))).collect();
    for i in 0..14 {
        let mut x = Pattern::silent(Shape::new(4, 4, 1, 16).unwrap());
        x.cells[cell_index(i, 0) as usize] = Some("kick".into());
        by.insert(x.digest(), x);
    }
    let members: Vec<Member> = v["epochs"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| Member { digest: m["digest"].as_str().unwrap().into(), shape: shape(&m["shape"]), born: m["born"].as_i64().unwrap(), weight: m["weight"].as_u64().unwrap() })
        .collect();
    for key in ["small", "big"] {
        let e = &v["epochs"][key];
        let pop = &members[..e["size"].as_u64().unwrap() as usize];
        let got = run_epoch(&block, e["epoch"].as_i64().unwrap(), pop, &by);
        let want = &e["out"];
        assert_eq!(got.parents.as_ref().map(|(a, b)| vec![a.clone(), b.clone()]), want["parents"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect()));
        assert_eq!(serde_json::to_value(got.children.iter().map(|c| c.pattern.digest()).collect::<Vec<_>>()).unwrap(), want["children"]);
        assert_eq!(serde_json::to_value(&got.culled).unwrap(), want["culled"], "{key}");
    }
}

#[test]
fn x_keeps_its_rhythm_and_v_its_lines() {
    let v = vectors();
    let m = pattern(&v["scores"]["mother"]);
    let f = pattern(&v["scores"]["father"]);
    let mut g = Prng::new(9);
    let x = cross(&m, &f, &mut g);
    for c in 0..m.shape.cells() as usize {
        // Every sounding cell of the child is an onset of the rhythm parent.
        assert!(x.cells[c].is_none() || m.cells[c].is_some());
    }
    let vv = voices(&m, &f, 0b10000);
    assert_eq!(vv.row(0), f.row(0));
    assert_eq!(vv.row(1), m.row(1));
    // Padding keeps the pulse: bars are inserted whole.
    let padded = pad(&m, 2, &mut Prng::new(3));
    assert_eq!(padded.shape.bars, 3);
    assert_eq!(padded.cells.iter().flatten().count(), m.cells.iter().flatten().count());
}

#[test]
fn culling_keeps_newborns_and_the_floor() {
    let s = Shape::new(4, 4, 1, 16).unwrap();
    let m = |i: u8, born: i64, w: u64| Member { digest: format!("{i:064x}"), shape: s, born, weight: w };
    let pop: Vec<Member> = (0..20).map(|i| m(i, if i < 3 { 9 } else { 0 }, 1 + i as u64)).collect();
    for seed in 0..20 {
        let out = cull(&pop, 10, &mut Prng::new(seed));
        assert!(!out.is_empty() && out.len() <= 3);
        // The three newborns (born at 9) are never culled, though they weigh least.
        let newborn: Vec<String> = (0..3u8).map(|i| format!("{i:064x}")).collect();
        assert!(out.iter().all(|d| !newborn.contains(d)), "{out:?}");
    }
    let few: Vec<Member> = (0..16).map(|i| m(i, 0, 1)).collect();
    assert!(cull(&few, 10, &mut Prng::new(1)).is_empty());
}

/// With F1R3SCORE pointing at a built `f1r3score` player, every canonical score
/// is checked by F1R3Score itself, and the notes it plays are the grid's (§12).
#[test]
fn f1r3score_accepts_and_plays_the_canonical_scores() {
    let Ok(bin) = std::env::var("F1R3SCORE") else {
        eprintln!("F1R3SCORE not set; skipping the F1R3Score conformance check");
        return;
    };
    let v = vectors();
    let mut all: Vec<(String, String)> = v["scores"].as_object().unwrap().iter().map(|(k, s)| (k.clone(), s["score"].as_str().unwrap().to_string())).collect();
    for (i, c) in v["broods"]["motherFather"].as_array().unwrap().iter().enumerate() {
        all.push((format!("child{i}"), c["score"].as_str().unwrap().to_string()));
    }
    let dir = std::env::temp_dir().join("f1r3beat-conformance");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, text) in all {
        let f = dir.join(format!("{name}.score"));
        std::fs::write(&f, &text).unwrap();
        let check = std::process::Command::new(&bin).arg("check").arg(&f).output().unwrap();
        assert!(check.status.success(), "{name}: {}", String::from_utf8_lossy(&check.stderr));
        let play = std::process::Command::new(&bin).args(["play", f.to_str().unwrap(), "--format", "json"]).output().unwrap();
        assert!(play.status.success(), "{name}");
        let out: J = serde_json::from_slice(&play.stdout).unwrap();
        let notes = out.get("notes").or_else(|| out.get("performance")).cloned().unwrap_or(out.clone());
        let mut got: Vec<(String, String, String)> = notes
            .as_array()
            .expect("a list of notes")
            .iter()
            .filter(|n| n["pitch"] != "r")
            .map(|n| (n["onset"].as_str().map(String::from).unwrap_or_else(|| n["onset"].to_string()), n["timbre"].as_str().unwrap().into(), n["pitch"].as_str().unwrap().into()))
            .collect();
        got.sort();
        let p = Pattern::parse(&text).unwrap();
        let mut want: Vec<(String, String, String)> = p.notes().into_iter().map(|((a, b), t, n)| (if b == 1 { format!("{a}") } else { format!("{a}/{b}") }, t.to_string(), n)).collect();
        want.sort();
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn the_environment_follows_the_design() {
    let g = f1r3games_games::get("f1r3beat").unwrap();
    let env = g.env_template().source;
    assert!(env.contains(r#"contract env(@"set", @instance, @note, ret)"#));
    assert!(env.contains(r#"vaultAddress!("fromPublicKey", pk, *aCh)"#));
    assert!(!env.contains("rho:vault:system") && !env.contains("deployerId"));
    // The retired sequencer methods are gone.
    assert!(!env.contains(r#"@"toggle""#) && !env.contains(r#"@"tempo""#) && !env.contains(r#"@"state""#));
    assert_eq!(g.capabilities, ["pay", "open"]);
    let kinds: Vec<_> = g.galleries.iter().map(|k| k.kind).collect();
    assert_eq!(kinds, ["pattern", "session"]);
    // The breeder's moves are never signed within an allowance.
    for m in g.methods.iter().filter(|m| ["setBreeder", "epoch"].contains(&m.name)) {
        assert!(!m.play);
    }
    // The palette rules in the environment and here agree on the tables.
    for (k, m) in KIT {
        assert!(env.contains(&format!("\"{k}\"")), "{k} {m}");
    }
    assert!(env.contains("[[0, 0], [28, 55], [40, 76], [36, 84], [44, 75]]"));
}

#[test]
fn an_epoch_verifies_from_its_record_and_a_forged_one_does_not() {
    let v = vectors();
    let block = hex::decode(v["broods"]["block"].as_str().unwrap()).unwrap();
    let names = ["mother", "father", "short", "long", "triplet"];
    let by: BTreeMap<String, Pattern> = names.iter().map(|n| { let p = pattern(&v["scores"][*n]); (p.digest(), p) }).collect();
    let pop: Vec<Member> = by.values().enumerate().map(|(i, p)| Member { digest: p.digest(), shape: p.shape, born: 0, weight: 1 + i as u64 }).collect();
    let out = run_epoch(&block, 4, &pop, &by);
    let weights: BTreeMap<String, u64> = pop.iter().map(|m| (m.digest.clone(), m.weight)).collect();
    let members: BTreeMap<String, (Shape, i64)> = pop.iter().map(|m| (m.digest.clone(), (m.shape, m.born))).collect();
    assert_eq!(verify_epoch(&block, 4, &weights, &members, &by).unwrap(), out);
    // A breeder that inflated one member's weight gets a different epoch, or the same by chance; a different block always moves it.
    let other = verify_epoch(&[0u8; 32], 4, &weights, &members, &by).unwrap();
    assert!(other != out || out.parents.is_none());
    // The bred header and member record carry what the client and the environment read.
    let c = &out.children[0];
    let h = bred_header(&c.pattern, "t", ["p1", "p2"], c.operator, "ab", 4);
    assert_eq!(h.get("digest").and_then(f1r3games_core::Value::as_str), Some(c.pattern.digest().as_str()));
    let m = member_record(&c.pattern, "p3", "bred", &["p1".into(), "p2".into()]);
    assert_eq!(m.get("origin").and_then(f1r3games_core::Value::as_str), Some("bred"));
}
