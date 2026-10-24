//! Bitcoin leg of a Ferry swap (Gugger-style, Taproot script paths).
//!
//! ```text
//! lock output   (NUMS internal key)
//!   redeem : <kb> CHECKSIGVERIFY <kz> CHECKSIG
//!   cancel : <T1> CSV DROP <kb> CHECKSIGVERIFY <kz> CHECKSIG
//! cancel output (NUMS internal key)
//!   refund : <kz> CHECKSIGVERIFY <kb> CHECKSIG
//!   punish : <T2> CSV DROP <kz> CHECKSIG
//! ```
//!
//! B's signature on `tx_redeem` is an adaptor signature under `Z_s`, Z's signature on
//! `tx_refund` is an adaptor signature under `B_s`; whichever is published reveals the
//! corresponding Zcash key share.

pub mod adaptor;
pub mod musig;
pub mod scripts;
pub mod tx;

#[cfg(feature = "rpc")]
pub mod rpc;

pub use adaptor::{BtcKey, EncryptionKey};
pub use scripts::{SwapScripts, TapOut};
pub use tx::{Spend, SwapTxs, TxError};
pub use {bitcoin, schnorr_fun};

use serde::{Deserialize, Serialize};

/// Swap party: `Z` holds shielded ZEC and wants BTC, `B` holds BTC and wants ZEC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Role {
    Z,
    B,
}

impl Role {
    pub fn peer(self) -> Role {
        match self {
            Role::Z => Role::B,
            Role::B => Role::Z,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Z => "Z",
            Role::B => "B",
        }
    }
}
