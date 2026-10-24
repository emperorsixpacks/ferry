use ferry_btc::bitcoin::{Address, OutPoint};
use ferry_btc::musig::KeySpend;
use ferry_btc::{EncryptionKey, SwapScripts, SwapTxs};
use ferry_dleq::k256::elliptic_curve::PrimeField;
use ferry_dleq::{PallasPoint, PallasScalar};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    joint, Envelope, Error, LocalKeys, Message, Peer, Role, SwapParams, Transcript,
    PROTOCOL_VERSION,
};

/// State shared by both roles once negotiation is done.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    #[serde(with = "crate::hex_serde")]
    pub session_id: [u8; 32],
    pub params: SwapParams,
    pub me: LocalKeys,
    pub peer: Peer,
    pub(crate) transcript: Transcript,
}

impl Session {
    pub fn role(&self) -> Role {
        self.me.role()
    }

    pub fn transcript_hash(&self) -> [u8; 32] {
        self.transcript.hash()
    }

    /// Stamp an outgoing message with the current transcript, then absorb it.
    pub(crate) fn seal(&mut self, message: Message) -> Envelope {
        let env = Envelope {
            version: PROTOCOL_VERSION,
            session_id: self.session_id,
            transcript: self.transcript.hash(),
            message,
        };
        self.transcript.absorb(&env.message);
        env
    }

    /// Check an incoming envelope against our transcript, then absorb it.
    pub(crate) fn open<'a>(&mut self, env: &'a Envelope) -> Result<&'a Message, Error> {
        check_envelope(env, &self.session_id, &self.transcript)?;
        self.transcript.absorb(&env.message);
        Ok(&env.message)
    }

    fn by_role<T>(&self, mine: T, theirs: T, want: Role) -> T {
        if self.role() == want {
            mine
        } else {
            theirs
        }
    }

    /// (Z_p, B_p)
    pub fn pallas_pubs(&self) -> (PallasPoint, PallasPoint) {
        let (me, peer) = (self.me.pallas_pub(), self.peer.pallas_pub);
        (
            self.by_role(me, peer, Role::Z),
            self.by_role(me, peer, Role::B),
        )
    }

    pub fn z_encryption_key(&self) -> EncryptionKey {
        self.by_role(self.me.encryption_key(), self.peer.encryption_key, Role::Z)
    }

    pub fn b_encryption_key(&self) -> EncryptionKey {
        self.by_role(self.me.encryption_key(), self.peer.encryption_key, Role::B)
    }

    /// Joint Ironwood `ak` (32 bytes, σ applied).
    pub fn joint_ak_bytes(&self) -> Result<[u8; 32], Error> {
        let (z_p, b_p) = self.pallas_pubs();
        joint::joint_ak_bytes(&z_p, &b_p)
    }

    /// σ ∈ {1, −1} with `ak = σ·(Z_p + B_p)`.
    pub fn joint_sigma(&self) -> Result<i8, Error> {
        let (z_p, b_p) = self.pallas_pubs();
        let (_, negated) = joint::normalize_ak(&(z_p + b_p))?;
        Ok(if negated { -1 } else { 1 })
    }

    /// Joint full viewing key `ak || nk || rivk`.
    pub fn joint_fvk(&self) -> Result<[u8; 96], Error> {
        let (z_p, b_p) = self.pallas_pubs();
        let (mine, theirs) = (&self.me.setup.nonce, &self.peer.setup.nonce);
        joint::joint_fvk_bytes(
            &self.session_id,
            &z_p,
            &b_p,
            self.by_role(mine, theirs, Role::Z),
            self.by_role(mine, theirs, Role::B),
            self.me.ecdh_shared(&self.peer.setup).as_ref(),
        )
    }

    /// Bearer token both parties derive for the peer channel (None for swaps predating ECDH).
    pub fn peer_token(&self) -> Option<String> {
        let shared = self.me.ecdh_shared(&self.peer.setup)?;
        let h: [u8; 32] = Sha256::new()
            .chain_update(b"ferry/v1/peer-token")
            .chain_update(self.session_id)
            .chain_update(shared)
            .finalize()
            .into();
        Some(hex::encode(h))
    }

    /// Joint `ask` from our share and the peer's recovered share.
    pub fn joint_ask(&self, peer_share: &PallasScalar) -> Result<Zeroizing<[u8; 32]>, Error> {
        let mine = self.me.share();
        match self.role() {
            Role::Z => joint::joint_ask_bytes(&mine, peer_share),
            Role::B => joint::joint_ask_bytes(peer_share, &mine),
        }
    }

    /// Turn a secp256k1 scalar recovered from an adaptor signature into the peer's Pallas
    /// share, checking it against the peer's proven Pallas point.
    pub fn peer_share_from_secp(
        &self,
        secp_be: &[u8; 32],
    ) -> Result<Zeroizing<PallasScalar>, Error> {
        let s: Option<ferry_dleq::SecpScalar> =
            ferry_dleq::SecpScalar::from_repr((*secp_be).into()).into();
        let s = s.ok_or(Error::Recovery("not a secp256k1 scalar"))?;
        let share = Zeroizing::new(
            ferry_dleq::from_secp_scalar(&s).ok_or(Error::Recovery("share above 2^254"))?,
        );
        if ferry_dleq::spend_auth_g() * *share != self.peer.pallas_pub {
            return Err(Error::Recovery(
                "share does not match the peer's Pallas key",
            ));
        }
        Ok(share)
    }

    pub fn scripts(&self) -> SwapScripts {
        let (me, peer) = (self.me.btc_key().xonly(), self.peer.btc_key);
        SwapScripts::new(
            self.by_role(me, peer, Role::B),
            self.by_role(me, peer, Role::Z),
            self.params.t1,
            self.params.t2,
            self.params.keypath,
        )
    }

    /// MuSig2 key-path context for the lock output, when the swap uses the key path.
    pub fn key_spend(&self) -> Option<KeySpend> {
        KeySpend::new(&self.scripts())
    }

    pub fn lock_address(&self) -> Address {
        self.scripts().lock.address(self.params.network)
    }

    fn address(&self, role: Role) -> Address {
        if self.role() == role {
            self.me
                .setup
                .btc_address
                .clone()
                .require_network(self.params.network)
                .expect("own address checked at setup")
        } else {
            self.peer.btc_address.clone()
        }
    }

    /// Transaction templates for a lock at `outpoint`.
    pub fn txs(&self, outpoint: OutPoint) -> Result<SwapTxs, Error> {
        let z = self.address(Role::Z).script_pubkey();
        Ok(SwapTxs::new(
            self.scripts(),
            outpoint,
            self.params.btc_amount(),
            self.params.btc_fee(),
            z.clone(),
            self.address(Role::B).script_pubkey(),
            z,
        )?)
    }
}

pub(crate) fn check_envelope(
    env: &Envelope,
    session_id: &[u8; 32],
    transcript: &Transcript,
) -> Result<(), Error> {
    if env.version != PROTOCOL_VERSION {
        return Err(Error::Version(env.version));
    }
    if env.session_id != *session_id {
        return Err(Error::SessionMismatch);
    }
    if env.transcript != transcript.hash() {
        return Err(Error::TranscriptMismatch);
    }
    Ok(())
}
