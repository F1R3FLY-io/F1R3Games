//! `f1r3games beat …` — F1R3Beat's breeder (design v2 §10, D14–D15).
//!
//! * `beat set-breeder ADDRESS` names the breeder; sign it with F1R3Beat's
//!   own environment key active (import it with `key import`).
//! * `beat epoch --nursery INSTANCE` runs the next epoch with the breeder key
//!   active: admits game patterns published since the last epoch and crosses
//!   that two people have liked, selects parents by weight, publishes the
//!   brood into the nursery instance (an F1R3Beat instance the breeder joined),
//!   culls, and records the epoch on the chain in one `f1r3beat.epoch`.
//! * `beat verify --epoch N` recomputes an epoch from its record and the
//!   members' own records, and reports whether the breeder told the truth.

use crate::{now_ms, Ctx};
use anyhow::{anyhow, bail, Context, Result};
use f1r3games_core::Value;
use f1r3games_games::beat::{self, Pattern, Shape};
use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, BTreeSet};

const GAME: &str = "f1r3beat";
const DAY_MS: i64 = 86_400_000;

fn args<const N: usize>(kv: [(&str, Value); N]) -> BTreeMap<String, Value> {
    kv.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// An explore read: (value, block hash).
async fn read(ctx: &Ctx, template: &str, game: Option<&str>, a: BTreeMap<String, Value>) -> Result<(Value, String)> {
    let args_json: Json = Json::Object(a.iter().map(|(k, v)| (k.clone(), v.to_typed_json())).collect());
    let r = ctx.client.post("/api/explore", json!({ "template": template, "game": game, "args": args_json })).await?;
    if r["ok"] != Json::Bool(true) {
        bail!("{template}: {}", r["error"]);
    }
    Ok((Value::from_typed_json(&r["value"])?, r["blockHash"].as_str().unwrap_or_default().to_string()))
}

fn shape_of(v: &Value) -> Option<Shape> {
    let m = match v.get("meter") {
        Some(Value::List(l)) => l.iter().filter_map(Value::as_int).collect::<Vec<_>>(),
        _ => return None,
    };
    let (k, bars) = (v.get("column")?.as_int()?, v.get("bars").and_then(Value::as_int));
    let bars = bars.or_else(|| v.get("steps")?.as_int().map(|s| s * m[1] / (m[0] * k)))?;
    Shape::new(*m.first()?, *m.get(1)?, bars, k)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::List(l)) => l.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec![],
    }
}

async fn body(ctx: &Ctx, play: &str) -> Result<Pattern> {
    let (b, _) = read(ctx, "plays.body", None, args([("id", Value::str(play)), ("version", Value::Int(-1))])).await?;
    let Value::Bytes(bytes) = b else { bail!("play {play} has no body") };
    Ok(beat::decode_pattern_body(&bytes).map_err(|e| anyhow!("play {play}: {e}"))?.0)
}

async fn counts(ctx: &Ctx, play: &str) -> Result<(u64, u64)> {
    let (c, _) = read(ctx, "engagement.counts", None, args([("play", Value::str(play))])).await?;
    let n = |k: &str| c.get(k).and_then(Value::as_int).unwrap_or(0).max(0) as u64;
    Ok((n("play"), n("like")))
}

struct Pop {
    members: Vec<Value>,
    epoch: Option<i64>,
    block: String,
}

async fn population(ctx: &Ctx) -> Result<Pop> {
    let mut members = vec![];
    let mut block = String::new();
    let mut epoch;
    loop {
        let (v, b) = read(ctx, "f1r3beat.population", Some(GAME), args([("cursor", Value::Int(members.len() as i64))])).await?;
        if block.is_empty() {
            block = b;
        }
        epoch = v.get("epoch").and_then(Value::as_int);
        let size = v.get("size").and_then(Value::as_int).unwrap_or(0) as usize;
        let page = match v.get("members") {
            Some(Value::List(l)) => l.clone(),
            _ => vec![],
        };
        let empty = page.is_empty();
        members.extend(page);
        if members.len() >= size || empty {
            return Ok(Pop { members, epoch, block });
        }
    }
}

pub async fn set_breeder(ctx: &mut Ctx, address: &str) -> Result<()> {
    let (d, _) = ctx.call_in("f1r3beat.setBreeder", Some(GAME), args([("address", Value::str(address))]), &[], Some(2_000_000)).await?;
    println!("{}", json!({ "deployId": d, "breeder": address }));
    Ok(())
}

