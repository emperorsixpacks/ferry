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

// ------------------------------------------------------------------------------------------------
// Regression tests for the cross-group proof itself. Serai calls its cross-group proofs "solely
// experimental" and left them out of its 2023 audit; eigenwallet's (different) cross-curve proof
// had a soundness bug, fixed in July 2026, because its blinding points were the curves' standard
// generators. These pin what keeps Ferry's out of that class, and what a forger can't do.

/// Ferry's blinding (alt) generators: hash-to-curve outputs, as `generators()` derives them.
const PALLAS_ALT: &str = "f2d183f008904b3b6b930cc85cc1a654da2c847044602bc06eaf7d9aa56be5be";
const SECP_ALT: &str = "0236ecaf5858aca56d8a0d93e01091c76089541d7d270eb4fde901efe4a7dd1968";
/// Multiples k of a base checked against a blinding generator, both signs.
const SMALL: u64 = 1 << 12;

/// k in ±1..=max with k·base == target, if any (and 0 for the identity).
fn small_multiple<G: Group>(target: G, base: G, max: u64) -> Option<i64> {
    if bool::from(target.is_identity()) {
        return Some(0);
    }
    let mut acc = G::identity();
    for k in 1..=max {
        acc += base;
        if acc == target {
            return Some(k as i64);
        }
        if -acc == target {
            return Some(-(k as i64));
        }
    }
    None
}

#[test]
fn blinding_generators_are_hash_to_curve_and_not_the_standard_ones() {
    let (gp, gs) = generators();
    // The values are committed under the keys' own bases...
    assert_eq!(gp.primary, spend_auth_g());
    assert_eq!(gs.primary, SecpPoint::GENERATOR);
    // ...and blinded under fixed hash-to-curve points, pinned so any change shows here.
    assert_eq!(hex::encode(pallas_bytes(&gp.alt)), PALLAS_ALT);
    assert_eq!(hex::encode(secp_bytes(&gs.alt)), SECP_ALT);
    assert_eq!(
        gp.alt,
        PallasPoint::hash_to_curve("ferry:dleq:v1")(b"pallas-alt-generator")
    );
    assert_eq!(
        gs.alt,
        k256::Secp256k1::hash_from_bytes::<ExpandMsgXmd<sha2::Sha256>>(
            &[b"secp256k1-alt-generator"],
            &[b"ferry:dleq:v1:secp256k1_XMD:SHA-256_SSWU_RO_"],
        )
        .unwrap()
    );
    // Neither is the identity, a curve's standard generator, the keys' base, or a small multiple
    // of one: a blinding point with a known discrete log opens a bit commitment to either bit.
    let pallas_g = <PallasPoint as Group>::generator();
    assert_ne!(pallas_g, spend_auth_g());
    for (name, base) in [("SpendAuthG", gp.primary), ("Pallas' generator", pallas_g)] {
        assert_eq!(
            small_multiple(gp.alt, base, SMALL),
            None,
            "Pallas alt vs {name}"
        );
    }
    assert_eq!(
        small_multiple(gs.alt, SecpPoint::GENERATOR, SMALL),
        None,
        "secp256k1 alt vs G"
    );
    // (the check does find them)
    let p1234 = gp.primary * PallasScalar::from(1_234u64);
    assert_eq!(small_multiple(p1234, gp.primary, SMALL), Some(1_234));
    assert_eq!(
        small_multiple(-gs.primary.double(), gs.primary, SMALL),
        Some(-2)
    );
    assert_eq!(small_multiple(gp.primary, gp.primary, SMALL), Some(1));
    // dleq itself only refuses alt == primary: a related pair passes, so this derivation is what
    // keeps Ferry's blinding points independent of the bases.
    assert!(Generators::new(SecpPoint::GENERATOR, SecpPoint::GENERATOR.double()).is_some());
    assert!(Generators::new(SecpPoint::GENERATOR, SecpPoint::GENERATOR).is_none());
}

// Proof layout (CompromiseLinear, two bits per group, R-form ring signatures): 127 groups of
// Pallas commitment (32) || secp256k1 commitment (33) || R (32 + 33) || 4 x s (32 + 32), then the
// two Schnorr proofs of knowledge of the keys (Pallas R, s = 64; secp256k1 R, s = 65).
const RECORD: usize = 32 + 33 + 32 + 33 + 4 * 64;
const GROUPS: usize = 127;
const POKS: core::ops::Range<usize> = GROUPS * RECORD..GROUPS * RECORD + 64 + 65;

