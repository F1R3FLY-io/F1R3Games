//! `f1r3games` — a Rust client of the portal service and the F1R3Games
//! wallet. The web shell does the same through the wallet's wasm bindings.
//!
//! State lives in `$F1R3GAMES_HOME` (default `~/.f1r3games`): the encrypted
//! keystore, the encrypted contact book, and the pinned service settings.
//! The passphrase is read from `F1R3GAMES_PASSPHRASE` or from stdin.

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use f1r3games_core::invite::{self, InviteKey};
use f1r3games_core::{Address, Value};
use f1r3games_wallet::contacts::{ContactBook, StorageMode};
use f1r3games_wallet::keystore::{Keystore, DEFAULT_PBKDF2_ITERATIONS};
use f1r3games_wallet::policy::{Decision, Origin, Policy, SignRequest};
use f1r3games_wallet::wallet::{Consent, Wallet};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "f1r3games", about = "F1R3Games portal client")]
struct Cli {
    /// Portal service base URL.
    #[arg(long, env = "F1R3GAMES_SERVICE", default_value = "http://127.0.0.1:8640")]
    service: String,
    /// Sign prompted requests without asking.
    #[arg(long, short = 'y')]
    yes: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create the keystore and a first key; pins the service's environment.
    Init,
    /// Keys in the keystore.
    Key {
        #[command(subcommand)]
        cmd: KeyCmd,
    },
    /// Show the service's environment.
    Env,
    /// Balance of the active (or given) address.
    Balance { address: Option<String> },
    /// Ask the testnet faucet to fund the active address.
    Faucet,
    /// Set the active key's profile.
    Profile {
        #[arg(long)]
        name: String,
        #[arg(long, value_delimiter = ',')]
        tags: Vec<String>,
    },
    /// Launch an instance of a game (unlisted unless --visibility says otherwise).
    Launch {
        game: String,
        #[arg(long, default_value = "unlisted")]
        visibility: String,
    },
    /// Invitations.
    Invite {
        #[command(subcommand)]
        cmd: InviteCmd,
    },
    /// Contacts (encrypted on this device; optional encrypted on-chain backup).
    Contacts {
        #[command(subcommand)]
        cmd: ContactsCmd,
    },
    /// Call any deploy template: `call instances.join --args '{"id":"..."}'`.
    Call {
        template: String,
        #[arg(long, default_value = "{}")]
        args: String,
        #[arg(long, value_delimiter = ',')]
        derive: Vec<String>,
        #[arg(long)]
        phlo_limit: Option<i64>,
    },
    /// Run any explore template: `read games.list`.
    Read {
        template: String,
        #[arg(long, default_value = "{}")]
        args: String,
    },
}