pub async fn epoch(ctx: &mut Ctx, nursery: &str, epoch: Option<i64>, days: i64, dry_run: bool) -> Result<()> {
    let pop = population(ctx).await?;
    let e = epoch.unwrap_or(pop.epoch.map(|x| x + 1).unwrap_or(0));
    if let Some(last) = pop.epoch {
        if e <= last {
            bail!("epoch {e} is not after the last epoch, {last}");
        }
    }
    let block = hex::decode(&pop.block).context("the population read carried no block hash")?;
    // Since when to look for new patterns: the last epoch's time, else `days` ago.
    let since = match pop.epoch {
        Some(last) => read(ctx, "f1r3beat.epochRecord", Some(GAME), args([("epoch", Value::Int(last))])).await?.0.get("at").and_then(Value::as_int).unwrap_or(now_ms() - days * DAY_MS),
        None => now_ms() - days * DAY_MS,
    };
    let known: BTreeSet<String> = pop.members.iter().filter_map(|m| m.get("digest").and_then(Value::as_str).map(String::from)).collect();
    let mut patterns: BTreeMap<String, Pattern> = BTreeMap::new();
    let mut members: Vec<beat::Member> = vec![];
    let mut weights: BTreeMap<String, u64> = BTreeMap::new();
    let mut play_of: BTreeMap<String, String> = BTreeMap::new();
    for m in &pop.members {
        let (Some(d), Some(play)) = (m.get("digest").and_then(Value::as_str), m.get("play").and_then(Value::as_str)) else { continue };
        let p = body(ctx, play).await?;
        let (plays, likes) = counts(ctx, play).await?;
        let w = beat::weight(plays, likes);
        members.push(beat::Member { digest: d.into(), shape: p.shape, born: m.get("born").and_then(Value::as_int).unwrap_or(0), weight: w });
        weights.insert(d.into(), w);
        play_of.insert(d.into(), play.into());
        patterns.insert(d.into(), p);
    }
    // New members: game patterns, and crosses two people have liked (D15).
    let mut admitted: Vec<Value> = vec![];
    for day in (since / DAY_MS)..=(now_ms() / DAY_MS) {
        let (list, _) = read(ctx, "plays.list", None, args([("game", Value::str(GAME)), ("kind", Value::str("pattern")), ("day", Value::Int(day))])).await?;
        let Value::List(list) = list else { continue };
        for h in list {
            let (Some(id), Some(d), Some(origin)) = (h.get("id").and_then(Value::as_str), h.get("digest").and_then(Value::as_str), h.get("origin").and_then(Value::as_str)) else { continue };
            if known.contains(d) || weights.contains_key(d) || !(origin == "game" || origin == "cross") {
                continue;
            }
            let (plays, likes) = counts(ctx, id).await?;
            if origin == "cross" && likes < beat::CROSS_LIKES {
                continue;
            }
            let p = match body(ctx, id).await {
                Ok(p) if p.digest() == d && shape_of(&h) == Some(p.shape) => p,
                Ok(_) => {
                    eprintln!("skipping {id}: its header does not describe its body");
                    continue;
                }
                Err(err) => {
                    eprintln!("skipping {id}: {err}");
                    continue;
                }
            };
            let w = beat::weight(plays, likes);
            admitted.push(beat::member_record(&p, id, origin, &strings(h.get("parents"))));
            members.push(beat::Member { digest: d.into(), shape: p.shape, born: e, weight: w });
            weights.insert(d.into(), w);
            play_of.insert(d.into(), id.into());
            patterns.insert(d.into(), p);
        }
    }
    let out = beat::run_epoch(&block, e, &members, &patterns);
    let mut published = vec![];
    if !dry_run {
        for c in &out.children {
            let parents = [play_of[&c.parents[0]].as_str(), play_of[&c.parents[1]].as_str()];
            let title = format!("Bred {} · epoch {e}", c.operator);
            let header = beat::bred_header(&c.pattern, &title, parents, c.operator, &pop.block, e);
            let body = beat::encode_pattern_body(&c.pattern, &BTreeMap::new());
            let (_, derived) = ctx
                .call_in(
                    "plays.publish",
                    None,
                    args([("instance", Value::str(nursery)), ("kind", Value::str("pattern")), ("header", header), ("body", Value::Bytes(body))]),
                    &["id".to_string()],
                    Some(10_000_000),
                )
                .await?;
            let id = derived["id"].as_str().ok_or_else(|| anyhow!("plays.publish derived no id"))?.to_string();
            for p in parents {
                ctx.call_in("plays.link", None, args([("id", Value::str(id.clone())), ("other", Value::str(p))]), &[], Some(2_000_000)).await?;
            }
            admitted.push(beat::member_record(&c.pattern, &id, "bred", &[parents[0].to_string(), parents[1].to_string()]));
            published.push(id);
        }
    }
    let record = Value::map([
        ("block", Value::str(pop.block.clone())),
        ("weights", Value::Map(weights.iter().map(|(d, w)| (d.clone(), Value::Int(*w as i64))).collect())),
        ("parents", Value::List(out.parents.iter().flat_map(|(a, b)| [Value::str(a.clone()), Value::str(b.clone())]).collect())),
        ("admitted", Value::List(admitted)),
        ("culled", Value::List(out.culled.iter().map(|d| Value::str(d.clone())).collect())),
    ]);
    let summary = json!({
        "epoch": e, "block": pop.block, "members": members.len(),
        "parents": out.parents.as_ref().map(|(a, b)| [a, b]),
        "children": out.children.iter().map(|c| c.pattern.digest()).collect::<Vec<_>>(),
        "published": published, "culled": out.culled,
    });
    if dry_run {
        println!("{}", serde_json::to_string_pretty(&json!({ "dryRun": true, "summary": summary, "record": record.to_typed_json() }))?);
        return Ok(());
    }
    let (d, _) = ctx.call_in("f1r3beat.epoch", Some(GAME), args([("epoch", Value::Int(e)), ("record", record)]), &[], Some(50_000_000)).await?;
    println!("{}", json!({ "deployId": d, "summary": summary }));
    Ok(())
}

