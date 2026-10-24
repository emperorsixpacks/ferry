//! BIP340 signatures and adaptor signatures (schnorr_fun) over Taproot sighashes.
//!
//! Secrets cross the API as 32-byte big-endian scalars and encryption points as SEC1
//! compressed bytes, which is exactly what `k256` (and hence `ferry-dleq`) uses.
//! Encryption points are full points: the y parity matters. If `T = y·G` has odd y,
//! schnorr_fun records `needs_negation` in the encrypted signature and both decryption
//! and recovery account for it, so recovery yields `y` itself, never `-y`.

use bitcoin::key::XOnlyPublicKey;
use schnorr_fun::adaptor::{Adaptor, EncryptedSign};
use schnorr_fun::fun::marker::{EvenY, NonZero, Normal, Public, Secret, Zero};
use schnorr_fun::fun::{KeyPair, Point, Scalar};
use schnorr_fun::{nonce, Message, Schnorr};
use sha2::Sha256;
use zeroize::Zeroizing;

pub use schnorr_fun::adaptor::EncryptedSignature;
pub use schnorr_fun::Signature;

type Sch = Schnorr<Sha256, nonce::Synthetic<Sha256, nonce::GlobalRng<rand::rngs::ThreadRng>>>;

fn schnorr() -> Sch {
    schnorr_fun::new_with_synthetic_nonces::<Sha256, rand::rngs::ThreadRng>()
}

fn scalar_from_be(bytes: &[u8; 32]) -> Option<Scalar<Secret, NonZero>> {
    Scalar::<Secret, Zero>::from_bytes(*bytes)?.non_zero()
}

/// A party's BTC signing key (x-only, even-y normalized as BIP340 requires).
#[derive(Clone)]
pub struct BtcKey(KeyPair<EvenY>);

impl BtcKey {
    pub fn random() -> Self {
        BtcKey(KeyPair::new_xonly(Scalar::random(&mut rand::thread_rng())))
    }

    /// From a 32-byte big-endian secret. None for zero or out-of-range values.
    pub fn from_secret_bytes(bytes: &[u8; 32]) -> Option<Self> {
        Some(BtcKey(KeyPair::new_xonly(scalar_from_be(bytes)?)))
    }

    /// The (even-y normalized) secret; [`BtcKey::from_secret_bytes`] rebuilds the same key.
    pub fn secret_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.0.secret_key().to_bytes())
    }

    pub fn xonly(&self) -> XOnlyPublicKey {
        XOnlyPublicKey::from_slice(&self.0.public_key().to_xonly_bytes())
            .expect("schnorr_fun keys are valid x-only keys")
    }

    pub fn sign(&self, sighash: &[u8; 32]) -> Signature {
        schnorr().sign(&self.0, Message::raw(sighash))
    }

    /// Adaptor signature that becomes a valid signature once decrypted with `dlog(t)`.
    pub fn encrypted_sign(&self, t: &EncryptionKey, sighash: &[u8; 32]) -> EncryptedSignature {
        schnorr().encrypted_sign(&self.0, &t.0, Message::raw(sighash))
    }
}

/// Adaptor encryption point `T = y·G` (full point, parity preserved).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncryptionKey(Point<Normal, Public, NonZero>);

impl EncryptionKey {
    pub fn from_sec1(bytes: &[u8; 33]) -> Option<Self> {
        Point::from_bytes(*bytes).map(EncryptionKey)
    }

    pub fn to_sec1(&self) -> [u8; 33] {
        self.0.to_bytes()
    }

    /// `y·G` for a 32-byte big-endian secret `y`.
    pub fn from_secret(y: &[u8; 32]) -> Option<Self> {
        let y = scalar_from_be(y)?;
        Some(EncryptionKey(schnorr().encryption_key_for(&y)))
    }
}

fn even_point(pk: &XOnlyPublicKey) -> Option<Point<EvenY>> {
    Point::from_xonly_bytes(pk.serialize())
}

/// Plain BIP340 verification.
pub fn verify(pk: &XOnlyPublicKey, sighash: &[u8; 32], sig: &Signature) -> bool {
    even_point(pk).is_some_and(|p| schnorr().verify(&p, Message::raw(sighash), sig))
}

