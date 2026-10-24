//! Ferry spike S1: cross-group DLEQ between Pallas (Orchard SpendAuthG) and secp256k1.
//!
//! Proves that one secret scalar `x` satisfies both
//!   X_p = x * SpendAuthG   (Pallas, Orchard spend-authorization basepoint)
//!   X_s = x * G            (secp256k1, Bitcoin adaptor point)
//! using Serai's `dleq` crate (MRL-0010 bitwise ring-signature construction,
//! `CompromiseLinear` variant: 2 bits per ring, batch-verifiable).

use dleq::cross_group::{scalar::mutual_scalar_from_bytes, CompromiseLinearDLEq, Generators};
use ff::PrimeField;
use group::{Group, GroupEncoding};
use k256::elliptic_curve::hash2curve::{ExpandMsgXmd, GroupDigest};
use pasta_curves::arithmetic::{CurveAffine, CurveExt};
use pasta_curves::pallas;
use rand_core::{CryptoRng, RngCore};
use transcript::{RecommendedTranscript, Transcript};
use zeroize::Zeroizing;

pub use dleq::cross_group::DLEqError;
use flexible_transcript as transcript;

pub type PallasPoint = pallas::Point;
pub type PallasScalar = pallas::Scalar;
pub type SecpPoint = k256::ProjectivePoint;
pub type SecpScalar = k256::Scalar;

/// G0 = Pallas, G1 = secp256k1.
pub type FerryDleq = CompromiseLinearDLEq<PallasPoint, SecpPoint>;

const DOMAIN: &str = "ferry:dleq:v1";

/// Orchard SpendAuthG affine coordinates (LE field encodings), orchard 0.16
/// `constants/fixed_bases/spend_auth_g.rs`.
const SPEND_AUTH_G_X: [u8; 32] = [
    99, 201, 117, 184, 132, 114, 26, 141, 12, 161, 112, 123, 227, 12, 127, 12, 95, 68, 95, 62,
    124, 24, 141, 59, 6, 214, 241, 40, 179, 35, 85, 55,
];
const SPEND_AUTH_G_Y: [u8; 32] = [
    201, 59, 12, 123, 129, 62, 227, 76, 216, 189, 5, 192, 254, 20, 201, 223, 251, 36, 214, 254,
    252, 188, 16, 123, 219, 102, 26, 223, 127, 53, 208, 26,
];

/// Orchard's SpendAuthG, built from the published coordinates and checked against
/// its definition `GroupHash^P("z.cash:Orchard", "G")`.
pub fn spend_auth_g() -> PallasPoint {
    let x = pallas::Base::from_repr(SPEND_AUTH_G_X).unwrap();
    let y = pallas::Base::from_repr(SPEND_AUTH_G_Y).unwrap();
    let g: PallasPoint = pallas::Affine::from_xy(x, y).unwrap().into();
    assert_eq!(g, PallasPoint::hash_to_curve("z.cash:Orchard")(b"G"));
    g
}

/// Generator pairs. Primary generators are the ones the keys live under; the alt
/// (blinding) generators are nothing-up-my-sleeve hash-to-curve outputs.
pub fn generators() -> (Generators<PallasPoint>, Generators<SecpPoint>) {
    let pallas_alt = PallasPoint::hash_to_curve(DOMAIN)(b"pallas-alt-generator");
    let secp_alt = k256::Secp256k1::hash_from_bytes::<ExpandMsgXmd<sha2::Sha256>>(
        &[b"secp256k1-alt-generator"],
        &[b"ferry:dleq:v1:secp256k1_XMD:SHA-256_SSWU_RO_"],
    )
    .unwrap();
    assert!(!bool::from(pallas_alt.is_identity()) && !bool::from(secp_alt.is_identity()));
    (
        Generators::new(spend_auth_g(), pallas_alt).unwrap(),
        Generators::new(SecpPoint::GENERATOR, secp_alt).unwrap(),
    )
}

/// Transcript bound to a swap context (swap id, role, etc.).
pub fn transcript(context: &[u8]) -> RecommendedTranscript {
    let mut t = RecommendedTranscript::new(b"Ferry Pallas-secp256k1 DLEq");
    t.append_message(b"context", context);
    t
}

/// Bit capacity a shared secret may use: min(CAPACITY) = 254 (Pallas Fq), secp is 255.
pub fn mutual_capacity() -> u32 {
    PallasScalar::CAPACITY.min(SecpScalar::CAPACITY)
}

/// Uniform secret < 2^254, valid in both scalar fields. Usable directly as an Orchard
/// `ask` share (it is an ordinary Pallas scalar).
pub fn random_mutual_scalar<R: RngCore + CryptoRng>(rng: &mut R) -> Zeroizing<PallasScalar> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    rng.fill_bytes(bytes.as_mut());
    Zeroizing::new(mutual_scalar_from_bytes::<PallasScalar, SecpScalar>(bytes.as_ref()).0)
}

/// Same integer, mapped into the secp256k1 scalar field. None if x >= 2^254.
pub fn to_secp_scalar(x: &PallasScalar) -> Option<SecpScalar> {
    dleq::cross_group::scalar::scalar_convert::<PallasScalar, SecpScalar>(*x)
}

pub struct Proven {
    pub proof: Vec<u8>,
    pub pallas_pub: PallasPoint,
    pub secp_pub: SecpPoint,
}

/// Prove X_p = x*SpendAuthG and X_s = x*G for the same x. Returns None if x isn't < 2^254.
pub fn prove<R: RngCore + CryptoRng>(
    rng: &mut R,
    context: &[u8],
    x: Zeroizing<PallasScalar>,
) -> Option<Proven> {
    let gens = generators();
    let (proof, keys) =
        FerryDleq::prove_without_bias(rng, &mut transcript(context), gens, x)?;
    let mut buf = Vec::new();
    proof.write(&mut buf).unwrap();
    Some(Proven {
        proof: buf,
        pallas_pub: gens.0.primary * *keys.0,
        secp_pub: gens.1.primary * *keys.1,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    Malformed,
    Dleq(DLEqError),
    TrailingBytes,
    /// Proof is valid but for different public keys than expected.
    KeyMismatch,
}

/// Verify a serialized proof and return the (Pallas, secp256k1) public keys it binds.
pub fn verify<R: RngCore + CryptoRng>(
    rng: &mut R,
    context: &[u8],
    proof: &[u8],
) -> Result<(PallasPoint, SecpPoint), VerifyError> {
    let mut r = proof;
    let parsed = FerryDleq::read(&mut r).map_err(|_| VerifyError::Malformed)?;
    if !r.is_empty() {
        return Err(VerifyError::TrailingBytes);
    }
    parsed.verify(rng, &mut transcript(context), generators()).map_err(VerifyError::Dleq)
}

/// Verify and check the proof binds exactly the expected public keys.
pub fn verify_for<R: RngCore + CryptoRng>(
    rng: &mut R,
    context: &[u8],
    proof: &[u8],
    pallas_pub: &PallasPoint,
    secp_pub: &SecpPoint,
) -> Result<(), VerifyError> {
    let (p, s) = verify(rng, context, proof)?;
    if p == *pallas_pub && s == *secp_pub {
        Ok(())
    } else {
        Err(VerifyError::KeyMismatch)
    }
}

pub fn pallas_bytes(p: &PallasPoint) -> [u8; 32] {
    p.to_bytes()
}

pub fn secp_bytes(p: &SecpPoint) -> Vec<u8> {
    p.to_bytes().to_vec()
}

#[cfg(test)]
mod tests;
