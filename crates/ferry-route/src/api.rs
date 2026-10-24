//! The router's HTTP API, guarded like ferryd's control API (`crates/ferryd/src/http.rs:82-105`):
//! a bearer token on every request, no CORS, and a request carrying an `Origin` header is refused
//! unless that origin was allowed. The listener is loopback unless explicitly opened.
//!
//! - `POST /api/routes` → `201` RouteView
//! - `GET  /api/routes`, `GET /api/routes/:id`
//! - `POST /api/routes/:id/continue` `{maker2?, min_out?, zec_zat?}`: leave `holding`, or skip
//!   the privacy pause
//! - `POST /api/routes/:id/stop`: before leg 2 only; the user keeps the ZEC
//! - `GET  /api/events`: Server-Sent Events, `event: route` with a RouteView
//! - `GET  /api/status`: the configured legs

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::json;
use tokio_stream::wrappers::BroadcastStream;

use crate::hub::{ContinueArg, CreateRoute, Hub, HubError};
use crate::legs::Ferryd;
use crate::route::Obs;
use crate::view::RouteView;

impl IntoResponse for HubError {
    fn into_response(self) -> Response {
        let code = StatusCode::from_u16(self.0).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (code, Json(json!({ "error": self.1 }))).into_response()
    }
}

pub struct Api<F: Ferryd> {
    pub hub: Arc<Hub<F>>,
    pub token: String,
    /// Browser origins allowed to call the API.
    pub ui_origins: Vec<String>,
}

type S<F> = State<Arc<Api<F>>>;

pub fn router<F: Ferryd>(api: Arc<Api<F>>) -> Router {
    Router::new()
        .route("/api/status", get(status::<F>))
        .route("/api/routes", get(list::<F>).post(create::<F>))
        .route("/api/routes/{id}", get(get_route::<F>))
        .route("/api/routes/{id}/continue", post(resume::<F>))
        .route("/api/routes/{id}/stop", post(stop::<F>))
        .route("/api/events", get(events::<F>))
        .fallback(|| async { HubError(404, "not found".into()) })
        .layer(middleware::from_fn_with_state(api.clone(), guard::<F>))
        .with_state(api)
}

