//! The joint Ironwood spend authority `ak = σ·(Z_p + B_p)`, `ask = σ·(z + b)`.
//!
//! Orchard/Ironwood require `ak` to have ỹ = 0. In the pasta_curves 0.5 encoding that is
//! bit 255 (`bytes[31] & 0x80`) clear, so σ = −1 exactly when `Z_p + B_p` encodes with it set.

use ferry_dleq::pasta_curves::group::ff::{FromUniformBytes, PrimeField};
use ferry_dleq::pasta_curves::group::{Group, GroupEncoding};
use ferry_dleq::pasta_curves::pallas;
use ferry_dleq::{PallasPoint, PallasScalar};
use zeroize::Zeroizing;

use crate::Error;

fn needs_negation(p: &PallasPoint) -> bool {
    p.to_bytes()[31] & 0x80 != 0
}

/// `σ·P` with ỹ = 0, and whether σ = −1.
pub fn normalize_ak(p: &PallasPoint) -> Result<(PallasPoint, bool), Error> {
    if bool::from(p.is_identity()) {
        return Err(Error::JointKeyIdentity);
    }
    let neg = needs_negation(p);
    Ok((if neg { -p } else { *p }, neg))
}

/// Encoding of `ak = σ·(Z_p + B_p)`; byte 31 bit 7 is always clear.
pub fn joint_ak_bytes(z_p: &PallasPoint, b_p: &PallasPoint) -> Result<[u8; 32], Error> {
    Ok(normalize_ak(&(z_p + b_p))?.0.to_bytes())
}

/// Encoding of `ask = σ·(z + b)`, the spend authorizing key for [`joint_ak_bytes`].
pub fn joint_ask_bytes(z: &PallasScalar, b: &PallasScalar) -> Result<Zeroizing<[u8; 32]>, Error> {
    let sum = Zeroizing::new(z + b);
    let (_, neg) = normalize_ak(&(ferry_dleq::spend_auth_g() * *sum))?;
    let ask = Zeroizing::new(if neg { -*sum } else { *sum });
    Ok(Zeroizing::new(ask.to_repr()))
}

/// Joint full viewing key in Orchard's 96-byte encoding `ak || nk || rivk`, with `nk`, `rivk`
/// derived from `H(session_id, Z_p, B_p, nonce_Z, nonce_B, ecdh)` so neither party picks them
/// alone. Everything but the ECDH secret travels in the clear, so without it an observer of the
/// peer channel could rebuild the viewing key and find the lock note.
pub fn joint_fvk_bytes(
    session_id: &[u8; 32],
    z_p: &PallasPoint,
    b_p: &PallasPoint,
    nonce_z: &[u8; 32],
    nonce_b: &[u8; 32],
    ecdh_shared: Option<&[u8; 32]>,
) -> Result<[u8; 96], Error> {
    let ak = joint_ak_bytes(z_p, b_p)?;
    let wide = |tag: &[u8]| -> [u8; 64] {
        let mut st = blake2b_simd::Params::new()
            .hash_length(64)
            .personal(b"Ferry_JointFVK__")
            .to_state();
        st.update(tag)
            .update(session_id)
            .update(&z_p.to_bytes())
            .update(&b_p.to_bytes())
            .update(nonce_z)
            .update(nonce_b);
        if let Some(secret) = ecdh_shared {
            st.update(b"ecdh").update(secret);
        }
        st.finalize().as_bytes().try_into().expect("64-byte hash")
    };
    let nk = pallas::Base::from_uniform_bytes(&wide(b"nk"));
    let rivk = pallas::Scalar::from_uniform_bytes(&wide(b"rivk"));
    let mut fvk = [0u8; 96];
    fvk[..32].copy_from_slice(&ak);
    fvk[32..64].copy_from_slice(&nk.to_repr());
    fvk[64..].copy_from_slice(&rivk.to_repr());
    Ok(fvk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    #[test]
    fn ask_matches_ak_for_both_signs() {
        let g = ferry_dleq::spend_auth_g();
        let (mut pos, mut neg) = (0, 0);
        for _ in 0..32 {
            let z = ferry_dleq::random_mutual_scalar(&mut OsRng);
            let b = ferry_dleq::random_mutual_scalar(&mut OsRng);
            let (z_p, b_p) = (g * *z, g * *b);
            if needs_negation(&(z_p + b_p)) {
                neg += 1
            } else {
                pos += 1
            }
            let ak = joint_ak_bytes(&z_p, &b_p).unwrap();
            assert_eq!(ak[31] & 0x80, 0);
            let ask = joint_ask_bytes(&z, &b).unwrap();
            let ask = ferry_dleq::pallas_scalar_from_bytes(&ask).unwrap();
            assert_eq!((g * ask).to_bytes(), ak);
        }
        assert!(pos > 0 && neg > 0);
    }

    #[test]
    fn joint_ask_matches_joint_ak_in_redpallas() {
        // reddsa 0.6.1 is orchard's SpendAuth signature implementation.
        use reddsa::{orchard::SpendAuth, SigningKey, VerificationKey};
        let g = ferry_dleq::spend_auth_g();
        let z = ferry_dleq::random_mutual_scalar(&mut OsRng);
        let b = ferry_dleq::random_mutual_scalar(&mut OsRng);
        let ak = joint_ak_bytes(&(g * *z), &(g * *b)).unwrap();
        let sk = SigningKey::<SpendAuth>::from_bytes(&joint_ask_bytes(&z, &b).unwrap()).unwrap();
        VerificationKey::<SpendAuth>::try_from(ak).unwrap();
        assert_eq!(<[u8; 32]>::from(VerificationKey::from(&sk)), ak);
    }

    #[test]
    fn identity_rejected() {
        let g = ferry_dleq::spend_auth_g();
        assert!(matches!(
            joint_ak_bytes(&g, &-g),
            Err(Error::JointKeyIdentity)
        ));
    }

    #[test]
    fn fvk_depends_on_every_input() {
        let g = ferry_dleq::spend_auth_g();
        let (z_p, b_p) = (g * PallasScalar::from(5), g * PallasScalar::from(7));
        let base = joint_fvk_bytes(&[0; 32], &z_p, &b_p, &[1; 32], &[2; 32], None).unwrap();
        assert_ne!(
            base,
            joint_fvk_bytes(&[9; 32], &z_p, &b_p, &[1; 32], &[2; 32], None).unwrap()
        );
        assert_ne!(
            base,
            joint_fvk_bytes(&[0; 32], &z_p, &b_p, &[3; 32], &[2; 32], None).unwrap()
        );
        assert_ne!(
            base,
            joint_fvk_bytes(&[0; 32], &z_p, &b_p, &[1; 32], &[3; 32], None).unwrap()
        );
        assert_eq!(&base[..32], &joint_ak_bytes(&z_p, &b_p).unwrap());
    }
}
