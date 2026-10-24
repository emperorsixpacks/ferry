//! State shared by both roles of an EVM swap once negotiation is done.

use ferry_dleq::k256::elliptic_curve::PrimeField;
use ferry_dleq::{PallasPoint, PallasScalar};
use ferry_evm::{Address, B256};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{EvmEnvelope, EvmKeys, EvmMessage, EvmParams, EvmPeer, EvmTranscript, LockTerms};
use crate::{joint, Error, Role};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmSession {
    #[serde(with = "crate::hex_serde")]
    pub session_id: [u8; 32],
    pub params: EvmParams,
    pub me: EvmKeys,
    pub peer: EvmPeer,
    pub(crate) transcript: EvmTranscript,
}

impl EvmSession {
    pub fn role(&self) -> Role {
        self.me.role()
    }

    pub fn transcript_hash(&self) -> [u8; 32] {
        self.transcript.hash()
    }

    /// Stamp an outgoing message with the current transcript, then absorb it.
    pub(crate) fn seal(&mut self, message: EvmMessage) -> EvmEnvelope {
        let env = EvmEnvelope {
            version: super::EVM_PROTOCOL_VERSION,
            session_id: self.session_id,
            transcript: self.transcript.hash(),
            message,
        };
        self.transcript.absorb(&env.message);
        env
    }

    /// Check an incoming envelope against our transcript, then absorb it.
    pub(crate) fn open<'a>(&mut self, env: &'a EvmEnvelope) -> Result<&'a EvmMessage, Error> {
        self.transcript.check(env, &self.session_id)?;
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

    /// SEC1 secp256k1 points (Z_s, B_s).
    pub fn secp_pubs(&self) -> ([u8; 33], [u8; 33]) {
        let (me, peer) = (self.me.setup.secp_pub, self.peer.setup.secp_pub);
        (
            self.by_role(me, peer, Role::Z),
            self.by_role(me, peer, Role::B),
        )
    }

    /// EVM accounts (Z's claimer, B's refunder).
    pub fn evm_addresses(&self) -> ([u8; 20], [u8; 20]) {
        let (me, peer) = (self.me.setup.evm_address, self.peer.setup.evm_address);
        (
            self.by_role(me, peer, Role::Z),
            self.by_role(me, peer, Role::B),
        )
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

    /// Bearer token both parties derive for the peer channel.
    pub fn peer_token(&self) -> Option<String> {
        let shared = self.me.ecdh_shared(&self.peer.setup)?;
        let h: [u8; 32] = Sha256::new()
            .chain_update(b"ferry/v1/evm-peer-token")
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

    /// Turn a scalar revealed on chain (claim or refund) into the peer's Pallas share, checking
    /// it against the peer's proven Pallas point.
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

    /// The lock's salt: derived from the session, so both parties know the swap id up front.
    pub fn salt(&self) -> [u8; 32] {
        Sha256::new()
            .chain_update(b"ferry/v1/evm-salt")
            .chain_update(self.session_id)
            .finalize()
            .into()
    }

    /// The FerryLock swap id: `keccak256(abi.encode(B's address, salt))`.
    pub fn swap_id(&self) -> [u8; 32] {
        let (_, b) = self.evm_addresses();
        ferry_evm::swap_id(Address::from(b), B256::from(self.salt())).0
    }

    /// The EIP-712 digest B signs to let Z claim.
    pub fn ready_digest(&self) -> [u8; 32] {
        ferry_evm::ready_digest(
            self.params.chain_id,
            Address::from(self.params.contract),
            B256::from(self.swap_id()),
        )
        .0
    }

    /// Whether `sig` is B's valid Ready(id) signature, under FerryLock's rules.
    pub fn is_ready_sig(&self, sig: &[u8; 65]) -> bool {
        let (_, b) = self.evm_addresses();
        ferry_evm::ready_signer(&B256::from(self.ready_digest()), sig) == Some(Address::from(b))
    }

    /// Exactly the terms B must lock under, and Z checks on chain before locking ZEC.
    pub fn lock_terms(&self) -> Result<LockTerms, Error> {
        let (z_s, b_s) = self.secp_pubs();
        let addr = |sec1: &[u8; 33]| {
            ferry_evm::point_address_sec1(sec1)
                .map(|a| a.0 .0)
                .map_err(|_| Error::InvalidParams("secp point"))
        };
        let (claimer, refunder) = self.evm_addresses();
        let p = &self.params;
        Ok(LockTerms {
            token: p.token,
            amount: p.token_amount,
            z_addr: addr(&z_s)?,
            b_addr: addr(&b_s)?,
            claimer,
            refunder,
            t1: p.t1,
            t2: p.t2,
            max_tip: p.max_tip,
        })
    }
}
