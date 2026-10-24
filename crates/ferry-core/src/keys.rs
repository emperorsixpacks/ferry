//! Per-party key material: a Zcash spend-authority share (valid on both curves) with its
//! DLEQ proof, a BTC signing key and a nonce for the joint viewing key.

use ferry_btc::bitcoin::address::NetworkUnchecked;
use ferry_btc::bitcoin::key::XOnlyPublicKey;
use ferry_btc::bitcoin::{Address, Network};
use ferry_btc::{BtcKey, EncryptionKey};
use ferry_dleq::k256::elliptic_curve::PrimeField;
use ferry_dleq::{PallasPoint, PallasScalar};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{Error, Role, Secret32};

/// DLEQ transcript context: binds a proof to one session and one role.
pub fn dleq_context(session_id: &[u8; 32], role: Role) -> Vec<u8> {
    let mut ctx = b"ferry/v1/dleq/".to_vec();
    ctx.extend_from_slice(session_id);
    ctx.push(b'/');
    ctx.extend_from_slice(role.as_str().as_bytes());
    ctx
}

/// Public setup data a party sends in `Propose` / `Accept`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setup {
    pub role: Role,
    /// BIP340 x-only BTC key.
    #[serde(with = "crate::hex_serde")]
    pub btc_key: [u8; 32],
    /// `x·SpendAuthG` (Pallas encoding).
    #[serde(with = "crate::hex_serde")]
    pub pallas_pub: [u8; 32],
    /// `x·G` (secp256k1, SEC1 compressed): the adaptor encryption point.
    #[serde(with = "crate::hex_serde")]
    pub secp_pub: [u8; 33],
    #[serde(with = "crate::hex_serde")]
    pub dleq_proof: Vec<u8>,
    /// Contribution to the joint `nk` / `rivk`.
    #[serde(with = "crate::hex_serde")]
    pub nonce: [u8; 32],
    /// Z: where tx_redeem and tx_punish pay. B: where tx_refund pays.
    pub btc_address: Address<NetworkUnchecked>,
}

/// Our own secrets plus the setup we published.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalKeys {
    /// Zcash share as a Pallas scalar (canonical LE encoding), < 2^254.
    share: Secret32,
    /// BTC signing key (big-endian).
    btc: Secret32,
    pub setup: Setup,
}