fn pallas_at(proof: &[u8], at: usize) -> PallasPoint {
    pallas_from_bytes(proof[at..at + 32].try_into().unwrap()).unwrap()
}
fn secp_at(proof: &[u8], at: usize) -> SecpPoint {
    secp_from_bytes(proof[at..at + 33].try_into().unwrap()).unwrap()
}
/// Adds `d` to the Pallas point at `at`.
fn shift_pallas(proof: &mut [u8], at: usize, d: PallasPoint) {
    let p = pallas_at(proof, at) + d;
    proof[at..at + 32].copy_from_slice(&pallas_bytes(&p));
}
/// Adds `d` to the secp256k1 point at `at`.
fn shift_secp(proof: &mut [u8], at: usize, d: SecpPoint) {
    let p = secp_at(proof, at) + d;
    proof[at..at + 33].copy_from_slice(&secp_bytes(&p));
}
fn refused(proof: &[u8]) -> bool {
    matches!(verify(&mut OsRng, CTX, proof), Err(VerifyError::Dleq(_)))
}

#[test]
fn proof_layout() {
    let (_, p) = fresh();
    assert_eq!(GROUPS as u32, mutual_capacity() / 2);
    assert_eq!(p.proof.len(), POKS.end);
    // The keys a proof proves are the sums of its commitments on each curve.
    let (mut kp, mut ks) = (<PallasPoint as Group>::identity(), SecpPoint::IDENTITY);
    for i in 0..GROUPS {
        kp += pallas_at(&p.proof, i * RECORD);
        ks += secp_at(&p.proof, i * RECORD + 32);
    }
    assert_eq!((kp, ks), (p.pallas_pub, p.secp_pub));
}

#[test]
fn a_proof_for_one_key_pair_fails_for_another() {
    let (_, px) = fresh();
    let (_, py) = fresh();
    assert_eq!(
        verify(&mut OsRng, CTX, &px.proof).unwrap(),
        (px.pallas_pub, px.secp_pub)
    );
    for (p, s) in [
        (py.pallas_pub, py.secp_pub),
        (px.pallas_pub, py.secp_pub),
        (py.pallas_pub, px.secp_pub),
    ] {
        assert_eq!(
            verify_for(&mut OsRng, CTX, &px.proof, &p, &s),
            Err(VerifyError::KeyMismatch)
        );
    }
    // Moving x's proof onto y's keys, or onto a pair whose discrete logs differ (x's Pallas key
    // with y's secp256k1 key, the pair a cheat would want), by shifting one group's commitments.
    let retarget = |dp: PallasPoint, ds: SecpPoint| {
        let mut f = px.proof.clone();
        shift_pallas(&mut f, 0, dp);
        shift_secp(&mut f, 32, ds);
        f
    };
    let (dp, ds) = (py.pallas_pub - px.pallas_pub, py.secp_pub - px.secp_pub);
    for (what, forged) in [
        ("y's keys", retarget(dp, ds)),
        (
            "x's Pallas key, y's secp256k1 key",
            retarget(<PallasPoint as Group>::identity(), ds),
        ),
        (
            "y's Pallas key, x's secp256k1 key",
            retarget(dp, SecpPoint::IDENTITY),
        ),
    ] {
        assert!(refused(&forged), "{what}");
    }
    // y's proofs of knowledge don't carry over to x's commitments.
    let mut spliced = px.proof.clone();
    spliced[POKS].copy_from_slice(&py.proof[POKS]);
    assert!(refused(&spliced));
}

#[test]
fn a_tampered_commitment_or_bit_fails() {
    let (_, p) = fresh();
    let (gp, gs) = generators();
    for i in [0, GROUPS / 2, GROUPS - 1] {
        let at = i * RECORD;
        // Group i commits to two bits of x, in steps of 4^i: one step up on both curves is a
        // consistent change, to the keys of x + 4^i, and still refused.
        let step_p = gp.primary * PallasScalar::from(4u64).pow_vartime([i as u64]);
        let step_s = gs.primary * SecpScalar::from(4u64).pow_vartime([i as u64]);
        let mut both = p.proof.clone();
        shift_pallas(&mut both, at, step_p);
        shift_secp(&mut both, at + 32, step_s);
        assert!(refused(&both), "group {i}: bits raised on both curves");
        // On one curve only, the two commitments no longer hold one value.
        let mut one = p.proof.clone();
        shift_pallas(&mut one, at, step_p);
        assert!(refused(&one), "group {i}: bits raised on Pallas only");
        // Re-blinded on one curve: the same bits, another commitment.
        let mut blind = p.proof.clone();
        shift_secp(&mut blind, at + 32, gs.alt);
        assert!(refused(&blind), "group {i}: secp256k1 commitment re-blinded");
    }
    // Two groups swapped: each is checked against its own power of two.
    let mut swapped = p.proof.clone();
    let (a, b) = swapped.split_at_mut(RECORD);
    a.swap_with_slice(&mut b[..RECORD]);
    assert!(refused(&swapped));
}
