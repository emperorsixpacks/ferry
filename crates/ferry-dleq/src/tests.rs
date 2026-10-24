use super::*;
use ff::Field;
use rand_core::OsRng;

const CTX: &[u8] = b"swap-0001/Z";

fn fresh() -> (Zeroizing<PallasScalar>, Proven) {
    let x = random_mutual_scalar(&mut OsRng);
    let p = prove(&mut OsRng, CTX, x.clone()).unwrap();
    (x, p)
}

#[test]
fn capacity_is_254_bits() {
    assert_eq!(PallasScalar::CAPACITY, 254);
    assert_eq!(SecpScalar::CAPACITY, 255);
    assert_eq!(mutual_capacity(), 254);
}

#[test]
fn prove_verify_roundtrip_binds_expected_keys() {
    let (x, p) = fresh();
    assert_eq!(p.pallas_pub, spend_auth_g() * *x);
    assert_eq!(
        p.secp_pub,
        SecpPoint::GENERATOR * to_secp_scalar(&x).unwrap()
    );
    let (kp, ks) = verify(&mut OsRng, CTX, &p.proof).unwrap();
    assert_eq!((kp, ks), (p.pallas_pub, p.secp_pub));
    verify_for(&mut OsRng, CTX, &p.proof, &p.pallas_pub, &p.secp_pub).unwrap();
}

#[test]
fn pallas_key_matches_zcash_redpallas_spendauth() {
    // reddsa 0.6.1 (pasta_curves 0.6.1) is what orchard 0.16 uses for SpendAuthSig.
    use reddsa::{orchard::SpendAuth, SigningKey, VerificationKey};
    let (x, p) = fresh();
    let sk = SigningKey::<SpendAuth>::from_bytes(&x.to_repr()).unwrap();
    let vk: [u8; 32] = VerificationKey::from(&sk).into();
    assert_eq!(vk, pallas_bytes(&p.pallas_pub));
}

#[test]
fn different_scalars_rejected_by_key_check() {
    let (_, p) = fresh();
    let y = random_mutual_scalar(&mut OsRng);
    let other_secp = SecpPoint::GENERATOR * to_secp_scalar(&y).unwrap();
    let other_pallas = spend_auth_g() * *y;
    assert_eq!(
        verify_for(&mut OsRng, CTX, &p.proof, &p.pallas_pub, &other_secp),
        Err(VerifyError::KeyMismatch)
    );
    assert_eq!(
        verify_for(&mut OsRng, CTX, &p.proof, &other_pallas, &p.secp_pub),
        Err(VerifyError::KeyMismatch)
    );
}

// Layout of the first bit-pair record: Pallas commitment (32B) || secp commitment (33B) || ...
const PALLAS_COMMIT: core::ops::Range<usize> = 0..32;
const SECP_COMMIT: core::ops::Range<usize> = 32..65;

#[test]
fn spliced_commitment_from_different_scalar_rejected() {
    // Mixes x's Pallas commitment with y's secp commitment for bits 0-1: i.e. the proof now
    // claims keys whose discrete logs differ. Must fail.
    let (_, px) = fresh();
    let (_, py) = fresh();
    let mut forged = px.proof.clone();
    forged[SECP_COMMIT].copy_from_slice(&py.proof[SECP_COMMIT]);
    assert!(matches!(
        verify(&mut OsRng, CTX, &forged),
        Err(VerifyError::Dleq(_))
    ));

    let mut forged = px.proof.clone();
    forged[PALLAS_COMMIT].copy_from_slice(&py.proof[PALLAS_COMMIT]);
    assert!(matches!(
        verify(&mut OsRng, CTX, &forged),
        Err(VerifyError::Dleq(_))
    ));
}

#[test]
fn wrong_context_rejected() {
    let (_, p) = fresh();
    assert!(matches!(
        verify(&mut OsRng, b"swap-0002/Z", &p.proof),
        Err(VerifyError::Dleq(_))
    ));
}

#[test]
fn tampered_or_truncated_proofs_rejected_without_panic() {
    let (_, p) = fresh();
    for i in (0..p.proof.len()).step_by(p.proof.len() / 24) {
        let mut t = p.proof.clone();
        t[i] ^= 0x01;
        assert!(
            verify(&mut OsRng, CTX, &t).is_err(),
            "byte {i} flip accepted"
        );
    }
    assert_eq!(
        verify(&mut OsRng, CTX, &p.proof[..p.proof.len() - 1]),
        Err(VerifyError::Malformed)
    );
    let mut long = p.proof.clone();
    long.push(0);
    assert_eq!(
        verify(&mut OsRng, CTX, &long),
        Err(VerifyError::TrailingBytes)
    );
}

#[test]
fn scalar_above_capacity_refused() {
    // 2^254 is a valid Pallas scalar but exceeds the mutual capacity.
    let two_254 = PallasScalar::from(2).pow_vartime([254]);
    assert!(to_secp_scalar(&two_254).is_none());
    assert!(prove(&mut OsRng, CTX, Zeroizing::new(two_254)).is_none());
    // -1 (= q - 1) likewise.
    assert!(prove(&mut OsRng, CTX, Zeroizing::new(-PallasScalar::ONE)).is_none());
}

#[test]
fn scalar_conversion_roundtrips() {
    for _ in 0..32 {
        let x = random_mutual_scalar(&mut OsRng);
        let s = to_secp_scalar(&x).unwrap();
        assert_eq!(from_secp_scalar(&s).unwrap(), *x);
    }
    assert!(from_secp_scalar(&-SecpScalar::ONE).is_none());
}

#[test]
fn encodings_roundtrip() {
    let (_, p) = fresh();
    assert_eq!(
        pallas_from_bytes(&pallas_bytes(&p.pallas_pub)),
        Some(p.pallas_pub)
    );
    assert_eq!(secp_from_bytes(&secp_bytes(&p.secp_pub)), Some(p.secp_pub));
}
