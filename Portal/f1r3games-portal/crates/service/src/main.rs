use anyhow::Context;
use clap::{Parser, Subcommand};
use f1r3games_core::keyfile;
use f1r3games_service::{bootstrap, config::Config, hosts, origins, register, routes, status, State};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{AllowOrigin, CorsLayer};

#[derive(Parser)]
#[command(name = "f1r3games-service", about = "The F1R3Games portal service")]
struct Cli {
    /// Configuration file (TOML).
    #[arg(short, long, env = "F1R3GAMES_CONFIG", default_value = "f1r3games.toml")]
    config: String,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Serve the API, the shell and the configured game origins (default).
    Serve,
    /// Install or upgrade the games environment, then exit.
    Bootstrap {
        /// Wait up to this many seconds for the environment to read back.
        #[arg(long, default_value_t = 0)]
        wait: u64,
    },
    /// Print the environment URI for the configured keys.
    EnvUri,
    /// Write fresh service and environment key files and a token secret.
    Keygen {
        #[arg(long, default_value = ".")]
        dir: String,
    },
    /// Write an environment key for each game that has none in DIR.
    GamesKeygen {
        #[arg(long, default_value = "game-keys")]
        dir: String,
    },
    /// Install or upgrade each game's environment. Keys come from
    /// F1R3GAMES_GAME_KEY_<ID> when set, else from DIR.
    GamesInstall {
        #[arg(long, default_value = "game-keys")]
        keys: String,
        #[arg(long, default_value_t = 1)]
        version: i64,
        /// Only these games (repeatable); all by default.
        #[arg(long)]
        only: Vec<String>,
        /// Wait up to this many seconds for each environment to read back.
        #[arg(long, default_value_t = 0)]
        wait: u64,
    },
    /// Write the games' manifests (typed, ready for games.register) to OUT.
    GamesManifests {
        #[arg(long, default_value = "game-keys")]
        keys: String,
        /// Where the game clients are served: <base>/<id>/ and <base>/<id>/preview/<kind>.html
        #[arg(long)]
        entry_base: Option<String>,
        /// A base for one game, ID=BASE (repeatable): a game on an origin of its own.
        #[arg(long)]
        entry: Vec<String>,
        /// Only these games (repeatable); all by default.
        #[arg(long)]
        only: Vec<String>,
        #[arg(long, default_value = "manifests.json")]
        out: String,
        /// The relay base for games that declare the relay capability
        /// (F1R3Ink): their manifests name <relay-base>/<id>.
        #[arg(long)]
        relay_base: Option<String>,
    },
    /// Write a relay key and handle secret for F1R3Ink's relay in DIR, and
    /// print the key's address (name it with `f1r3games ink set-relay`).
    RelayKeygen {
        #[arg(long, default_value = ".")]
        dir: String,
    },
    /// Register the manifests in FILE with the Cooperative's key
    /// (F1R3GAMES_COOP_KEY, or --coop-key-file); skips games already current.
    RegisterGames {
        file: String,
        #[arg(long)]
        only: Vec<String>,
        #[arg(long)]
        coop_key_file: Option<String>,
        /// Wait up to this many seconds for each registration to read back.
        #[arg(long, default_value_t = 300)]
        wait: u64,
    },
    /// Report the environments and registrations on the shard, as JSON.
    Status {
        /// Game keys, for the game environments' URIs (env vars are read too).
        #[arg(long)]
        keys: Option<String>,
    },
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// A key from the environment variable `var` (hex or a key file's JSON),
/// else from `file` (F1).
fn key_from(var: &str, file: &str, what: &str) -> anyhow::Result<k256::ecdsa::SigningKey> {
    if let Some(v) = env_var(var) {
        return keyfile::deserialize(&v).map_err(|e| anyhow::anyhow!("{var}: {e}"));
    }
    anyhow::ensure!(!file.is_empty(), "{what}: set {var} or name a file in the configuration");
    keyfile::deserialize(&read(file)?).map_err(|e| anyhow::anyhow!("{what} ({file}): {e}"))
}

fn game_var(id: &str) -> String {
    format!("F1R3GAMES_GAME_KEY_{}", id.to_ascii_uppercase().replace('-', "_"))
}

fn game_key(dir: &str, id: &str) -> anyhow::Result<k256::ecdsa::SigningKey> {
    let path = std::path::Path::new(dir).join(f1r3games_games::key_file_name(id));
    key_from(&game_var(id), path.to_str().unwrap_or_default(), &format!("{id} key"))
}

/// The game key if one is available (environment or DIR).
fn game_key_opt(dir: Option<&str>, id: &str) -> Option<k256::ecdsa::SigningKey> {
    match dir {
        Some(d) => game_key(d, id).ok(),
        None => env_var(&game_var(id)).and_then(|v| keyfile::deserialize(&v).ok()),
    }
}

fn read(path: &str) -> anyhow::Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {path}"))
}

fn write_private(path: &std::path::Path, contents: &str) -> anyhow::Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn selected(only: &[String]) -> Vec<&'static f1r3games_games::GameSpec> {
    f1r3games_games::GAMES.iter().filter(|g| only.is_empty() || only.iter().any(|o| o == g.id)).collect()
}

