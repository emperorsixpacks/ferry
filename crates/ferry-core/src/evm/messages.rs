//! Versioned EVM-swap peer messages (JSON) and their transcript. Separate from the Bitcoin
//! protocol's messages, with their own transcript domain, so neither can be replayed as the
//! other.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{EvmParams, EvmSetup};
use crate::Error;

pub const EVM_PROTOCOL_VERSION: u16 = 1;

/// Every peer message travels in an envelope carrying the transcript hash of all messages
/// before it; a receiver rejects anything that does not extend its own transcript.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvmEnvelope {
    pub version: u16,
    #[serde(with = "crate::hex_serde")]
    pub session_id: [u8; 32],
    #[serde(with = "crate::hex_serde")]
    pub transcript: [u8; 32],
    pub message: EvmMessage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EvmMessage {
    /// taker → maker: terms and the taker's setup.
    Propose { params: EvmParams, setup: EvmSetup },
    /// maker → taker: the maker's setup.
    Accept { setup: EvmSetup },
    /// B → Z, once the ZEC lock has N confirmations: B's EIP-712 `Ready(id)` signature
    /// (`r || s || v`), which FerryLock requires on a claim. The EVM form of the redeem
    /// adaptor signature.
    ReadySig {
        #[serde(with = "crate::hex_serde")]
        sig: [u8; 65],
    },
}

impl EvmMessage {
    pub fn name(&self) -> &'static str {
        match self {
            EvmMessage::Propose { .. } => "Propose",
            EvmMessage::Accept { .. } => "Accept",
            EvmMessage::ReadySig { .. } => "ReadySig",
        }
    }
}

/// Running hash over the session's messages in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmTranscript(#[serde(with = "crate::hex_serde")] [u8; 32]);

impl EvmTranscript {
    pub fn new(session_id: &[u8; 32]) -> Self {
        let mut h = Sha256::new();
        h.update(b"ferry/v1/evm-transcript");
        h.update(session_id);
        EvmTranscript(h.finalize().into())
    }

    pub fn hash(&self) -> [u8; 32] {
        self.0
    }

    pub fn absorb(&mut self, message: &EvmMessage) {
        let mut h = Sha256::new();
        h.update(self.0);
        h.update(serde_json::to_vec(message).expect("messages serialize"));
        self.0 = h.finalize().into();
    }

    pub(crate) fn check(&self, env: &EvmEnvelope, session_id: &[u8; 32]) -> Result<(), Error> {
        if env.version != EVM_PROTOCOL_VERSION {
            return Err(Error::Version(env.version));
        }
        if env.session_id != *session_id {
            return Err(Error::SessionMismatch);
        }
        if env.transcript != self.0 {
            return Err(Error::TranscriptMismatch);
        }
        Ok(())
    }
}
