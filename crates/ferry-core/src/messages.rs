//! Versioned peer messages (JSON) and the session transcript.

use ferry_btc::adaptor::{EncryptedSignature, Signature};
use ferry_btc::bitcoin::OutPoint;
use ferry_btc::musig::{PartialSig, PubNonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Setup, SwapParams};

pub const PROTOCOL_VERSION: u16 = 1;

/// Every peer message travels in an envelope carrying the transcript hash of all messages
/// before it; a receiver rejects anything that does not extend its own transcript.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub version: u16,
    #[serde(with = "crate::hex_serde")]
    pub session_id: [u8; 32],
    #[serde(with = "crate::hex_serde")]
    pub transcript: [u8; 32],
    pub message: Message,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// taker → maker: terms and the taker's setup.
    Propose { params: SwapParams, setup: Setup },
    /// maker → taker: the maker's setup.
    Accept { setup: Setup },
    /// B → Z: the funded but unbroadcast lock output, and (key path) B's MuSig2 nonce for
    /// tx_redeem.
    LockTemplate {
        outpoint: OutPoint,
        amount: u64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::hex_opt"
        )]
        redeem_nonce: Option<PubNonce>,
    },
    /// Z → B: Z's signature on tx_cancel and adaptor signature on tx_refund under B_s; with the
    /// key path also Z's MuSig2 nonce and partial signature on tx_redeem.
    CancelSigs {
        cancel_sig: Signature,
        refund_enc_sig: EncryptedSignature,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::hex_opt"
        )]
        redeem_nonce: Option<PubNonce>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::hex_opt"
        )]
        redeem_partial: Option<PartialSig>,
    },
    /// B → Z: B's signature on tx_cancel.
    CancelSig { cancel_sig: Signature },
    /// B → Z: B's adaptor signature on tx_redeem under Z_s (script path) and, with the key
    /// path, B's MuSig2 partial signature of the key-path adaptor signature under Z_s.
    RedeemAdaptor {
        redeem_enc_sig: EncryptedSignature,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::hex_opt"
        )]
        redeem_partial: Option<PartialSig>,
    },
}

impl Message {
    pub fn name(&self) -> &'static str {
        match self {
            Message::Propose { .. } => "Propose",
            Message::Accept { .. } => "Accept",
            Message::LockTemplate { .. } => "LockTemplate",
            Message::CancelSigs { .. } => "CancelSigs",
            Message::CancelSig { .. } => "CancelSig",
            Message::RedeemAdaptor { .. } => "RedeemAdaptor",
        }
    }
}

/// Running hash over the session's messages in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcript(#[serde(with = "crate::hex_serde")] [u8; 32]);

impl Transcript {
    pub fn new(session_id: &[u8; 32]) -> Self {
        let mut h = Sha256::new();
        h.update(b"ferry/v1/transcript");
        h.update(session_id);
        Transcript(h.finalize().into())
    }

    pub fn hash(&self) -> [u8; 32] {
        self.0
    }

    pub fn absorb(&mut self, message: &Message) {
        let mut h = Sha256::new();
        h.update(self.0);
        h.update(serde_json::to_vec(message).expect("messages serialize"));
        self.0 = h.finalize().into();
    }
}
