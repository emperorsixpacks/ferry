//! Per-party key material for an EVM swap: the Zcash spend-authority share (valid on both
//! curves) with its DLEQ proof, the nonce for the joint viewing key, an ephemeral ECDH key, and
//! the party's EVM account (Z: where the tokens go; B: who locks, refunds and signs Ready).

use ferry_dleq::k256::elliptic_curve::{Field, PrimeField};
use ferry_dleq::{PallasPoint, PallasScalar, SecpPoint, SecpScalar};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::keys::dleq_context;
use crate::{Error, Role, Secret32};

/// Public setup data a party sends in an EVM `Propose` / `Accept`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvmSetup {
    pub role: Role,
    /// `x·SpendAuthG` (Pallas encoding).
    #[serde(with = "crate::hex_serde")]
    pub pallas_pub: [u8; 32],
    /// `x·G` (secp256k1, SEC1 compressed): the lock commits to its Ethereum address.
    #[serde(with = "crate::hex_serde")]
    pub secp_pub: [u8; 33],
    #[serde(with = "crate::hex_serde")]
    pub dleq_proof: Vec<u8>,
    /// Contribution to the joint `nk` / `rivk`.
    #[serde(with = "crate::hex_serde")]
    pub nonce: [u8; 32],
    /// Ephemeral secp256k1 ECDH key (SEC1): keeps `nk`/`rivk` and the peer token out of reach
    /// of anyone who only sees the transcript.
    #[serde(with = "crate::hex_serde")]
    pub ecdh: [u8; 33],
    /// Z: the claimer (claim and punish pay here). B: the refunder (locks, refunds, signs
    /// Ready).
    #[serde(with = "crate::hex_serde")]
    pub evm_address: [u8; 20],
}

/// Our own secrets plus the setup we published.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmKeys {
    /// Zcash share as a Pallas scalar (canonical LE encoding), < 2^254.
    share: Secret32,
    /// Ephemeral ECDH secret (big-endian secp256k1 scalar).
    ecdh: Secret32,
    pub setup: EvmSetup,
}

impl EvmKeys {
    pub fn generate<R: RngCore + CryptoRng>(
        rng: &mut R,
        session_id: &[u8; 32],
        role: Role,
        evm_address: [u8; 20],
    ) -> Self {
        let share = ferry_dleq::random_mutual_scalar(rng);
        let proven = ferry_dleq::prove(rng, &dleq_context(session_id, role), share.clone())
            .expect("random_mutual_scalar is below the mutual capacity");
        let mut nonce = [0u8; 32];
        rng.fill_bytes(&mut nonce);
        let ecdh = Zeroizing::new(SecpScalar::random(&mut *rng));
        let ecdh_pub = ferry_dleq::secp_bytes(&(SecpPoint::GENERATOR * *ecdh));
        EvmKeys {
            share: Secret32::new(share.to_repr()),
            ecdh: Secret32::new(ecdh.to_repr().into()),
            setup: EvmSetup {
                role,
                pallas_pub: ferry_dleq::pallas_bytes(&proven.pallas_pub),
                secp_pub: ferry_dleq::secp_bytes(&proven.secp_pub),
                dleq_proof: proven.proof,
                nonce,
                ecdh: ecdh_pub,
                evm_address,
            },
        }
    }

    pub fn role(&self) -> Role {
        self.setup.role
    }

    /// The Zcash share as a Pallas scalar.
    pub fn share(&self) -> Zeroizing<PallasScalar> {
        Zeroizing::new(
            ferry_dleq::pallas_scalar_from_bytes(self.share.expose())
                .expect("valid share encoding"),
        )
    }

    /// The same share as a big-endian secp256k1 scalar: what a claim or refund publishes.
    pub fn share_secp_bytes(&self) -> Zeroizing<[u8; 32]> {
        let s = ferry_dleq::to_secp_scalar(&self.share()).expect("share is below 2^254");
        Zeroizing::new(s.to_repr().into())
    }

    pub fn pallas_pub(&self) -> PallasPoint {
        ferry_dleq::pallas_from_bytes(&self.setup.pallas_pub).expect("own point")
    }

