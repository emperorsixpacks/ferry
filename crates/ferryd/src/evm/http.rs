//! HTTP routes of an EVM daemon: the same UI API and peer protocol paths as the Bitcoin
//! daemon (crate::http), with EVM bodies.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseFrame, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ferry_core::evm::EvmEnvelope;
use ferry_core::ZecLeg;
use futures_util::stream::{self, Stream, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;

use super::config::{EvmOffer, EvmProposeRequest};
use super::daemon::EvmDaemon;
use super::view;
use crate::config::Delivery;
use crate::daemon::{ApiError, SseEvent};

type D<L> = State<Arc<EvmDaemon<L>>>;

struct ApiJson<T>(T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(v)| ApiJson(v))
            .map_err(|e| ApiError(400, e.body_text()))
    }
}

pub fn api_router<L: ZecLeg + 'static>(daemon: Arc<EvmDaemon<L>>) -> Router {
    let mut r = Router::new()
        .route("/api/status", get(status::<L>))
        .route("/api/swaps", get(list_swaps::<L>).post(create_swap::<L>))
        .route("/api/swaps/{id}", get(get_swap::<L>))
        .route("/api/events", get(events::<L>))
        .route("/api/addresses", get(addresses::<L>))
        .route("/api/withdraw", post(withdraw::<L>))
        .route("/api/withdrawals", get(withdrawals::<L>));
    if daemon.cli.demo_faults {
        r = r
            .route("/api/swaps/{id}/fault", post(fault::<L>))
            .route("/api/withdraw/fault", post(withdraw_fault::<L>));
    }
    r.fallback(|| async { ApiError(404, "not found".into()) })
        .layer(middleware::from_fn_with_state(daemon.clone(), guard::<L>))
        .with_state(daemon)
}

pub fn peer_router<L: ZecLeg + 'static>(daemon: Arc<EvmDaemon<L>>) -> Router {
    Router::new()
        .route("/peer/offer", get(offer::<L>))
        .route("/peer/quote", post(quote::<L>))
        .route("/peer/swaps", post(propose::<L>))
        .route(
            "/peer/swaps/{id}/messages",
            post(deliver::<L>).get(outbox::<L>),
        )
        .fallback(|| async { ApiError(404, "not found".into()) })
        .with_state(daemon)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Refuse foreign browser origins and requests without the API token.
async fn guard<L: ZecLeg + 'static>(State(d): D<L>, req: Request, next: Next) -> Response {
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .is_ok_and(|o| d.cli.ui_origin.iter().any(|a| a == o));
        if !allowed {
            return ApiError(403, "This origin may not use the ferryd API".into()).into_response();
        }
    }
    if !bearer(req.headers())
        .is_some_and(|t| constant_time_eq(t.as_bytes(), d.api_token.as_bytes()))
    {
        return ApiError(
            401,
            "Missing or wrong API token (Authorization: Bearer <data-dir>/api-token)".into(),
        )
        .into_response();
    }
    next.run(req).await
}

async fn status<L: ZecLeg + 'static>(
    State(d): D<L>,
) -> Result<Json<view::EvmStatusView>, ApiError> {
    // The last published status (crate::reads): it never waits for a round.
    if let Some(s) = d.reads.status() {
        return Ok(Json(s));
    }
    d.status_view()
        .await
        .map(Json)
        .map_err(|e| ApiError(503, e.to_string()))
}

/// The swaps as last published (crate::reads): it never waits for a round.
async fn list_swaps<L: ZecLeg + 'static>(State(d): D<L>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json")],
        d.reads.swaps_json(),
    )
}

/// One swap as last published (crate::reads).
async fn get_swap<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    d.reads
        .swap(&id)
        .map(|json| ([(header::CONTENT_TYPE, "application/json")], json))
        .ok_or(ApiError(404, "no such swap".into()))
}

