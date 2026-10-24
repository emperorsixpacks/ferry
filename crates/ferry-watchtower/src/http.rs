//! HTTP API.
//!
//! - `POST /packages`      register a [`Package`] → `201 {id, created, status}` (`200` if the same
//!   transactions were already registered; `400` invalid, `409` conflicting, `503` node)
//! - `GET  /packages/{id}` → [`crate::store::PackageView`] (never the transactions themselves)
//! - `GET  /health`        → `{ok, network}` (no auth)
//!
//! With a token configured, `/packages*` need `Authorization: Bearer <token>`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::package::Package;
use crate::tower::Tower;

/// Upload size cap: a package is a few kilobytes.
const MAX_BODY: usize = 64 * 1024;

fn error(code: u16, msg: impl Into<String>) -> Response {
    let code = StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

pub fn router(tower: Arc<Tower>) -> Router {
    Router::new()
        .route("/packages", post(register))
        .route("/packages/{id}", get(status))
        .route_layer(middleware::from_fn_with_state(tower.clone(), auth))
        .route("/health", get(health))
        .fallback(|| async { error(404, "not found") })
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .with_state(tower)
}

async fn auth(State(t): State<Arc<Tower>>, req: Request, next: Next) -> Response {
    if let Some(want) = &t.cfg.token {
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

async fn health(State(t): State<Arc<Tower>>) -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "network": t.cfg.network.to_string() }))
}

async fn register(State(t): State<Arc<Tower>>, body: Bytes) -> Response {
    let package: Package = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(400, format!("invalid package: {e}")),
    };
    match t.register(package).await {
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

async fn status(State(t): State<Arc<Tower>>, Path(id): Path<String>) -> Response {
    match t.view(&id).await {
        Some(v) => Json(v).into_response(),
        None => error(404, "no such package"),
    }
}
