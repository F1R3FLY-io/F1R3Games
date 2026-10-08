//! `f1r3games ink …` — F1R3Ink's relay (design §8, D2, D10).
//!
//! * `ink set-relay ADDRESS` names the relay, the one key allowed to write
//!   anonymous stripes; sign it with F1R3Ink's own environment key active
//!   (import it with `key import`). The service's relay key is made with
//!   `f1r3games-service relay-keygen`, which prints its address.

use crate::Ctx;
use anyhow::Result;
use f1r3games_core::{Address, Value};
use serde_json::json;

const GAME: &str = "f1r3ink";

pub async fn set_relay(ctx: &mut Ctx, address: &str) -> Result<()> {
    Address::parse(address).map_err(|e| anyhow::anyhow!("{address}: {e}"))?;
    let args = [("address".to_string(), Value::str(address))].into_iter().collect();
    let (d, _) = ctx.call_in("f1r3ink.setRelay", Some(GAME), args, &[], Some(2_000_000)).await?;
    println!("{}", json!({ "deployId": d, "relay": address }));
    Ok(())
}