#[derive(Deserialize)]
struct CreateSwap {
    maker: String,
    zec_zat: u64,
    /// A firm quote from this maker (crate::quote), as `POST /peer/quote` returned it.
    #[serde(default)]
    quote: Option<crate::quote::SignedQuote>,
    /// A route leg's label, sweep destination and price limit (crate::route).
    #[serde(flatten)]
    route: crate::route::RouteArgs,
}

async fn create_swap<L: ZecLeg + 'static>(
    State(d): D<L>,
    ApiJson(req): ApiJson<CreateSwap>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    let id = d
        .create_swap(req.maker, req.zec_zat, req.quote, req.route)
        .await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

#[derive(Deserialize)]
struct Fault {
    fault: String,
}

async fn fault<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
    ApiJson(f): ApiJson<Fault>,
) -> Result<Json<serde_json::Value>, ApiError> {
    d.fault(&id, &f.fault).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn events<L: ZecLeg + 'static>(
    State(d): D<L>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    let rx = d.events.subscribe();
    // What was last published (crate::reads), so a new stream never waits for a round.
    let mut initial = vec![];
    if let Some(s) = d.reads.status() {
        initial.push(SseEvent {
            event: "status",
            data: serde_json::to_string(&s).expect("serializes"),
        });
    }
    for data in d.reads.swaps() {
        initial.push(SseEvent {
            event: "swap",
            data,
        });
    }
    let live = BroadcastStream::new(rx).filter_map(|m| async move { m.ok() });
    let frames = stream::iter(initial)
        .chain(live)
        .map(|e| Ok(SseFrame::default().event(e.event).data(e.data)));
    Sse::new(frames).keep_alive(KeepAlive::default())
}

async fn addresses<L: ZecLeg + 'static>(
    State(d): D<L>,
    Query(q): Query<crate::http::AddressQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    d.funding_addresses(q.fresh()).await.map(Json)
}

async fn withdraw<L: ZecLeg + 'static>(
    State(d): D<L>,
    ApiJson(req): ApiJson<crate::withdraw::WithdrawRequest>,
) -> Result<(StatusCode, Json<crate::withdraw::WithdrawalView>), ApiError> {
    let w = d.withdraw(req).await?;
    Ok((StatusCode::CREATED, Json(w.view())))
}

async fn withdrawals<L: ZecLeg + 'static>(
    State(d): D<L>,
) -> Json<Vec<crate::withdraw::WithdrawalView>> {
    Json(d.withdrawals.views())
}

async fn withdraw_fault<L: ZecLeg + 'static>(
    State(d): D<L>,
    ApiJson(f): ApiJson<crate::withdraw::FaultRequest>,
) -> Json<serde_json::Value> {
    d.withdrawals.arm(f.crash);
    Json(json!({ "ok": true }))
}

async fn offer<L: ZecLeg + 'static>(State(d): D<L>) -> Json<EvmOffer> {
    Json(d.offer_now().await)
}

async fn quote<L: ZecLeg + 'static>(
    State(d): D<L>,
    peer: crate::quote::PeerIp,
    ApiJson(req): ApiJson<crate::quote::QuoteRequest>,
) -> Result<Json<crate::quote::SignedQuote>, ApiError> {
    d.issue_quote(req, peer.0).await.map(Json)
}

async fn propose<L: ZecLeg + 'static>(
    State(d): D<L>,
    ApiJson(req): ApiJson<EvmProposeRequest>,
) -> Result<(StatusCode, Json<EvmEnvelope>), ApiError> {
    let reply = d.accept_proposal(req).await?;
    Ok((StatusCode::CREATED, Json(reply)))
}

async fn deliver<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(env): ApiJson<EvmEnvelope>,
) -> Result<Json<Delivery>, ApiError> {
    d.peer_deliver(&id, env, bearer(&headers)).await.map(Json)
}

#[derive(Deserialize)]
struct After {
    #[serde(default)]
    after: usize,
}

async fn outbox<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
    Query(q): Query<After>,
    headers: HeaderMap,
) -> Result<Json<Vec<EvmEnvelope>>, ApiError> {
    d.peer_outbox(&id, q.after, bearer(&headers))
        .await
        .map(Json)
}
