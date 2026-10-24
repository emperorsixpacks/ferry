use crate::Role;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported protocol version {0}")]
    Version(u16),
    #[error("message for another session")]
    SessionMismatch,
    #[error("transcript hash mismatch")]
    TranscriptMismatch,
    #[error("unexpected {message} in state {state}")]
    Unexpected {
        state: String,
        message: &'static str,
    },
    #[error("invalid parameters: {0}")]
    InvalidParams(&'static str),
    #[error("invalid setup from {role:?}: {reason}")]
    InvalidSetup { role: Role, reason: &'static str },
    #[error("DLEQ proof from {0:?} rejected: {1:?}")]
    Dleq(Role, ferry_dleq::VerifyError),
    #[error("MuSig2 key path: {0}")]
    Musig(&'static str),
    #[error("invalid signature: {0}")]
    BadSignature(&'static str),
    #[error("lock output does not match the agreed script/amount")]
    LockMismatch,
    #[error("key recovery failed: {0}")]
    Recovery(&'static str),
    #[error("joint key is the identity")]
    JointKeyIdentity,
    #[error(transparent)]
    Tx(#[from] ferry_btc::TxError),
}
