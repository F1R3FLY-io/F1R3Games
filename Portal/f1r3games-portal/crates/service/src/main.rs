use anyhow::Context;
use clap::{Parser, Subcommand};
use f1r3games_core::keyfile;
use f1r3games_service::{bootstrap, config::Config, routes, State};
use std::sync::Arc;
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
    /// Serve the API (default).
    Serve,
    /// Install or upgrade the games environment, then exit.
    Bootstrap,
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
    /// Install or upgrade each game's environment (keys from DIR).
    GamesInstall {
        #[arg(long, default_value = "game-keys")]
        keys: String,
        #[arg(long, default_value_t = 1)]
        version: i64,
    },
    /// Write the games' manifests (typed, ready for games.register) to OUT.
    GamesManifests {
        #[arg(long, default_value = "game-keys")]
        keys: String,
        /// Where the game clients are served: <base>/<id>/ and <base>/<id>/preview/<kind>.html
        #[arg(long)]
        entry_base: String,
        #[arg(long, default_value = "manifests.json")]
        out: String,
    },
}

fn game_key(dir: &str, id: &str) -> anyhow::Result<k256::ecdsa::SigningKey> {
    let path = std::path::Path::new(dir).join(f1r3games_games::key_file_name(id));
    keyfile::deserialize(&read(path.to_str().unwrap())?).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
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
    if let Some(Cmd::GamesManifests { keys, entry_base, out }) = &cli.cmd {
        let mut all = vec![];
        for g in f1r3games_games::GAMES {
            let uri = f1r3games_games::env_uri(&game_key(keys, g.id)?);
            all.push(serde_json::json!({ "id": g.id, "envUri": uri, "manifest": g.manifest(&uri, entry_base).to_typed_json() }));
        }
        std::fs::write(out, serde_json::to_string_pretty(&all)?)?;
        println!("wrote {} manifests to {out}; register them with `f1r3games register-games {out}` using the Cooperative's key", all.len());
        return Ok(());
    }
    let config = Config::from_toml(&read(&cli.config)?)?;
    let service_key = keyfile::deserialize(&read(&config.service_key_file)?).map_err(|e| anyhow::anyhow!("service key: {e}"))?;
    let env_key = keyfile::deserialize(&read(&config.env_key_file)?).map_err(|e| anyhow::anyhow!("env key: {e}"))?;
    let secret = hex::decode(read(&config.token_secret_file)?.trim()).context("token secret must be hex")?;
    anyhow::ensure!(secret.len() >= 32, "token secret must be at least 32 bytes");
    let st = Arc::new(State::new(config, service_key, env_key, secret));
    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::EnvUri => {
            println!("{}", st.env_uri);
            Ok(())
        }
        Cmd::Bootstrap => {
            match bootstrap::ensure_env(&st).await? {
                Some(id) => println!("environment deploy {id} submitted for {}", st.env_uri),
                None => println!("environment {} is current", st.env_uri),
            }
            Ok(())
        }
        Cmd::Keygen { .. } | Cmd::GamesKeygen { .. } | Cmd::GamesManifests { .. } => unreachable!(),
        Cmd::GamesInstall { keys, version } => {
            for g in f1r3games_games::GAMES {
                match bootstrap::ensure_game_env(&st, g, &game_key(&keys, g.id)?, version).await? {
                    Some(id) => println!("{}: environment deploy {id}", g.id),
                    None => println!("{}: environment is current", g.id),
                }
            }
            Ok(())
        }
        Cmd::Serve => {
            if st.config.bootstrap_env {
                if let Err(e) = bootstrap::ensure_env(&st).await {
                    tracing::error!(error = %e, "environment bootstrap failed; serving anyway");
                }
            }
            let origins: Vec<_> = st.config.cors_origins.iter().filter_map(|o| o.parse().ok()).collect();
            let cors = CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers([axum::http::header::CONTENT_TYPE]);
            let app = routes::router(st.clone()).layer(cors);
            let listener = tokio::net::TcpListener::bind(&st.config.listen).await?;
            tracing::info!(listen = %st.config.listen, env = %st.env_uri, "f1r3games-service ready");
            axum::serve(listener, app).await?;
            Ok(())
        }
    }
}
