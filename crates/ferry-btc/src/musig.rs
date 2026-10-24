//! MuSig2 (BIP327, schnorr_fun) key-path redeem of the lock output.
//!
//! The lock output's internal key is `KeyAgg(kb, kz)`, tweaked as BIP341 requires. tx_redeem is
//! signed as a MuSig2 *adaptor* signature under `Z_s`: the session nonce includes `Z_s`, the two
//! partial signatures combine into an [`EncryptedSignature`] that only `z` completes, and the
//! completed signature on chain gives `z` back to anyone holding the encrypted one. On chain it
//! is a single 64-byte BIP340 signature: a key-path spend like any single-key wallet's.
//!
//! Each party uses one fresh nonce pair, for this one message, with the peer's nonce fixed by the
//! session transcript before anyone signs, so a nonce is never used in two sessions.

use bitcoin::hashes::Hash;
use bitcoin::key::XOnlyPublicKey;
use bitcoin::taproot::TapTweakHash;
use schnorr_fun::binonce::{Nonce, NonceKeyPair, SecretNonce};
use schnorr_fun::fun::marker::{EvenY, Public, Zero};
use schnorr_fun::fun::{KeyPair, Point, Scalar};
use schnorr_fun::musig::{self, AggKey, MuSig, SignSession};
use schnorr_fun::{nonce::NoNonces, Message};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::adaptor::{EncryptedSignature, EncryptionKey};
use crate::scripts::SwapScripts;
use crate::{BtcKey, Role};

/// Public MuSig2 nonce (two compressed points).
pub type PubNonce = [u8; 66];
/// Partial signature scalar (big-endian).
pub type PartialSig = [u8; 32];

fn musig() -> MuSig<Sha256, NoNonces> {
    musig::new_without_nonce_generation::<Sha256>()
}

fn lift(pk: &XOnlyPublicKey) -> Point {
    Point::<EvenY>::from_xonly_bytes(pk.serialize())
        .expect("valid x-only key")
        .normalize()
}

/// Key order is fixed: B then Z.
fn index(role: Role) -> usize {
    match role {
        Role::B => 0,
        Role::Z => 1,
    }
}

/// The untweaked x-only aggregate `KeyAgg(kb, kz)`: the lock output's internal key.
pub fn internal_key(kb: &XOnlyPublicKey, kz: &XOnlyPublicKey) -> XOnlyPublicKey {
    let agg = musig()
        .new_agg_key(vec![lift(kb), lift(kz)])
        .into_xonly_key();
    XOnlyPublicKey::from_slice(&agg.agg_public_key().to_xonly_bytes()).expect("valid x-only key")
}

/// A fresh nonce pair: (secret, public). Use it for exactly one signing session.
pub fn new_nonce() -> (Zeroizing<[u8; 64]>, PubNonce) {
    let kp = NonceKeyPair::random(&mut rand::thread_rng());
    (Zeroizing::new(kp.secret.to_bytes()), kp.public.to_bytes())
}

/// Key-path signing context for one swap's lock output.
pub struct KeySpend {
    agg: AggKey<EvenY>,
}

impl KeySpend {
    /// None if the scripts were built without the MuSig2 internal key.
    pub fn new(scripts: &SwapScripts) -> Option<Self> {
        if !scripts.keypath {
            return None;
        }
        let internal = internal_key(&scripts.kb, &scripts.kz);
        let merkle_root = scripts.lock.spend_info.merkle_root();
        let tweak = TapTweakHash::from_key_and_tweak(internal, merkle_root).to_byte_array();
        let tweak = Scalar::<Public, Zero>::from_bytes(tweak)?;
        let agg = musig()
            .new_agg_key(vec![lift(&scripts.kb), lift(&scripts.kz)])
            .into_xonly_key()
            .tweak(tweak)?;
        let ks = KeySpend { agg };
        debug_assert_eq!(
            ks.output_key(),
            scripts.lock.spend_info.output_key().to_x_only_public_key()
        );
        Some(ks)
    }

    /// The tweaked aggregate key, i.e. the lock output's x-only output key.
    pub fn output_key(&self) -> XOnlyPublicKey {
        XOnlyPublicKey::from_slice(&self.agg.agg_public_key().to_xonly_bytes())
            .expect("valid x-only key")
    }