/// Per-game entry bases from `--entry ID=BASE`, falling back to `--entry-base`.
fn entry_bases(entry_base: &Option<String>, entry: &[String], only: &[String]) -> anyhow::Result<BTreeMap<String, String>> {
    let mut per = BTreeMap::new();
    for e in entry {
        let (id, base) = e.split_once('=').ok_or_else(|| anyhow::anyhow!("--entry {e}: expected ID=BASE"))?;
        anyhow::ensure!(f1r3games_games::get(id).is_some(), "--entry {e}: no game {id}");
        per.insert(id.to_string(), base.to_string());
    }
    let mut out = BTreeMap::new();
    for g in selected(only) {
        match per.get(g.id).or(entry_base.as_ref()) {
            Some(b) => {
                out.insert(g.id.to_string(), b.clone());
            }
            None if !only.is_empty() || !per.is_empty() => {}
            None => anyhow::bail!("no entry base for {}: give --entry-base or --entry {}=BASE", g.id, g.id),
        }
    }
    Ok(out)
}

async fn bind_all(addrs: &[String]) -> anyhow::Result<Vec<tokio::net::TcpListener>> {
    let mut out = Vec::new();
    for a in addrs {
        out.push(tokio::net::TcpListener::bind(a).await.with_context(|| format!("binding {a}"))?);
    }
    Ok(out)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let cli = Cli::parse();
    if let Some(Cmd::Keygen { dir }) = &cli.cmd {
        let dir = std::path::Path::new(dir);
        let mut secret = [0u8; 32];
        f1r3games_core::hash::random_bytes(&mut secret);
        write_private(&dir.join("service-key.json"), &keyfile::serialize(&keyfile::generate()))?;
        write_private(&dir.join("env-key.json"), &keyfile::serialize(&keyfile::generate()))?;
        write_private(&dir.join("token-secret.hex"), &hex::encode(secret))?;
        println!("wrote service-key.json, env-key.json, token-secret.hex in {}", dir.display());
        return Ok(());
    }
    if let Some(Cmd::GamesKeygen { dir }) = &cli.cmd {
        std::fs::create_dir_all(dir)?;
        for g in f1r3games_games::GAMES {
            let path = std::path::Path::new(dir).join(f1r3games_games::key_file_name(g.id));
            if path.exists() {
                println!("{}: kept {}", g.id, path.display());
            } else {
                write_private(&path, &keyfile::serialize(&keyfile::generate()))?;
                println!("{}: wrote {}", g.id, path.display());
            }
        }
        return Ok(());
    }
    if let Some(Cmd::RelayKeygen { dir }) = &cli.cmd {
        let dir = std::path::Path::new(dir);
        let (kp, sp) = (dir.join("relay-key.json"), dir.join("relay-secret.hex"));
        anyhow::ensure!(!kp.exists() && !sp.exists(), "{} or {} exists; refusing to replace a relay's keys", kp.display(), sp.display());
        let key = keyfile::generate();
        let mut secret = [0u8; 32];
        f1r3games_core::hash::random_bytes(&mut secret);
        write_private(&kp, &keyfile::serialize(&key))?;
        write_private(&sp, &hex::encode(secret))?;
        println!("{}", f1r3games_core::Address::from_public_key(key.verifying_key()));
        return Ok(());
    }
    if let Some(Cmd::GamesManifests { keys, entry_base, entry, only, out, relay_base }) = &cli.cmd {
        let bases = entry_bases(entry_base, entry, only)?;
        let mut all = vec![];
        for g in f1r3games_games::GAMES {
            let Some(base) = bases.get(g.id) else { continue };
            let uri = f1r3games_games::env_uri(&game_key(keys, g.id)?);
            all.push(serde_json::json!({ "id": g.id, "envUri": uri, "manifest": g.manifest_with(&uri, base, relay_base.as_deref()).to_typed_json() }));
        }
        std::fs::write(out, serde_json::to_string_pretty(&all)?)?;
        println!("wrote {} manifests to {out}; register them with `f1r3games-service register-games {out}` and the Cooperative's key", all.len());
        return Ok(());
    }
    let config = Config::from_toml(&read(&cli.config)?)?;
    let service_key = key_from("F1R3GAMES_SERVICE_KEY", &config.service_key_file, "service key")?;
    let env_key = key_from("F1R3GAMES_ENV_KEY", &config.env_key_file, "environment key")?;
    let secret_hex = match env_var("F1R3GAMES_TOKEN_SECRET") {
        Some(v) => v,
        None => {
            anyhow::ensure!(!config.token_secret_file.is_empty(), "token secret: set F1R3GAMES_TOKEN_SECRET or token_secret_file");
            read(&config.token_secret_file)?
        }
    };
    let secret = hex::decode(secret_hex.trim()).context("token secret must be hex")?;
    anyhow::ensure!(secret.len() >= 32, "token secret must be at least 32 bytes");
    let mut state = State::new(config, service_key, env_key, secret);
    if state.config.relay.enabled {
        let rc = state.config.relay.clone();
        let key = key_from("F1R3GAMES_RELAY_KEY", &rc.key_file, "relay key")?;
        let hex_secret = match env_var("F1R3GAMES_RELAY_SECRET") {
            Some(v) => v,
            None => {
                anyhow::ensure!(!rc.secret_file.is_empty(), "relay secret: set F1R3GAMES_RELAY_SECRET or relay.secret_file");
                read(&rc.secret_file)?
            }
        };
        let rs = hex::decode(hex_secret.trim()).context("relay secret must be hex")?;
        anyhow::ensure!(rs.len() >= 32, "relay secret must be at least 32 bytes");
        state = state.with_relay(key, rs);
    }
    let st = Arc::new(state);
    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::EnvUri => {
            println!("{}", st.env_uri);
            Ok(())
        }
        Cmd::Bootstrap { wait } => {
            match bootstrap::ensure_env(&st).await? {
                Some(id) => println!("environment deploy {id} submitted for {}", st.env_uri),
                None => println!("environment {} is current", st.env_uri),
            }
            if wait > 0 {
                bootstrap::wait_env(&st, Duration::from_secs(wait)).await?;
                println!("environment {} registered at version {}", st.env_uri, st.config.env_version);
            }
            Ok(())
        }
        Cmd::Keygen { .. } | Cmd::GamesKeygen { .. } | Cmd::GamesManifests { .. } | Cmd::RelayKeygen { .. } => unreachable!(),
        Cmd::GamesInstall { keys, version, only, wait } => {
            for g in selected(&only) {
                let key = game_key(&keys, g.id)?;
                match bootstrap::ensure_game_env(&st, g, &key, version).await? {
                    Some(id) => println!("{}: environment deploy {id}", g.id),
                    None => println!("{}: environment is current", g.id),
                }
            }
            if wait > 0 {
                for g in selected(&only) {
                    let uri = f1r3games_games::env_uri(&game_key(&keys, g.id)?);
                    bootstrap::wait_version_at(&st, &uri, version, Duration::from_secs(wait)).await?;
                    println!("{}: environment registered at version {version}", g.id);
                }
            }
            Ok(())
        }
        Cmd::RegisterGames { file, only, coop_key_file, wait } => {
            let coop = key_from("F1R3GAMES_COOP_KEY", coop_key_file.as_deref().unwrap_or(""), "Cooperative key")?;
            let entries = register::read_manifests(&read(&file)?, &only)?;
            for (id, o) in register::register_all(&st, &coop, &entries, Duration::from_secs(wait)).await? {
                match o {
                    register::Outcome::Current => println!("{id}: registered and current"),
                    register::Outcome::Registered(d) => println!("{id}: registered (deploy {d})"),
                }
            }
            Ok(())
        }
        Cmd::Status { keys } => {
            let uris: BTreeMap<String, String> = f1r3games_games::GAMES
                .iter()
                .filter_map(|g| game_key_opt(keys.as_deref(), g.id).map(|k| (g.id.to_string(), f1r3games_games::env_uri(&k))))
                .collect();
            println!("{}", serde_json::to_string_pretty(&status::status(&st, &uris).await?)?);
            Ok(())
        }
        Cmd::Serve => {
            if st.config.bootstrap_env {
                if let Err(e) = bootstrap::ensure_env(&st).await {
                    tracing::error!(error = %e, "environment bootstrap failed; serving anyway");
                }
            }
            let origins_cfg: Vec<_> = st.config.cors_origins.iter().filter_map(|o| o.parse().ok()).collect();
            let cors = CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins_cfg))
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers([axum::http::header::CONTENT_TYPE]);
            let app = hosts::guard(routes::router(st.clone()).layer(cors), st.config.public_host.as_deref());
            // Bind everything first, so a port that is taken fails the start
            // before anything is served.
            let mut servers: Vec<(String, tokio::net::TcpListener, axum::Router)> = Vec::new();
            for (addr, l) in st.config.listen.addrs().into_iter().zip(bind_all(&st.config.listen.addrs()).await?) {
                servers.push((format!("portal {addr}"), l, app.clone()));
            }
            let portal_origin = st.config.portal_origin();
            for o in &st.config.origins {
                let r = origins::router(o, portal_origin.as_deref());
                for (addr, l) in o.listen.addrs().into_iter().zip(bind_all(&o.listen.addrs()).await?) {
                    servers.push((format!("{} {addr}", o.id), l, r.clone()));
                }
            }
            let mut set = tokio::task::JoinSet::new();
            for (name, l, r) in servers {
                tracing::info!(listen = %name, "serving");
                set.spawn(async move { axum::serve(l, r).await.map_err(|e| anyhow::anyhow!("{name}: {e}")) });
            }
            if st.relay.is_some() {
                tokio::spawn(f1r3games_service::relay::run(st.clone()));
            }
            tracing::info!(env = %st.env_uri, "f1r3games-service ready");
            while let Some(r) = set.join_next().await {
                r??;
            }
            Ok(())
        }
    }
}
