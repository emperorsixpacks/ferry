//! HTTP routes: the UI API (docs/API.md) and the peer protocol.
//!
//! Peer protocol (maker side; the taker initiates every request):
//! - `GET  /peer/offer`                       terms, rate and the maker's role
//! - `POST /peer/quote`                       `{pair, taker_role, bucket_zat}` → a signed firm quote
//! - `POST /peer/swaps`                       `{envelope: Propose, taker_url, quote_id?}` → `Accept`
//! - `POST /peer/swaps/:id/messages`          one taker envelope (retries are acknowledged once)
//! - `GET  /peer/swaps/:id/messages?after=n`  the maker's envelopes from index n

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseFrame, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ferry_core::{Envelope, ZecLeg};
use futures_util::stream::{self, Stream, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;

use crate::config::ProposeRequest;
use crate::daemon::{ApiError, Daemon, SseEvent};
use crate::view;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let body = match self.code() {
            Some(code) => json!({ "error": self.1, "code": code }),
            None => json!({ "error": self.1 }),
        };
        (status, Json(body)).into_response()
    }
}

type D<L> = State<Arc<Daemon<L>>>;

/// `Json` whose rejections are `{"error": ...}` bodies like every other error.
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

/// Control API for the UI: loopback listener, bearer token, no CORS, `Origin` allowlist.
pub fn api_router<L: ZecLeg + 'static>(daemon: Arc<Daemon<L>>) -> Router {
    let mut r = Router::new()
        .route("/api/status", get(status::<L>))
        .route("/api/swaps", get(list_swaps::<L>).post(create_swap::<L>))
        .route("/api/swaps/{id}", get(get_swap::<L>))
        .route("/api/events", get(events::<L>))
        .route("/api/addresses", get(addresses::<L>));
    if daemon.cli.demo_faults {
        r = r.route("/api/swaps/{id}/fault", post(fault::<L>));
    }
    r.fallback(|| async { ApiError(404, "not found".into()) })
        .layer(middleware::from_fn_with_state(daemon.clone(), guard::<L>))
        .with_state(daemon)
}

/// Peer protocol, server to server (a maker may expose this listener).
pub fn peer_router<L: ZecLeg + 'static>(daemon: Arc<Daemon<L>>) -> Router {
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
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if !token.is_some_and(|t| constant_time_eq(t.as_bytes(), d.api_token.as_bytes())) {
        return ApiError(
            401,
            "Missing or wrong API token (Authorization: Bearer <data-dir>/api-token)".into(),
        )
        .into_response();
    }
    next.run(req).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn status<L: ZecLeg + 'static>(State(d): D<L>) -> Result<Json<view::StatusView>, ApiError> {
    if let Some(s) = d.state.lock().await.status.clone() {
        return Ok(Json(s));
    }
    d.status_view()
        .await
        .map(Json)
        .map_err(|e| ApiError(503, e.to_string()))
}

async fn list_swaps<L: ZecLeg + 'static>(State(d): D<L>) -> Json<Vec<view::SwapView>> {
    Json(
        d.state
            .lock()
            .await
            .swaps
            .values()
            .map(view::swap_view)
            .collect(),
    )
}

async fn get_swap<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
) -> Result<Json<view::SwapView>, ApiError> {
    let st = d.state.lock().await;
    st.swaps
        .get(&id)
        .map(|r| Json(view::swap_view(r)))
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
    /// `drop_broadcasts`: how many (default 1).
    count: Option<u32>,
}

async fn fault<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
    ApiJson(f): ApiJson<Fault>,
) -> Result<Json<serde_json::Value>, ApiError> {
    d.fault(&id, &f.fault, f.count).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn events<L: ZecLeg + 'static>(
    State(d): D<L>,
) -> Sse<impl Stream<Item = Result<SseFrame, Infallible>>> {
    // Subscribe before taking the snapshot so nothing falls between the two.
    let rx = d.events.subscribe();
    let mut initial = vec![];
    {
        let st = d.state.lock().await;
        if let Some(s) = &st.status {
            initial.push(SseEvent {
                event: "status",
                data: serde_json::to_string(s).expect("serializes"),
            });
        }
        for rec in st.swaps.values() {
            let data = serde_json::to_string(&view::swap_view(rec)).expect("serializes");
            initial.push(SseEvent {
                event: "swap",
                data,
            });
        }
    }
    let live = BroadcastStream::new(rx).filter_map(|m| async move { m.ok() });
    let frames = stream::iter(initial)
        .chain(live)
        .map(|e| Ok(SseFrame::default().event(e.event).data(e.data)));
    Sse::new(frames).keep_alive(KeepAlive::default())
}

async fn addresses<L: ZecLeg + 'static>(
    State(d): D<L>,
) -> Result<Json<serde_json::Value>, ApiError> {
    d.funding_addresses().await.map(Json)
}

async fn offer<L: ZecLeg + 'static>(State(d): D<L>) -> Json<crate::config::Offer> {
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
    ApiJson(req): ApiJson<ProposeRequest>,
) -> Result<(StatusCode, Json<Envelope>), ApiError> {
    let reply = d.accept_proposal(req).await?;
    Ok((StatusCode::CREATED, Json(reply)))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
}

async fn deliver<L: ZecLeg + 'static>(
    State(d): D<L>,
    Path(id): Path<String>,
    headers: HeaderMap,
    ApiJson(env): ApiJson<Envelope>,
) -> Result<Json<crate::config::Delivery>, ApiError> {
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
) -> Result<Json<Vec<Envelope>>, ApiError> {
    d.peer_outbox(&id, q.after, bearer(&headers))
        .await
        .map(Json)
}
