//! A client for F1R3Node-Rust's public HTTP API (port 40403 by default).
//!
//! Deploys go to a validator (`POST /api/deploy`); exploratory reads,
//! cost estimates and balances go to a read-only node, which is the only
//! kind that serves them (`400 readonly_node_required` otherwise). Nothing
//! here proposes: validators propose by heartbeat.

use f1r3games_core::{SignedDeploy, Value};
use serde_json::{json, Value as Json};

#[derive(Debug, thiserror::Error)]
pub enum NodeError {
    #[error("node request failed: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("node answered {status} {code}: {message}")]
    Api { status: u16, code: String, message: String },
    #[error("unexpected node response: {0}")]
    Shape(String),
}

#[derive(Clone, Debug)]
pub struct Node {
    http: reqwest::Client,
    /// The first validator; with several (`with_validators`), one is drawn
    /// per deploy and the others are tried if it cannot be reached.
    pub validator: String,
    pub validators: Vec<String>,
    pub observer: String,
}

#[derive(Clone, Debug)]
pub struct Explored {
    pub values: Vec<Value>,
    pub block_hash: String,
    pub block_number: Option<i64>,
    /// The block's timestamp (ms): the clock games that measure time by the
    /// block read against (F1R3Ink's decay, D5).
    pub block_timestamp: Option<i64>,
}

impl Explored {
    /// The first value sent on the return channel.
    pub fn first(&self) -> Value {
        self.values.first().cloned().unwrap_or(Value::Nil)
    }
}

async fn check(resp: reqwest::Response) -> Result<Json, NodeError> {
    let status = resp.status();
    let text = resp.text().await?;
    let body: Json = serde_json::from_str(&text).unwrap_or(Json::String(text));
    if status.is_success() {
        Ok(body)
    } else {
        Err(NodeError::Api {
            status: status.as_u16(),
            code: body.get("error").and_then(Json::as_str).unwrap_or("").to_string(),
            message: body.get("message").and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| body.to_string()),
        })
    }
}

impl Node {
    pub fn new(validator: impl Into<String>, observer: impl Into<String>) -> Node {
        Node::with_validators(vec![validator.into()], observer)
    }

    /// Several validators (F7). Deploys go to one drawn at random; when it
    /// cannot be reached (a transport error, not a refusal), the next is tried.
    pub fn with_validators(validators: Vec<String>, observer: impl Into<String>) -> Node {
        let validators: Vec<String> = validators.into_iter().map(|v| v.trim_end_matches('/').to_string()).filter(|v| !v.is_empty()).collect();
        Node {
            http: reqwest::Client::new(),
            validator: validators.first().cloned().unwrap_or_default(),
            validators,
            observer: observer.into().trim_end_matches('/').to_string(),
        }
    }