impl LocalKeys {
    pub fn generate<R: RngCore + CryptoRng>(
        rng: &mut R,
        session_id: &[u8; 32],
        role: Role,
        btc_address: Address,
    ) -> Self {
        let share = ferry_dleq::random_mutual_scalar(rng);
        let proven = ferry_dleq::prove(rng, &dleq_context(session_id, role), share.clone())
            .expect("random_mutual_scalar is below the mutual capacity");
        let btc = BtcKey::random();
        let mut nonce = [0u8; 32];
        rng.fill_bytes(&mut nonce);
        LocalKeys {
            share: Secret32::new(share.to_repr()),
            btc: Secret32::new(*btc.secret_bytes()),
            setup: Setup {
                role,
                btc_key: btc.xonly().serialize(),
                pallas_pub: ferry_dleq::pallas_bytes(&proven.pallas_pub),
                secp_pub: ferry_dleq::secp_bytes(&proven.secp_pub),
                dleq_proof: proven.proof,
                nonce,
                btc_address: btc_address.into_unchecked(),
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

    /// The same share as a big-endian secp256k1 scalar: the adaptor decryption key.
    pub fn share_secp_bytes(&self) -> Zeroizing<[u8; 32]> {
        let s = ferry_dleq::to_secp_scalar(&self.share()).expect("share is below 2^254");
        Zeroizing::new(s.to_repr().into())
    }

    pub fn btc_key(&self) -> BtcKey {
        BtcKey::from_secret_bytes(self.btc.expose()).expect("valid BTC key")
    }

    pub fn pallas_pub(&self) -> PallasPoint {
        ferry_dleq::pallas_from_bytes(&self.setup.pallas_pub).expect("own point")
    }

    pub fn encryption_key(&self) -> EncryptionKey {
        EncryptionKey::from_sec1(&self.setup.secp_pub).expect("own point")
    }
}

/// The counterparty's verified setup, decoded.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "PeerRepr", into = "PeerRepr")]
pub struct Peer {
    pub setup: Setup,
    pub network: Network,
    pub pallas_pub: PallasPoint,
    pub encryption_key: EncryptionKey,
    pub btc_key: XOnlyPublicKey,
    pub btc_address: Address,
}

impl Peer {
    /// Verify the DLEQ proof (bound to `session_id` and the expected role) and decode.
    pub fn verify<R: RngCore + CryptoRng>(
        rng: &mut R,
        session_id: &[u8; 32],
        expected_role: Role,
        network: Network,
        setup: Setup,
    ) -> Result<Self, Error> {
        let role = setup.role;
        if role != expected_role {
            return Err(Error::InvalidSetup {
                role,
                reason: "role",
            });
        }
        let peer = Peer::decode(setup, network)?;
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

    /// Decode without checking the proof (for state already verified and persisted).
    fn decode(setup: Setup, network: Network) -> Result<Self, Error> {
        let role = setup.role;
        let bad = |reason| Error::InvalidSetup { role, reason };
        let pallas_pub =
            ferry_dleq::pallas_from_bytes(&setup.pallas_pub).ok_or(bad("pallas point"))?;
        let encryption_key = EncryptionKey::from_sec1(&setup.secp_pub).ok_or(bad("secp point"))?;
        let btc_key = XOnlyPublicKey::from_slice(&setup.btc_key).map_err(|_| bad("btc key"))?;
        let btc_address = setup
            .btc_address
            .clone()
            .require_network(network)
            .map_err(|_| bad("btc address network"))?;
        Ok(Peer {
            setup,
            network,
            pallas_pub,
            encryption_key,
            btc_key,
            btc_address,
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct PeerRepr {
    setup: Setup,
    network: Network,
}

impl From<Peer> for PeerRepr {
    fn from(p: Peer) -> Self {
        PeerRepr {
            setup: p.setup,
            network: p.network,
        }
    }
}

impl TryFrom<PeerRepr> for Peer {
    type Error = Error;
    fn try_from(r: PeerRepr) -> Result<Self, Error> {
        Peer::decode(r.setup, r.network)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    fn addr() -> Address {
        let secp = ferry_btc::bitcoin::key::Secp256k1::new();
        Address::p2tr(&secp, BtcKey::random().xonly(), None, Network::Regtest)
    }

    #[test]
    fn peer_verification_binds_session_and_role() {
        let sid = [1u8; 32];
        let k = LocalKeys::generate(&mut OsRng, &sid, Role::Z, addr());
        Peer::verify(&mut OsRng, &sid, Role::Z, Network::Regtest, k.setup.clone()).unwrap();
        assert!(Peer::verify(
            &mut OsRng,
            &[2u8; 32],
            Role::Z,
            Network::Regtest,
            k.setup.clone()
        )
        .is_err());
        assert!(
            Peer::verify(&mut OsRng, &sid, Role::B, Network::Regtest, k.setup.clone()).is_err()
        );
        let mut relabeled = k.setup.clone();
        relabeled.role = Role::B;
        assert!(matches!(
            Peer::verify(&mut OsRng, &sid, Role::B, Network::Regtest, relabeled),
            Err(Error::Dleq(..))
        ));
        assert!(
            Peer::verify(&mut OsRng, &sid, Role::Z, Network::Bitcoin, k.setup.clone()).is_err()
        );
    }

    #[test]
    fn local_keys_are_consistent() {
        let k = LocalKeys::generate(&mut OsRng, &[0u8; 32], Role::B, addr());
        assert_eq!(ferry_dleq::spend_auth_g() * *k.share(), k.pallas_pub());
        assert_eq!(
            EncryptionKey::from_secret(&k.share_secp_bytes()),
            Some(k.encryption_key())
        );
        assert_eq!(k.btc_key().xonly().serialize(), k.setup.btc_key);
    }
}