#[derive(Subcommand)]
enum KeyCmd {
    New { #[arg(default_value = "key")] label: String },
    Import { file: PathBuf, #[arg(default_value = "imported")] label: String },
    Export { address: Option<String> },
    List,
    Use { address: String },
    /// Enrol a passkey given its credential id and PRF output (hex), as the
    /// web shell does after `navigator.credentials.get`.
    Passkey { credential_id: String, prf_hex: String },
}

#[derive(Subcommand)]
enum InviteCmd {
    /// Issue an invitation to an instance and print its link.
    Create {
        instance: String,
        #[arg(long, default_value_t = 1)]
        uses: i64,
        /// Block height after which the invitation lapses.
        #[arg(long, default_value_t = i64::MAX)]
        expires_at: i64,
        /// A sponsorship whose stipend the invitee receives.
        #[arg(long)]
        sponsorship: Option<String>,
    },
    /// Redeem an invitation link with the active key.
    Redeem { link: String },
}

#[derive(Subcommand)]
enum ContactsCmd {
    Add { name: String, kind: String, handle: String },
    ImportCsv { file: PathBuf },
    ImportVcard { file: PathBuf },
    List,
    /// Choose client-only storage or encrypted on-chain backup.
    Mode { mode: String },
    /// Save the encrypted contact book on chain (requires backup mode).
    Backup,
    /// Restore the contact book from the on-chain backup.
    Restore,
}

fn home() -> PathBuf {
    std::env::var_os("F1R3GAMES_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".f1r3games"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn passphrase() -> Result<String> {
    if let Ok(p) = std::env::var("F1R3GAMES_PASSPHRASE") {
        return Ok(p);
    }
    eprint!("passphrase: ");
    std::io::stderr().flush()?;
    let mut s = String::new();
    std::io::stdin().lock().read_line(&mut s)?;
    Ok(s.trim_end_matches(['\r', '\n']).to_string())
}

struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    async fn get(&self, path: &str) -> Result<Json> {
        let r = self.http.get(format!("{}{path}", self.base)).send().await?;
        let s = r.status();
        let j: Json = r.json().await?;
        if !s.is_success() {
            bail!("{path}: {}", j);
        }
        Ok(j)
    }

    async fn post(&self, path: &str, body: Json) -> Result<Json> {
        let r = self.http.post(format!("{}{path}", self.base)).json(&body).send().await?;
        let s = r.status();
        let j: Json = r.json().await?;
        if !s.is_success() {
            bail!("{path}: {}", j);
        }
        Ok(j)
    }
}

struct Ctx {
    client: Client,
    wallet: Wallet,
    yes: bool,
}

fn settings_path() -> PathBuf {
    home().join("settings.json")
}

fn keystore_path() -> PathBuf {
    home().join("keystore.json")
}

fn contacts_path() -> PathBuf {
    home().join("contacts.bin")
}

fn save_keystore(ks: &Keystore) -> Result<()> {
    std::fs::create_dir_all(home())?;
    std::fs::write(keystore_path(), ks.to_json())?;
    Ok(())
}

async fn open(cli: &Cli) -> Result<Ctx> {
    let client = Client { http: reqwest::Client::new(), base: cli.service.trim_end_matches('/').to_string() };
    let settings: Json = serde_json::from_str(&std::fs::read_to_string(settings_path()).context("run `f1r3games init` first")?)?;
    let ks = Keystore::from_json(&std::fs::read_to_string(keystore_path())?)?;
    let policy = Policy::new(
        settings["shardId"].as_str().unwrap_or("root"),
        settings["envUri"].as_str().ok_or_else(|| anyhow!("no pinned environment"))?,
        settings["feeCap"].as_i64().unwrap_or(1_000_000_000) as i128,
    );
    let live: Json = client.get("/api/env").await?;
    if live["envUri"] != settings["envUri"] {
        bail!("the service now serves environment {} but this wallet pinned {}; refusing", live["envUri"], settings["envUri"]);
    }
    let mut wallet = Wallet::new(ks, policy);
    wallet.unlock_with_passphrase(&passphrase()?)?;
    Ok(Ctx { client, wallet, yes: cli.yes })
}

fn parse_args(s: &str) -> Result<BTreeMap<String, Value>> {
    let j: Json = serde_json::from_str(s)?;
    let o = j.as_object().ok_or_else(|| anyhow!("--args must be a JSON object"))?;
    o.iter().map(|(k, v)| Ok((k.clone(), Value::from_typed_json(v)?))).collect()
}

impl Ctx {
    /// prepare → review → (prompt) → sign → send. Returns (deployId, derived ids).
    async fn call(&mut self, template: &str, args: BTreeMap<String, Value>, derive: &[String], phlo_limit: Option<i64>) -> Result<(String, Json)> {
        let deployer = self.wallet.active_public_key_hex()?;
        let args_json: Json = Json::Object(args.iter().map(|(k, v)| (k.clone(), v.to_typed_json())).collect());
        let p = self
            .client
            .post("/api/prepare", json!({ "template": template, "args": args_json, "deployer": deployer, "derive": derive, "phloLimit": phlo_limit }))
            .await?;
        // The wallet checks the service's answer against its own rendering.
        let returned = p["args"].as_object().ok_or_else(|| anyhow!("prepare: no args"))?;
        let mut final_args = BTreeMap::new();
        for (k, v) in returned {
            final_args.insert(k.clone(), Value::from_typed_json(v)?);
        }
        for (k, v) in &args {
            if final_args.get(k) != Some(v) {
                bail!("the service changed argument {k}; refusing to sign");
            }
        }
        for k in final_args.keys() {
            if !args.contains_key(k) && k != "env_uri" && !derive.contains(k) {
                bail!("the service added argument {k}; refusing to sign");
            }
        }
        let prepared = hex::decode(p["prepared"].as_str().unwrap_or(""))?;
        let req = SignRequest { origin: Origin::Portal, template: template.to_string(), args: final_args, prepared: prepared.clone(), instance: None };
        let consent = match self.wallet.review(&req, now_ms())? {
            Decision::Within { .. } => Consent::Approved,
            Decision::Prompt { summary, max_fee, .. } => {
                eprintln!("sign {summary}\n  paying at most {max_fee} (estimated {})", p["estimatedCost"]);
                if self.yes {
                    Consent::Approved
                } else {
                    eprint!("approve? [y/N] ");
                    std::io::stderr().flush()?;
                    let mut s = String::new();
                    std::io::stdin().lock().read_line(&mut s)?;
                    if s.trim().eq_ignore_ascii_case("y") { Consent::Approved } else { Consent::Refused }
                }
            }
        };
        let signed = self.wallet.sign(&req, consent, now_ms())?;
        let r = self
            .client
            .post(
                "/api/send",
                json!({ "prepared": hex::encode(&prepared), "deployer": hex::encode(&signed.deployer), "signature": hex::encode(&signed.sig), "token": p["token"] }),
            )
            .await?;
        Ok((r["deployId"].as_str().unwrap_or_default().to_string(), p["derived"].clone()))
    }

    async fn read(&self, template: &str, args: BTreeMap<String, Value>) -> Result<Json> {
        let args_json: Json = Json::Object(args.iter().map(|(k, v)| (k.clone(), v.to_typed_json())).collect());
        self.client.post("/api/explore", json!({ "template": template, "args": args_json })).await
    }
}

fn load_contacts(w: &Wallet) -> Result<ContactBook> {
    match std::fs::read(contacts_path()) {
        Ok(b) => Ok(ContactBook::decrypt(&w.active_key()?, &b)?),
        Err(_) => Ok(ContactBook::default()),
    }
}

fn store_contacts(w: &Wallet, c: &ContactBook) -> Result<()> {
    std::fs::write(contacts_path(), c.encrypt(&w.active_key()?))?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match &cli.cmd {
        Cmd::Init => {
            if keystore_path().exists() {
                bail!("{} exists", keystore_path().display());
            }
            let client = Client { http: reqwest::Client::new(), base: cli.service.trim_end_matches('/').to_string() };
            let env = client.get("/api/env").await?;
            let p = passphrase()?;
            let (mut ks, u) = Keystore::create(&p, DEFAULT_PBKDF2_ITERATIONS);
            let k = f1r3games_core::keyfile::generate();
            let a = ks.add_key(&u, &k, "default")?;
            save_keystore(&ks)?;
            std::fs::write(
                settings_path(),
                serde_json::to_string_pretty(&json!({ "envUri": env["envUri"], "shardId": env["shardId"], "feeCap": 1_000_000_000i64, "service": cli.service }))?,
            )?;
            let file = home().join(format!("{a}.json"));
            std::fs::write(&file, f1r3games_core::keyfile::serialize(&k))?;
            println!("address {a}\nkey file {} — keep it safe; it opens in F1R3Sky and F1R3Gaze too", file.display());
            println!("pinned environment {}", env["envUri"]);
        }
        Cmd::Env => {
            let client = Client { http: reqwest::Client::new(), base: cli.service.trim_end_matches('/').to_string() };
            println!("{}", serde_json::to_string_pretty(&client.get("/api/env").await?)?);
        }
        Cmd::Key { cmd } => {
            let mut ctx = open(&cli).await?;
            match cmd {
                KeyCmd::New { label } => {
                    let (a, file) = ctx.wallet.create_key(label)?;
                    let path = home().join(format!("{a}.json"));
                    std::fs::write(&path, file)?;
                    println!("{a}  (key file {})", path.display());
                }
                KeyCmd::Import { file, label } => println!("{}", ctx.wallet.import_key_file(&std::fs::read_to_string(file)?, label)?),
                KeyCmd::Export { address } => {
                    let a = address.clone().unwrap_or(ctx.wallet.active_address()?.to_string());
                    let p = passphrase()?;
                    let u = ctx.wallet.keystore.unlock_with_passphrase(&p)?;
                    println!("{}", &*ctx.wallet.keystore.export_key_file(&u, &a)?);
                }
                KeyCmd::List => {
                    for e in &ctx.wallet.keystore.entries {
                        let mark = if ctx.wallet.keystore.active.as_deref() == Some(&e.address) { "*" } else { " " };
                        println!("{mark} {}  {}", e.address, e.label);
                    }
                }
                KeyCmd::Use { address } => ctx.wallet.keystore.set_active(address)?,
                KeyCmd::Passkey { credential_id, prf_hex } => {
                    let u = ctx.wallet.keystore.unlock_with_passphrase(&passphrase()?)?;
                    ctx.wallet.keystore.add_passkey(&u, credential_id, &hex::decode(prf_hex)?);
                }
            }
            save_keystore(&ctx.wallet.keystore)?;
        }
        Cmd::Balance { address } => {
            let ctx = open(&cli).await?;
            let a = address.clone().unwrap_or(ctx.wallet.active_address()?.to_string());
            println!("{}", ctx.client.get(&format!("/api/balance/{a}")).await?);
        }
        Cmd::Faucet => {
            let ctx = open(&cli).await?;
            let a = ctx.wallet.active_address()?;
            println!("{}", ctx.client.post("/api/testnet/fund", json!({ "address": a })).await?);
        }
        Cmd::Profile { name, tags } => {
            let mut ctx = open(&cli).await?;
            let profile = Value::map([
                ("name", Value::str(name.clone())),
                ("tags", Value::List(tags.iter().map(|t| Value::str(t.clone())).collect())),
            ]);
            let (id, _) = ctx.call("profiles.save", [("profile".to_string(), profile)].into_iter().collect(), &[], None).await?;
            println!("deploy {id}");
        }
        Cmd::Launch { game, visibility } => {
            let mut ctx = open(&cli).await?;
            let args = [
                ("game".to_string(), Value::str(game.clone())),
                ("visibility".to_string(), Value::str(visibility.clone())),
                ("config".to_string(), Value::map::<String>([])),
            ]
            .into_iter()
            .collect();
            let (id, derived) = ctx.call("instances.create", args, &["id".to_string()], None).await?;
            println!("deploy {id}\ninstance {}", derived["id"].as_str().unwrap_or("?"));
        }
        Cmd::Invite { cmd } => {
            let mut ctx = open(&cli).await?;
            match cmd {
                InviteCmd::Create { instance, uses, expires_at, sponsorship } => {
                    let inv = InviteKey::generate();
                    let args = [
                        ("invitePk".to_string(), Value::Bytes(inv.public_key())),
                        ("instance".to_string(), Value::str(instance.clone())),
                        ("uses".to_string(), Value::Int(*uses)),
                        ("expiresAt".to_string(), Value::Int(*expires_at)),
                        ("sponsorship".to_string(), sponsorship.clone().map(Value::String).unwrap_or(Value::Nil)),
                    ]
                    .into_iter()
                    .collect();
                    let (id, _) = ctx.call("invites.issue", args, &[], None).await?;
                    let env = ctx.client.get("/api/env").await?;
                    let base = env["portalBaseUrl"].as_str().filter(|s| !s.is_empty()).unwrap_or("https://games.f1r3fly.io");
                    println!("deploy {id}\n{}", inv.link(base, instance, None));
                }
                InviteCmd::Redeem { link } => {
                    let parsed = invite::parse_link(link)?;
                    let sig = ctx.wallet.redemption_signature(&parsed.invite_key)?;
                    let args = [
                        ("invitePk".to_string(), Value::Bytes(parsed.invite_key.public_key())),
                        ("sig".to_string(), Value::Bytes(sig)),
                    ]
                    .into_iter()
                    .collect();
                    let (id, _) = ctx.call("invites.redeem", args, &[], None).await?;
                    println!("deploy {id}\ninstance {}", parsed.instance_id);
                }
            }
        }
        Cmd::Contacts { cmd } => {
            let mut ctx = open(&cli).await?;
            let mut book = load_contacts(&ctx.wallet)?;
            match cmd {
                ContactsCmd::Add { name, kind, handle } => {
                    book.add(name, vec![f1r3games_wallet::contacts::Channel { kind: kind.clone(), handle: handle.clone() }], now_ms());
                }
                ContactsCmd::ImportCsv { file } => {
                    for r in book.import_csv(&std::fs::read_to_string(file)?, now_ms()) {
                        eprintln!("skipped: {r}");
                    }
                }
                ContactsCmd::ImportVcard { file } => println!("{} imported", book.import_vcard(&std::fs::read_to_string(file)?, now_ms())),
                ContactsCmd::List => {
                    for c in &book.contacts {
                        let ch: Vec<String> = c.channels.iter().map(|x| format!("{}:{}", x.kind, x.handle)).collect();
                        println!("{}  {}  {}", c.id, c.name, ch.join(" "));
                    }
                    println!("mode: {:?}", book.mode);
                }
                ContactsCmd::Mode { mode } => {
                    book.mode = match mode.as_str() {
                        "client" | "client-only" => StorageMode::ClientOnly,
                        "backup" | "on-chain" => StorageMode::OnChainBackup,
                        _ => bail!("mode is client-only or backup"),
                    };
                }
                ContactsCmd::Backup => {
                    if book.mode != StorageMode::OnChainBackup {
                        bail!("contacts are client-only; `f1r3games contacts mode backup` first");
                    }
                    let ct = book.encrypt(&ctx.wallet.active_key()?);
                    let (id, _) = ctx.call("contacts.save", [("ciphertext".to_string(), Value::Bytes(ct))].into_iter().collect(), &[], None).await?;
                    println!("deploy {id}");
                }
                ContactsCmd::Restore => {
                    let a = ctx.wallet.active_address()?;
                    let r = ctx.read("contacts.get", [("address".to_string(), Value::String(a.to_string()))].into_iter().collect()).await?;
                    let v = Value::from_typed_json(&r["value"])?;
                    match v.get("ciphertext") {
                        Some(Value::Bytes(b)) => book = ContactBook::decrypt(&ctx.wallet.active_key()?, b)?,
                        _ => bail!("no backup for {a}"),
                    }
                }
            }
            store_contacts(&ctx.wallet, &book)?;
        }
        Cmd::Call { template, args, derive, phlo_limit } => {
            let mut ctx = open(&cli).await?;
            let (id, derived) = ctx.call(template, parse_args(args)?, derive, *phlo_limit).await?;
            println!("{}", json!({ "deployId": id, "derived": derived }));
        }
        Cmd::Read { template, args } => {
            let ctx = open(&cli).await?;
            println!("{}", serde_json::to_string_pretty(&ctx.read(template, parse_args(args)?).await?)?);
        }
    }
    let _ = Address::parse;
    Ok(())
}
