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
        Cmd::Keygen { .. } => unreachable!(),
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