    fn session(
        &self,
        nonces: [&PubNonce; 2],
        t: &EncryptionKey,
        sighash: &[u8; 32],
    ) -> Option<SignSession<musig::Adaptor>> {
        let nonces = nonces
            .iter()
            .map(|n| Nonce::from_bytes(**n))
            .collect::<Option<Vec<_>>>()?;
        musig().start_encrypted_sign_session(&self.agg, nonces, Message::raw(sighash), t.point())
    }

    /// Our partial adaptor signature. `nonces` is `[B's, Z's]`.
    pub fn partial_sign(
        &self,
        key: &BtcKey,
        role: Role,
        secret_nonce: &[u8; 64],
        nonces: [&PubNonce; 2],
        t: &EncryptionKey,
        sighash: &[u8; 32],
    ) -> Option<PartialSig> {
        let session = self.session(nonces, t, sighash)?;
        let secret = SecretNonce::from_bytes(*secret_nonce)?;
        let keypair = KeyPair::new(key.secret_scalar());
        let ours = NonceKeyPair::from_secret(secret);
        if ours.public.to_bytes() != *nonces[index(role)] {
            return None;
        }
        Some(
            musig()
                .sign(&self.agg, &session, index(role), &keypair, ours)
                .to_bytes(),
        )
    }

    pub fn verify_partial(
        &self,
        role: Role,
        partial: &PartialSig,
        nonces: [&PubNonce; 2],
        t: &EncryptionKey,
        sighash: &[u8; 32],
    ) -> bool {
        let (Some(session), Some(s)) = (
            self.session(nonces, t, sighash),
            Scalar::from_bytes(*partial),
        ) else {
            return false;
        };
        musig().verify_partial_signature(&self.agg, &session, index(role), s)
    }

    /// Combine both partials into the adaptor signature under `t` for the output key.
    pub fn combine(
        &self,
        partials: [&PartialSig; 2],
        nonces: [&PubNonce; 2],
        t: &EncryptionKey,
        sighash: &[u8; 32],
    ) -> Option<EncryptedSignature> {
        let session = self.session(nonces, t, sighash)?;
        let partials = partials
            .iter()
            .map(|p| Scalar::from_bytes(**p))
            .collect::<Option<Vec<_>>>()?;
        Some(musig().combine_partial_encrypted_signatures(&self.agg, &session, partials))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adaptor;

    #[test]
    fn key_path_adaptor_signature_reveals_the_encryption_secret() {
        let (b, z) = (BtcKey::random(), BtcKey::random());
        let scripts = SwapScripts::new(b.xonly(), z.xonly(), 10, 20, true);
        let ks = KeySpend::new(&scripts).unwrap();
        assert_eq!(
            ks.output_key(),
            scripts.lock.spend_info.output_key().to_x_only_public_key()
        );
        assert!(KeySpend::new(&SwapScripts::new(b.xonly(), z.xonly(), 10, 20, false)).is_none());

        for i in 0..8u8 {
            let y = [i + 1; 32];
            let t = EncryptionKey::from_secret(&y).unwrap();
            let sighash = [0x42 ^ i; 32];
            let (b_sec, b_pub) = new_nonce();
            let (z_sec, z_pub) = new_nonce();
            let nonces = [&b_pub, &z_pub];

            let s_z = ks
                .partial_sign(&z, Role::Z, &z_sec, nonces, &t, &sighash)
                .unwrap();
            assert!(ks.verify_partial(Role::Z, &s_z, nonces, &t, &sighash));
            assert!(!ks.verify_partial(Role::B, &s_z, nonces, &t, &sighash));
            // A nonce that isn't ours is refused.
            assert!(ks
                .partial_sign(&b, Role::B, &z_sec, nonces, &t, &sighash)
                .is_none());
            let s_b = ks
                .partial_sign(&b, Role::B, &b_sec, nonces, &t, &sighash)
                .unwrap();
            assert!(ks.verify_partial(Role::B, &s_b, nonces, &t, &sighash));

            let enc = ks.combine([&s_b, &s_z], nonces, &t, &sighash).unwrap();
            assert!(adaptor::verify_encrypted(
                &ks.output_key(),
                &t,
                &sighash,
                &enc
            ));
            let sig = adaptor::decrypt(&y, &enc).unwrap();
            assert!(adaptor::verify_libsecp(&ks.output_key(), &sighash, &sig));
            assert_eq!(*adaptor::recover(&t, &enc, &sig).unwrap(), y);
        }
    }
}
