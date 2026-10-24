//! Per-party key material: a Zcash spend-authority share (valid on both curves) with its
//! DLEQ proof, a BTC signing key and a nonce for the joint viewing key.

use ferry_btc::bitcoin::address::NetworkUnchecked;
use ferry_btc::bitcoin::key::XOnlyPublicKey;
use ferry_btc::bitcoin::{Address, Network};
use ferry_btc::{BtcKey, EncryptionKey};
use ferry_dleq::k256::elliptic_curve::{Field, PrimeField};
use ferry_dleq::{PallasPoint, PallasScalar, SecpPoint, SecpScalar};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
    /// Z only, when its user named a payout address for this swap (`payout_to`): where
    /// tx_redeem pays instead of `btc_address`. tx_punish still pays `btc_address`. Left out of
    /// the JSON when unset, so a swap without one serializes, and hashes into the transcript,
    /// exactly as before. A peer that predates the field drops it on reading, its transcript no
    /// longer matches ours, and the swap stops at negotiation, before anything is locked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redeem_address: Option<Address<NetworkUnchecked>>,
    /// Ephemeral secp256k1 ECDH key (SEC1). The shared secret keeps the joint `nk`/`rivk` (and
    /// the peer channel token) out of reach of anyone who only sees the transcript.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::hex_opt"
    )]
    pub ecdh: Option<[u8; 33]>,
}

/// Our own secrets plus the setup we published.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalKeys {
    /// Zcash share as a Pallas scalar (canonical LE encoding), < 2^254.
    share: Secret32,
    /// BTC signing key (big-endian).
    btc: Secret32,
    /// Ephemeral ECDH secret (big-endian secp256k1 scalar).
    #[serde(default)]
    ecdh: Option<Secret32>,
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
        let ecdh = Zeroizing::new(SecpScalar::random(&mut *rng));
        let ecdh_pub = ferry_dleq::secp_bytes(&(SecpPoint::GENERATOR * *ecdh));
        LocalKeys {
            share: Secret32::new(share.to_repr()),
            btc: Secret32::new(*btc.secret_bytes()),
            ecdh: Some(Secret32::new(ecdh.to_repr().into())),
            setup: Setup {
                role,
                btc_key: btc.xonly().serialize(),
                pallas_pub: ferry_dleq::pallas_bytes(&proven.pallas_pub),
                secp_pub: ferry_dleq::secp_bytes(&proven.secp_pub),
                dleq_proof: proven.proof,
                nonce,
                btc_address: btc_address.into_unchecked(),
                redeem_address: None,
                ecdh: Some(ecdh_pub),
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

    /// `H(e·E_peer)`: the ECDH secret shared with the peer (None for a swap that predates it).
    pub fn ecdh_shared(&self, peer: &Setup) -> Option<[u8; 32]> {
        let e: Option<SecpScalar> =
            SecpScalar::from_repr((*self.ecdh.as_ref()?.expose()).into()).into();
        let theirs = ferry_dleq::secp_from_bytes(peer.ecdh.as_ref()?)?;
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
#[serde(try_from = "PeerRepr", into = "PeerRepr")]
pub struct Peer {
    pub setup: Setup,
    pub network: Network,
    pub pallas_pub: PallasPoint,
    pub encryption_key: EncryptionKey,
    pub btc_key: XOnlyPublicKey,
    pub btc_address: Address,
    /// Z's `redeem_address`, if it named one (never B's).
    pub redeem_address: Option<Address>,
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
        if peer
            .setup
            .ecdh
            .and_then(|e| ferry_dleq::secp_from_bytes(&e))
            .is_none()
        {
            return Err(Error::InvalidSetup {
                role,
                reason: "missing or invalid ECDH key",
            });
        }
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
        let redeem_address = match (&setup.redeem_address, role) {
            (None, _) => None,
            (Some(_), Role::B) => return Err(bad("a redeem address, which only Z may name")),
            (Some(a), Role::Z) => Some(
                a.clone()
                    .require_network(network)
                    .map_err(|_| bad("redeem address network"))?,
            ),
        };
        Ok(Peer {
            setup,
            network,
            pallas_pub,
            encryption_key,
            btc_key,
            btc_address,
            redeem_address,
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
    fn ecdh_secret_is_shared_and_required() {
        let sid = [3u8; 32];
        let z = LocalKeys::generate(&mut OsRng, &sid, Role::Z, addr());
        let b = LocalKeys::generate(&mut OsRng, &sid, Role::B, addr());
        let shared = z.ecdh_shared(&b.setup).unwrap();
        assert_eq!(Some(shared), b.ecdh_shared(&z.setup));
        let mut stripped = z.setup.clone();
        stripped.ecdh = None;
        assert!(b.ecdh_shared(&stripped).is_none());
        assert!(matches!(
            Peer::verify(&mut OsRng, &sid, Role::Z, Network::Regtest, stripped),
            Err(Error::InvalidSetup { .. })
        ));
    }

    /// A redeem address is Z's alone, of the swap's network, and absent from the JSON unless
    /// set (so a setup without one hashes into the transcript as before).
    #[test]
    fn redeem_address_belongs_to_z_on_the_swap_network() {
        let sid = [4u8; 32];
        let z = LocalKeys::generate(&mut OsRng, &sid, Role::Z, addr());
        let json = serde_json::to_value(&z.setup).unwrap();
        assert!(json.get("redeem_address").is_none(), "{json}");
        let payout = addr();
        let mut with = z.setup.clone();
        with.redeem_address = Some(payout.as_unchecked().clone());
        let peer = Peer::verify(&mut OsRng, &sid, Role::Z, Network::Regtest, with.clone()).unwrap();
        assert_eq!(peer.redeem_address, Some(payout));
        let back: Setup = serde_json::from_value(serde_json::to_value(&with).unwrap()).unwrap();
        assert_eq!(back, with);

        let secp = ferry_btc::bitcoin::key::Secp256k1::new();
        let mainnet = Address::p2tr(&secp, BtcKey::random().xonly(), None, Network::Bitcoin);
        let mut wrong_net = z.setup.clone();
        wrong_net.redeem_address = Some(mainnet.into_unchecked());
        assert!(matches!(
            Peer::verify(&mut OsRng, &sid, Role::Z, Network::Regtest, wrong_net),
            Err(Error::InvalidSetup {
                reason: "redeem address network",
                ..
            })
        ));

        let b = LocalKeys::generate(&mut OsRng, &sid, Role::B, addr());
        let mut b_with = b.setup.clone();
        b_with.redeem_address = Some(addr().into_unchecked());
        assert!(matches!(
            Peer::verify(&mut OsRng, &sid, Role::B, Network::Regtest, b_with),
            Err(Error::InvalidSetup { role: Role::B, .. })
        ));
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
