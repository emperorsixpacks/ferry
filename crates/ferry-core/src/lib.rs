//! Ferry swap logic, free of I/O: parameters and timing policy, versioned peer messages,
//! key material with cross-group DLEQ proofs, the joint Ironwood key, and explicit state
//! machines for both roles. The daemon feeds [`Event`]s in and executes the returned
//! [`Action`]s; the Zcash wallet side is abstracted by [`ZecLeg`].

mod b;
mod error;
pub mod joint;
pub mod keys;
pub mod messages;
pub mod params;
mod secret;
mod session;
mod swap;
mod z;
pub mod zec;

pub use b::{BState, BSwap};
pub use error::Error;
pub use keys::{LocalKeys, Peer, Setup};
pub use messages::{Envelope, Message, Transcript, PROTOCOL_VERSION};
pub use params::{Policy, SwapParams};
pub use secret::{Secret, Secret32, Secret64};
pub use session::Session;
pub use swap::{accept, Action, ChainEvent, Event, Proposal, Swap};
pub use z::{ZState, ZSwap};
pub use zec::{SendFailure, ZecLeg, ZecNote, ZecStatus};

pub use ferry_btc::{Role, Spend};

/// `Option<[u8; N]>` as an optional hex string.
pub(crate) mod hex_opt {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, T: AsRef<[u8]>>(
        v: &Option<T>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(v) => s.serialize_some(&hex::encode(v)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: TryFrom<Vec<u8>>>(
        d: D,
    ) -> Result<Option<T>, D::Error> {
        let Some(s) = Option::<String>::deserialize(d)? else {
            return Ok(None);
        };
        let v = hex::decode(s).map_err(D::Error::custom)?;
        T::try_from(v)
            .map(Some)
            .map_err(|_| D::Error::custom("wrong byte length"))
    }
}

pub(crate) mod hex_serde {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer, T: AsRef<[u8]>>(v: &T, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: TryFrom<Vec<u8>>>(
        d: D,
    ) -> Result<T, D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s).map_err(D::Error::custom)?;
        T::try_from(v).map_err(|_| D::Error::custom("wrong byte length"))
    }
}