async fn guard<F: Ferryd>(State(a): S<F>, req: Request, next: Next) -> Response {
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .is_ok_and(|o| a.ui_origins.iter().any(|x| x == o));
        if !allowed {
            return HubError(403, "This origin may not use the ferry-route API".into())
                .into_response();
        }
    }
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if !token.is_some_and(|t| constant_time_eq(t.as_bytes(), a.token.as_bytes())) {
        return HubError(
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

/// A JSON body (an empty one reads as `T::default()` when `empty_ok`).
fn body<T: DeserializeOwned + Default>(bytes: &Bytes, empty_ok: bool) -> Result<T, HubError> {
    if empty_ok && bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(bytes).map_err(|e| HubError(400, format!("bad request body: {e}")))
}

async fn status<F: Ferryd>(State(a): S<F>) -> Json<serde_json::Value> {
    let routes = a.hub.routes();
    Json(json!({
        "legs": a.hub.legs().map(|(pair, role)| json!({"pair": pair, "role": role})).collect::<Vec<_>>(),
        "routes": {
            "total": routes.len(),
            "active": routes.iter().filter(|r| r.phase.is_active()).count(),
        },
        "needed_confs": a.hub.policy.needed_confs,
        "default_delay_secs": a.hub.settings.default_delay_secs,
        "leg2_window_secs": a.hub.policy.leg2_window_secs,
    }))
}

async fn list<F: Ferryd>(State(a): S<F>) -> Json<Vec<RouteView>> {
    let mut routes = a.hub.routes();
    routes.sort_by(|x, y| (y.created_at, &y.id).cmp(&(x.created_at, &x.id)));
    Json(routes.iter().map(|r| a.hub.view(r)).collect())
}

async fn get_route<F: Ferryd>(
    State(a): S<F>,
    Path(id): Path<String>,
) -> Result<Json<RouteView>, HubError> {
    a.hub
        .route(&id)
        .map(|r| Json(a.hub.view(&r)))
        .ok_or(HubError(404, "no such route".into()))
}

async fn create<F: Ferryd>(
    State(a): S<F>,
    bytes: Bytes,
) -> Result<(StatusCode, Json<RouteView>), HubError> {
    let req: CreateRoute = serde_json::from_slice(&bytes)
        .map_err(|e| HubError(400, format!("bad request body: {e}")))?;
    let r = a.hub.create(req).await?;
    Ok((StatusCode::CREATED, Json(a.hub.view(&r))))
}

async fn resume<F: Ferryd>(
    State(a): S<F>,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Result<Json<RouteView>, HubError> {
    let arg: ContinueArg = body(&bytes, true)?;
    let r = a.hub.resume(&id, arg).await?;
    Ok(Json(a.hub.view(&r)))
}

async fn stop<F: Ferryd>(
    State(a): S<F>,
    Path(id): Path<String>,
) -> Result<Json<RouteView>, HubError> {
    let r = a.hub.user(&id, Obs::Stop).await?;
    Ok(Json(a.hub.view(&r)))
}

async fn events<F: Ferryd>(State(a): S<F>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // Subscribe before taking the snapshot so nothing falls between the two.
    let rx = a.hub.subscribe();
    let initial: Vec<RouteView> = a.hub.routes().iter().map(|r| a.hub.view(r)).collect();
    let live = BroadcastStream::new(rx).filter_map(|m| async move { m.ok() });
    let frames = stream::iter(initial).chain(live).map(|v| {
        let data = serde_json::to_string(&v).expect("a view serializes");
        Ok(Event::default().event("route").data(data))
    });
    Sse::new(frames).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::tests::Rig;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TOKEN: &str = "test-token";

    fn app(rig: &Rig) -> Router {
        router(Arc::new(Api {
            hub: Arc::new(rig.hub()),
            token: TOKEN.into(),
            ui_origins: vec!["http://127.0.0.1:5180".into()],
        }))
    }

    fn req(method: &str, path: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
    }

    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> (u16, serde_json::Value) {
        let b = body.as_ref().map(|v| v.to_string()).unwrap_or_default();
        let resp = app
            .clone()
            .oneshot(req(method, path).body(Body::from(b)).unwrap())
            .await
            .unwrap();
        let code = resp.status().as_u16();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (
            code,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn create_body() -> serde_json::Value {
        json!({
            "from": "btc", "to": "usdc-base", "zec_zat": 100_000_000,
            "maker1": {"url": "http://127.0.0.1:7111", "name": "Kestrel"},
            "maker2": [{"url": "http://127.0.0.1:7912", "name": "Heron"}],
            "max_in": 412_500, "min_out": 39_200_000
        })
    }

    #[tokio::test]
    async fn token_and_origin_are_required() {
        let rig = Rig::new();
        let app = app(&rig);
        let send = |b: axum::http::request::Builder| {
            let app = app.clone();
            async move {
                app.oneshot(b.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status()
                    .as_u16()
            }
        };
        assert_eq!(send(Request::builder().uri("/api/routes")).await, 401);
        let wrong = Request::builder()
            .uri("/api/routes")
            .header(header::AUTHORIZATION, "Bearer nope");
        assert_eq!(send(wrong).await, 401);
        let foreign = req("GET", "/api/routes").header(header::ORIGIN, "https://evil.example");
        assert_eq!(send(foreign).await, 403);
        let ui = req("GET", "/api/routes").header(header::ORIGIN, "http://127.0.0.1:5180");
        assert_eq!(send(ui).await, 200);
        assert_eq!(send(req("GET", "/api/status")).await, 200);
        assert_eq!(send(req("GET", "/nope")).await, 404);
    }

    #[tokio::test]
    async fn create_list_get_stop() {
        let rig = Rig::new();
        let app = app(&rig);
        let (code, v) = call(&app, "POST", "/api/routes", Some(create_body())).await;
        assert_eq!(code, 201, "{v}");
        assert_eq!(v["state"], "leg1");
        assert_eq!(v["legs"][0]["maker"], "Kestrel");
        assert_eq!(v["amounts"]["zec2_zat"], 99_940_000);
        assert_eq!(v["amounts"]["out_min"], 39_200_000);
        assert_eq!(v["privacy"]["delay_secs"], json!([300, 1800]));
        let id = v["id"].as_str().unwrap().to_string();

        let (code, list) = call(&app, "GET", "/api/routes", None).await;
        assert_eq!((code, list.as_array().unwrap().len()), (200, 1));
        let (code, one) = call(&app, "GET", &format!("/api/routes/{id}"), None).await;
        assert_eq!((code, one["id"].as_str()), (200, Some(id.as_str())));
        assert_eq!(call(&app, "GET", "/api/routes/rffff", None).await.0, 404);

        // One route per daemon at a time; bad bodies are 400.
        assert_eq!(
            call(&app, "POST", "/api/routes", Some(create_body()))
                .await
                .0,
            409
        );
        let mut same = create_body();
        same["to"] = json!("btc");
        assert_eq!(call(&app, "POST", "/api/routes", Some(same)).await.0, 400);
        let mut extra = create_body();
        extra["sweep_to"] = json!("utest1attacker");
        let (code, e) = call(&app, "POST", "/api/routes", Some(extra)).await;
        assert_eq!(
            code, 400,
            "a client can never choose the sweep address: {e}"
        );
        assert_eq!(call(&app, "POST", "/api/routes", None).await.0, 400);

        // continue is refused while leg 1 runs; stop is accepted and takes effect after leg 1.
        let (code, e) = call(&app, "POST", &format!("/api/routes/{id}/continue"), None).await;
        assert_eq!(code, 409, "{e}");
        let (code, v) = call(&app, "POST", &format!("/api/routes/{id}/stop"), None).await;
        assert_eq!((code, &v["stop_requested"]), (200, &json!(true)));
        assert!(v["note"].as_str().unwrap().contains("You asked to stop"));
        let bad = json!({"min_out": "lots"});
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("/api/routes/{id}/continue"),
                Some(bad)
            )
            .await
            .0,
            400
        );
    }

    #[tokio::test]
    async fn events_start_with_every_route() {
        let rig = Rig::new();
        let app = app(&rig);
        let (_, v) = call(&app, "POST", "/api/routes", Some(create_body())).await;
        let resp = app
            .clone()
            .oneshot(req("GET", "/api/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(resp.headers()[header::CONTENT_TYPE], "text/event-stream");
        let mut body = resp.into_body();
        let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
        let text = String::from_utf8(frame.to_vec()).unwrap();
        assert!(text.starts_with("event: route\ndata: {"), "{text}");
        assert!(text.contains(v["id"].as_str().unwrap()));
    }
}
