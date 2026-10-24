use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// 32 secret bytes, wiped on drop and redacted in `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Secret32(#[serde(with = "crate::hex_serde")] [u8; 32]);

impl Secret32 {
    pub fn new(bytes: [u8; 32]) -> Self {
        Secret32(bytes)
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Drop for Secret32 {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret32(..)")
    }
}
