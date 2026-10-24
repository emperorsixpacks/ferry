use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// N secret bytes, wiped on drop and redacted in `Debug`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Secret<const N: usize>(#[serde(with = "crate::hex_serde")] [u8; N]);

pub type Secret32 = Secret<32>;
pub type Secret64 = Secret<64>;

impl<const N: usize> Secret<N> {
    pub fn new(bytes: [u8; N]) -> Self {
        Secret(bytes)
    }

    pub fn expose(&self) -> &[u8; N] {
        &self.0
    }
}

impl<const N: usize> Drop for Secret<N> {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl<const N: usize> std::fmt::Debug for Secret<N> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret<{N}>(..)")
    }
}
