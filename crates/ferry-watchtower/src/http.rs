//! HTTP API.
//!
//! - `POST /packages`      register a [`Package`] (Bitcoin / Litecoin tower) or an
//!   [`EvmPackage`] (`--counter evm` tower) → `201 {id, created, status}` (`200` if the same
//!   package was already registered; `400` invalid, `409` conflicting, `503` node)
//! - `GET  /packages/{id}` → [`crate::store::PackageView`] or [`crate::EvmPackageView`] (never
//!   the transactions or B's share)
//! - `GET  /health`        → `{ok, counter, chain, network}` or `{ok, counter, chain_id,
//!   account}` (no auth)
//!
//! With a token configured, `/packages*` need `Authorization: Bearer <token>`.

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::evm::EvmPackage;
use crate::package::Package;
use crate::tower::{RegisterError, Registered};
use crate::Service;

/// Upload size cap: a package is a few kilobytes.
const MAX_BODY: usize = 64 * 1024;

fn error(code: u16, msg: impl Into<String>) -> Response {
    let code = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

pub fn router(service: impl Into<Service>) -> Router {
    let service = service.into();
    Router::new()
        .route("/packages", post(register))
        .route("/packages/{id}", get(status))
        .route_layer(middleware::from_fn_with_state(service.clone(), auth))
        .route("/health", get(health))
        .fallback(|| async { error(404, "not found") })
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .with_state(service)
}

impl Service {
    fn token(&self) -> Option<&str> {
        match self {
            Service::Utxo(t) => t.cfg.token.as_deref(),
            Service::Evm(t) => t.cfg.token.as_deref(),
        }
    }

    /// What this tower watches, for error messages.
    fn watches(&self) -> String {
        match self {
            Service::Utxo(t) => format!("{} {}", t.cfg.chain.coin.name(), t.cfg.chain.network),
            Service::Evm(t) => format!("EVM chain {}", t.chain_id),
        }
    }
}

async fn auth(State(s): State<Service>, req: Request, next: Next) -> Response {
    if let Some(want) = s.token() {
        let got = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        if !got.is_some_and(|g| constant_time_eq(g.as_bytes(), want.as_bytes())) {
            return error(401, "missing or wrong bearer token");
        }
    }
    next.run(req).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn health(State(s): State<Service>) -> Json<Value> {
    Json(match &s {
        Service::Utxo(t) => json!({
            "ok": true,
            "counter": "btc",
            "chain": t.cfg.chain.coin,
            "network": t.cfg.chain.network.to_string(),
        }),
        Service::Evm(t) => json!({
            "ok": true,
            "counter": "evm",
            "chain_id": t.chain_id,
            "account": t.account(),
        }),
    })
}

async fn register(State(s): State<Service>, body: Bytes) -> Response {
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return error(400, format!("invalid package: {e}")),
    };
    // EVM packages say so; Bitcoin and Litecoin packages predate the field.
    let evm = value.get("counter").and_then(Value::as_str) == Some("evm");
    let res = match (&s, evm) {
        (Service::Utxo(t), false) => match serde_json::from_value::<Package>(value) {
            Ok(p) => t.register(p).await,
            Err(e) => return error(400, format!("invalid package: {e}")),
        },
        (Service::Evm(t), true) => match serde_json::from_value::<EvmPackage>(value) {
            Ok(p) => t.register(p).await,
            Err(e) => return error(400, format!("invalid package: {e}")),
        },
        (_, true) => {
            return error(
                400,
                format!(
                    "invalid package: it is for an EVM swap, this tower watches {}",
                    s.watches()
                ),
            )
        }
        (_, false) => {
            return error(
                400,
                format!(
                    "invalid package: it is for a Bitcoin or Litecoin swap, this tower watches {}",
                    s.watches()
                ),
            )
        }
    };
    reply(res)
}

fn reply(res: Result<Registered, RegisterError>) -> Response {
    match res {
        Ok(r) => {
            let code = if r.created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (code, Json(r)).into_response()
        }
        Err(e) => error(e.http_status(), e.to_string()),
    }
}

async fn status(State(s): State<Service>, Path(id): Path<String>) -> Response {
    let view = match &s {
        Service::Utxo(t) => t.view(&id).await.map(|v| Json(v).into_response()),
        Service::Evm(t) => t.view(&id).await.map(|v| Json(v).into_response()),
    };
    view.unwrap_or_else(|| error(404, "no such package"))
}