/// Independent check with libsecp256k1, the verifier bitcoind uses.
pub fn verify_libsecp(pk: &XOnlyPublicKey, sighash: &[u8; 32], sig: &Signature) -> bool {
    let secp = bitcoin::secp256k1::Secp256k1::verification_only();
    let Ok(s) = bitcoin::secp256k1::schnorr::Signature::from_slice(&sig.to_bytes()) else {
        return false;
    };
    let m = bitcoin::secp256k1::Message::from_digest(*sighash);
    secp.verify_schnorr(&s, &m, pk).is_ok()
}

pub fn verify_encrypted(
    pk: &XOnlyPublicKey,
    t: &EncryptionKey,
    sighash: &[u8; 32],
    enc: &EncryptedSignature,
) -> bool {
    even_point(pk)
        .is_some_and(|p| schnorr().verify_encrypted_signature(&p, &t.0, Message::raw(sighash), enc))
}

/// Complete an adaptor signature with the decryption key `y` (32-byte big-endian).
pub fn decrypt(y: &[u8; 32], enc: &EncryptedSignature) -> Option<Signature> {
    let y = scalar_from_be(y)?;
    Some(schnorr().decrypt_signature(y, enc.clone()))
}

/// Recover `y` (32-byte big-endian) from an adaptor signature and its published completion.
/// Checks `y·G == t`, so a wrong signature yields None.
pub fn recover(
    t: &EncryptionKey,
    enc: &EncryptedSignature,
    sig: &Signature,
) -> Option<Zeroizing<[u8; 32]>> {
    schnorr()
        .recover_decryption_key(&t.0, enc, sig)
        .map(|y| Zeroizing::new(y.to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_dleq::k256::elliptic_curve::PrimeField;
    use rand_core::OsRng;

    /// A share generated for the DLEQ, its proven secp point used as the adaptor point, and
    /// recovery from the completed signature: the recovered integer must be the exact share.
    #[test]
    fn recovers_exact_pallas_share_through_dleq_point() {
        let signer = BtcKey::random();
        let sighash = [7u8; 32];
        let (mut even, mut odd) = (0, 0);
        for i in 0..24 {
            let share = ferry_dleq::random_mutual_scalar(&mut OsRng);
            let y_secp = ferry_dleq::to_secp_scalar(&share).unwrap();
            let secp_pub = ferry_dleq::SecpPoint::GENERATOR * y_secp;
            if i == 0 {
                let proven = ferry_dleq::prove(&mut OsRng, b"test", share.clone()).unwrap();
                assert_eq!(proven.secp_pub, secp_pub);
            }
            let sec1 = ferry_dleq::secp_bytes(&secp_pub);
            if sec1[0] == 0x02 {
                even += 1
            } else {
                odd += 1
            }

            let t = EncryptionKey::from_sec1(&sec1).unwrap();
            let enc = signer.encrypted_sign(&t, &sighash);
            assert!(
                verify_encrypted(&signer.xonly(), &t, &sighash, &enc),
                "run {i}"
            );

            let y: [u8; 32] = y_secp.to_repr().into();
            assert_eq!(EncryptionKey::from_secret(&y), Some(t));
            let sig = decrypt(&y, &enc).unwrap();
            assert!(verify(&signer.xonly(), &sighash, &sig));
            assert!(verify_libsecp(&signer.xonly(), &sighash, &sig));

            let rec = recover(&t, &enc, &sig).unwrap();
            let rec = ferry_dleq::SecpScalar::from_repr((*rec).into()).unwrap();
            let rec = ferry_dleq::from_secp_scalar(&rec).unwrap();
            assert_eq!(rec.to_repr(), share.to_repr(), "run {i}");
        }
        assert!(
            even > 0 && odd > 0,
            "both parities exercised ({even} even, {odd} odd)"
        );
    }

    #[test]
    fn recover_rejects_unrelated_signature() {
        let signer = BtcKey::random();
        let sighash = [1u8; 32];
        let t = EncryptionKey::from_secret(&[3u8; 32]).unwrap();
        let enc = signer.encrypted_sign(&t, &sighash);
        let other = signer.sign(&sighash);
        assert!(recover(&t, &enc, &other).is_none());
    }

    #[test]
    fn key_roundtrips_through_secret_bytes() {
        let k = BtcKey::random();
        let k2 = BtcKey::from_secret_bytes(&k.secret_bytes()).unwrap();
        assert_eq!(k.xonly(), k2.xonly());
    }
}