    /// `H(e·E_peer)`: the ECDH secret shared with the peer.
    pub fn ecdh_shared(&self, peer: &EvmSetup) -> Option<[u8; 32]> {
        let e: Option<SecpScalar> = SecpScalar::from_repr((*self.ecdh.expose()).into()).into();
        let theirs = ferry_dleq::secp_from_bytes(&peer.ecdh)?;
        let point = Zeroizing::new(ferry_dleq::secp_bytes(&(theirs * e?)));
        Some(
            Sha256::new()
                .chain_update(b"ferry/v1/ecdh")
                .chain_update(&point[..])
                .finalize()
                .into(),
        )
    }
}

/// The counterparty's verified setup, decoded.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "EvmSetup", into = "EvmSetup")]
pub struct EvmPeer {
    pub setup: EvmSetup,
    pub pallas_pub: PallasPoint,
}

impl EvmPeer {
    /// Verify the DLEQ proof (bound to `session_id` and the expected role) and decode.
    pub fn verify<R: RngCore + CryptoRng>(
        rng: &mut R,
        session_id: &[u8; 32],
        expected_role: Role,
        setup: EvmSetup,
    ) -> Result<Self, Error> {
        let role = setup.role;
        if role != expected_role {
            return Err(Error::InvalidSetup {
                role,
                reason: "role",
            });
        }
        let peer = EvmPeer::try_from(setup)?;
        let secp =
            ferry_dleq::secp_from_bytes(&peer.setup.secp_pub).ok_or(Error::InvalidSetup {
                role,
                reason: "secp point",
            })?;
        ferry_dleq::verify_for(
            rng,
            &dleq_context(session_id, role),
            &peer.setup.dleq_proof,
            &peer.pallas_pub,
            &secp,
        )
        .map_err(|e| Error::Dleq(role, e))?;
        Ok(peer)
    }
}

impl TryFrom<EvmSetup> for EvmPeer {
    type Error = Error;
    /// Decode without checking the proof (for state already verified and persisted).
    fn try_from(setup: EvmSetup) -> Result<Self, Error> {
        let role = setup.role;
        let bad = |reason| Error::InvalidSetup { role, reason };
        let pallas_pub =
            ferry_dleq::pallas_from_bytes(&setup.pallas_pub).ok_or(bad("pallas point"))?;
        if ferry_dleq::secp_from_bytes(&setup.secp_pub).is_none() {
            return Err(bad("secp point"));
        }
        if ferry_dleq::secp_from_bytes(&setup.ecdh).is_none() {
            return Err(bad("ECDH key"));
        }
        if setup.evm_address == [0; 20] {
            return Err(bad("zero EVM address"));
        }
        Ok(EvmPeer { setup, pallas_pub })
    }
}

impl From<EvmPeer> for EvmSetup {
    fn from(p: EvmPeer) -> Self {
        p.setup
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    #[test]
    fn peer_verification_binds_session_and_role() {
        let sid = [1u8; 32];
        let k = EvmKeys::generate(&mut OsRng, &sid, Role::Z, [9; 20]);
        EvmPeer::verify(&mut OsRng, &sid, Role::Z, k.setup.clone()).unwrap();
        assert!(EvmPeer::verify(&mut OsRng, &[2u8; 32], Role::Z, k.setup.clone()).is_err());
        assert!(EvmPeer::verify(&mut OsRng, &sid, Role::B, k.setup.clone()).is_err());
        let mut zero = k.setup.clone();
        zero.evm_address = [0; 20];
        assert!(EvmPeer::verify(&mut OsRng, &sid, Role::Z, zero).is_err());
    }

    #[test]
    fn shares_and_ecdh() {
        let sid = [3u8; 32];
        let z = EvmKeys::generate(&mut OsRng, &sid, Role::Z, [1; 20]);
        let b = EvmKeys::generate(&mut OsRng, &sid, Role::B, [2; 20]);
        assert_eq!(z.ecdh_shared(&b.setup), b.ecdh_shared(&z.setup));
        assert!(z.ecdh_shared(&b.setup).is_some());
        assert_eq!(ferry_dleq::spend_auth_g() * *z.share(), z.pallas_pub());
        // The published secp point's address is what the share proves on chain.
        assert_eq!(
            ferry_evm::scalar_address(&z.share_secp_bytes()),
            Some(ferry_evm::point_address_sec1(&z.setup.secp_pub).unwrap())
        );
    }
}