pub async fn verify(ctx: &Ctx, e: i64) -> Result<()> {
    let (rec, _) = read(ctx, "f1r3beat.epochRecord", Some(GAME), args([("epoch", Value::Int(e))])).await?;
    if rec == Value::Nil {
        bail!("no record of epoch {e}");
    }
    let block_hex = rec.get("block").and_then(Value::as_str).ok_or_else(|| anyhow!("the record has no block"))?.to_string();
    let weights: BTreeMap<String, u64> = match rec.get("weights") {
        Some(Value::Map(m)) => m.iter().map(|(d, w)| (d.clone(), w.as_int().unwrap_or(1).max(1) as u64)).collect(),
        _ => bail!("the record has no weights"),
    };
    let mut members = BTreeMap::new();
    let mut patterns = BTreeMap::new();
    let mut problems = vec![];
    for (d, w) in &weights {
        let (m, _) = read(ctx, "f1r3beat.member", Some(GAME), args([("digest", Value::str(d.clone()))])).await?;
        let play = m.get("play").and_then(Value::as_str).ok_or_else(|| anyhow!("member {d} has no play"))?;
        let p = body(ctx, play).await?;
        if &p.digest() != d {
            problems.push(format!("member {d}: its play's body has digest {}", p.digest()));
        }
        // Recorded weights can only have grown since: they are counts of distinct addresses.
        let (plays, likes) = counts(ctx, play).await?;
        if beat::weight(plays, likes) < *w {
            problems.push(format!("member {d}: recorded weight {w} exceeds today's {}", beat::weight(plays, likes)));
        }
        members.insert(d.clone(), (p.shape, m.get("born").and_then(Value::as_int).unwrap_or(0)));
        patterns.insert(d.clone(), p);
    }
    let out = beat::verify_epoch(&hex::decode(&block_hex)?, e, &weights, &members, &patterns).map_err(|x| anyhow!(x))?;
    let want_parents = strings(rec.get("parents"));
    let got_parents: Vec<String> = out.parents.iter().flat_map(|(a, b)| [a.clone(), b.clone()]).collect();
    if got_parents != want_parents {
        problems.push(format!("parents: recorded {want_parents:?}, recomputed {got_parents:?}"));
    }
    let bred: Vec<String> = match rec.get("admitted") {
        Some(Value::List(l)) => l.iter().filter(|m| m.get("origin").and_then(Value::as_str) == Some("bred")).filter_map(|m| m.get("digest").and_then(Value::as_str).map(String::from)).collect(),
        _ => vec![],
    };
    let children: Vec<String> = out.children.iter().map(|c| c.pattern.digest()).collect();
    if bred != children {
        problems.push(format!("brood: recorded {bred:?}, recomputed {children:?}"));
    }
    let culled = strings(rec.get("culled"));
    if culled != out.culled {
        problems.push(format!("culled: recorded {culled:?}, recomputed {:?}", out.culled));
    }
    println!("{}", json!({ "epoch": e, "verified": problems.is_empty(), "problems": problems, "parents": got_parents, "children": children, "culled": out.culled }));
    if !problems.is_empty() {
        bail!("epoch {e} does not verify");
    }
    Ok(())
}
