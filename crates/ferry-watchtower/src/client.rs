//! Client for the tower's API (used by ferryd to upload its package).

use reqwest::StatusCode;

use crate::evm::EvmPackageView;
use crate::store::PackageView;
use crate::tower::Registered;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("watchtower unreachable: {0}")]
    Http(#[from] reqwest::Error),
    #[error("watchtower refused ({status}): {message}")]
    Refused { status: u16, message: String },
}

#[derive(Clone, Debug)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl Client {
    pub fn new(base: impl Into<String>, token: Option<String>) -> Client {
        Client {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            base: base.into().trim_end_matches('/').to_string(),
            token,
        }
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) => req.bearer_auth(t),
            None => req,
        }
    }

    async fn read<T: serde::de::DeserializeOwned>(
        resp: reqwest::Response,
    ) -> Result<T, ClientError> {
        let status = resp.status();
        if status == StatusCode::OK || status == StatusCode::CREATED {
            return Ok(resp.json().await?);
        }
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        Err(ClientError::Refused {
            status: status.as_u16(),
            message: body["error"]
                .as_str()
                .unwrap_or("no reason given")
                .to_string(),
        })
    }

    /// Upload a [`crate::Package`] or a [`crate::EvmPackage`].
    pub async fn upload(&self, package: &impl serde::Serialize) -> Result<Registered, ClientError> {
        let req = self
            .http
            .post(format!("{}/packages", self.base))
            .json(package);
        Self::read(self.auth(req).send().await?).await
    }

    pub async fn status(&self, id: &str) -> Result<PackageView, ClientError> {
        let req = self.http.get(format!("{}/packages/{id}", self.base));
        Self::read(self.auth(req).send().await?).await
    }

    /// [`Client::status`] on a `--counter evm` tower.
    pub async fn evm_status(&self, id: &str) -> Result<EvmPackageView, ClientError> {
        let req = self.http.get(format!("{}/packages/{id}", self.base));
        Self::read(self.auth(req).send().await?).await
    }
}