    /// The validators in the order to try them: a random rotation of the list.
    pub fn draw(&self) -> Vec<String> {
        let n = self.validators.len().max(1);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as usize).unwrap_or(0);
        let k = nanos % n;
        let mut v = self.validators.clone();
        let k = k.min(v.len());
        v.rotate_left(k);
        v
    }

    pub async fn status(&self, base: &str) -> Result<Json, NodeError> {
        check(self.http.get(format!("{base}/api/status")).send().await?).await
    }

    /// The number of the latest block in the validator's DAG, for
    /// `validAfterBlockNumber` (`GET /api/blocks/1`).
    ///
    /// The node admits a deploy only while `validAfterBlockNumber` is within
    /// `deploy_lifespan` (50) of the next block's number, measured in DAG
    /// block numbers. `prepare-deploy`'s `seqNumber` is the validator's own
    /// message sequence number, which falls behind the block number once
    /// several validators propose; after enough blocks every deploy built on
    /// it is refused as expired. `seqNumber` is kept only as a fallback for a
    /// node that does not serve `/api/blocks/{depth}`.
    pub async fn valid_after(&self) -> Result<i64, NodeError> {
        let mut last = None;
        for v in self.draw() {
            match self.valid_after_at(&v).await {
                Err(NodeError::Transport(e)) => last = Some(NodeError::Transport(e)),
                other => return other,
            }
        }
        Err(last.unwrap_or_else(|| NodeError::Shape("no validator configured".into())))
    }

    async fn valid_after_at(&self, validator: &str) -> Result<i64, NodeError> {
        let resp = self.http.get(format!("{validator}/api/blocks/1")).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            let j = check(self.http.get(format!("{validator}/api/prepare-deploy")).send().await?).await?;
            return j.get("seqNumber").and_then(Json::as_i64).ok_or_else(|| NodeError::Shape(j.to_string()));
        }
        let j = check(resp).await?;
        latest_block_number(&j).ok_or_else(|| NodeError::Shape(format!("no blockNumber in /api/blocks/1: {}", truncate(&j.to_string()))))
    }

    /// Submit a signed deploy; returns the deploy id (the signature, hex).
    /// The node answers `Success!\nDeployId is: <hex>`; the id is the
    /// signature we sent, so we return that and check the node echoed it.
    pub async fn deploy(&self, d: &SignedDeploy) -> Result<String, NodeError> {
        let mut last = None;
        for v in self.draw() {
            match self.deploy_at(&v, d).await {
                Err(NodeError::Transport(e)) => {
                    tracing::warn!(validator = %v, error = %e, "validator unreachable; trying another");
                    last = Some(NodeError::Transport(e))
                }
                other => return other,
            }
        }
        Err(last.unwrap_or_else(|| NodeError::Shape("no validator configured".into())))
    }

    async fn deploy_at(&self, validator: &str, d: &SignedDeploy) -> Result<String, NodeError> {
        let j = check(self.http.post(format!("{validator}/api/deploy")).json(&d.to_json()).send().await?).await?;
        let text = match &j {
            Json::String(s) => s.clone(),
            other => other.to_string(),
        };
        let id = d.id();
        if text.contains(&id) {
            Ok(id)
        } else {
            Err(NodeError::Shape(format!("unexpected deploy response: {text}")))
        }
    }

    /// `GET /api/deploy/{id}`: `None` while the deploy is not yet in a block.
    pub async fn find_deploy(&self, id: &str) -> Result<Option<Json>, NodeError> {
        let mut last = None;
        for v in &self.validators {
            match self.http.get(format!("{v}/api/deploy/{id}")).send().await {
                Ok(r) if r.status().as_u16() == 404 => last = None,
                Ok(r) => return check(r).await.map(Some),
                Err(e) => last = Some(NodeError::Transport(e)),
            }
        }
        match last {
            Some(e) => Err(e),
            None => Ok(None),
        }
    }

    /// Run a term read-only against the last finalized block at the observer.
    pub async fn explore(&self, term: &str) -> Result<Explored, NodeError> {
        let j = check(self.http.post(format!("{}/api/explore-deploy", self.observer)).json(&json!({ "term": term })).send().await?).await?;
        let exprs = j.get("expr").and_then(Json::as_array).ok_or_else(|| NodeError::Shape(j.to_string()))?;
        let values = exprs.iter().map(Value::from_rho_expr).collect::<Result<Vec<_>, _>>().map_err(|e| NodeError::Shape(e.to_string()))?;
        let block = j.get("block").cloned().unwrap_or(Json::Null);
        Ok(Explored {
            values,
            block_hash: block.get("blockHash").and_then(Json::as_str).unwrap_or("").to_string(),
            block_number: block.get("blockNumber").and_then(Json::as_i64),
            block_timestamp: block.get("timestamp").and_then(Json::as_i64),
        })
    }

    /// `POST /api/estimate-cost` with the deployer key, so identity-dependent
    /// terms are quoted correctly.
    pub async fn estimate_cost(&self, term: &str, deployer_hex: &str) -> Result<u64, NodeError> {
        let j = check(
            self.http
                .post(format!("{}/api/estimate-cost", self.observer))
                .json(&json!({ "term": term, "deployer": deployer_hex }))
                .send()
                .await?,
        )
        .await?;
        j.get("cost").and_then(Json::as_u64).ok_or_else(|| NodeError::Shape(j.to_string()))
    }

    pub async fn balance(&self, address: &str) -> Result<Json, NodeError> {
        check(self.http.get(format!("{}/api/balance/{address}", self.observer)).send().await?).await
    }
}

/// The highest `blockNumber` in a `/api/blocks/{depth}` answer. F1R3Node-Rust
/// 0.4.x wraps each block's summary as `{"blockInfo": {..., "blockNumber"}}`;
/// a bare summary is accepted too.
pub fn latest_block_number(j: &Json) -> Option<i64> {
    j.as_array()?
        .iter()
        .filter_map(|b| b.get("blockInfo").unwrap_or(b).get("blockNumber").and_then(Json::as_i64))
        .max()
}

fn truncate(s: &str) -> String {
    s.chars().take(300).collect()
}

#[cfg(test)]
mod valid_after_tests {
    use super::latest_block_number;
    use serde_json::json;

    #[test]
    fn reads_the_block_number_as_the_node_serves_it() {
        // As F1R3Node-Rust 0.4.46 answers GET /api/blocks/1 (abridged).
        let wrapped = json!([{ "blockInfo": { "blockHash": "96cd", "seqNum": 3074, "blockNumber": 3141 } },
                             { "blockInfo": { "blockHash": "2c94", "seqNum": 3070, "blockNumber": 3140 } }]);
        assert_eq!(latest_block_number(&wrapped), Some(3141));
        assert_eq!(latest_block_number(&json!([{ "blockNumber": 7 }])), Some(7));
        assert_eq!(latest_block_number(&json!({ "error": "x" })), None);
    }
}
