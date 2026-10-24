//! Ethereum addresses of secp256k1 points and shares, matching `FerryLock.scalarAddress`.

use alloy::primitives::{keccak256, Address};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{ProjectivePoint, PublicKey, Scalar};

use crate::Error;

/// `keccak256(x || y)[12..]` of a point: the address Ethereum gives the key with this public
/// point.
pub fn point_address(point: &PublicKey) -> Address {
    let enc = point.to_encoded_point(false);
    Address::from_slice(&keccak256(&enc.as_bytes()[1..])[12..])
}

/// [`point_address`] of a SEC1-encoded point (compressed or uncompressed), such as a Ferry
/// `Setup::secp_pub`.
pub fn point_address_sec1(sec1: &[u8]) -> Result<Address, Error> {
    let pk = PublicKey::from_sec1_bytes(sec1).map_err(|_| Error::BadPoint)?;
    Ok(point_address(&pk))
}

/// `address(k·G)` for a big-endian scalar `0 < k < n`, else None. Mirrors the contract, which
/// accepts only the canonical scalar: B maps it back to a Pallas share, so `k + n` must not
/// pass.
pub fn scalar_address(k_be: &[u8; 32]) -> Option<Address> {
    let k: Option<Scalar> = Scalar::from_repr((*k_be).into()).into();
    let k = k.filter(|k| !bool::from(k.is_zero()))?;
    let point = PublicKey::from_affine((ProjectivePoint::GENERATOR * k).to_affine()).ok()?;
    Some(point_address(&point))
}

/// Check that a scalar revealed on chain (or in calldata) is the share behind `expected`.
pub fn verify_share(k_be: &[u8; 32], expected: Address) -> Result<(), Error> {
    if scalar_address(k_be) == Some(expected) {
        Ok(())
    } else {
        Err(Error::ScalarMismatch)
    }
}

#[cfg(all(test, feature = "client"))]
mod tests {
    use super::*;
    use alloy::primitives::address;
    use alloy::signers::local::PrivateKeySigner;

    fn be(n: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..].copy_from_slice(&n.to_be_bytes());
        out
    }

    const N: [u8; 32] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36,
        0x41, 0x41,
    ];

    #[test]
    fn known_addresses() {
        assert_eq!(
            scalar_address(&be(1)),
            Some(address!("7E5F4552091A69125d5DfCb7b8C2659029395Bdf"))
        );
        assert_eq!(
            scalar_address(&be(2)),
            Some(address!("2B5AD5c4795c026514f8317c7a215E218DcCD6cF"))
        );
    }

    #[test]
    fn rejects_zero_and_non_canonical() {
        assert_eq!(scalar_address(&[0u8; 32]), None);
        assert_eq!(scalar_address(&N), None);
        assert_eq!(scalar_address(&[0xFF; 32]), None);
        let mut n_minus_1 = N;
        n_minus_1[31] -= 1;
        assert!(scalar_address(&n_minus_1).is_some());
    }

    #[test]
    fn matches_alloy_signer_and_sec1_forms() {
        for _ in 0..32 {
            let signer = PrivateKeySigner::random();
            let k: [u8; 32] = signer.credential().to_bytes().into();
            assert_eq!(scalar_address(&k), Some(signer.address()));
            let pk = signer.credential().verifying_key();
            let compressed = pk.to_encoded_point(true);
            let uncompressed = pk.to_encoded_point(false);
            assert_eq!(
                point_address_sec1(compressed.as_bytes()).unwrap(),
                signer.address()
            );
            assert_eq!(
                point_address_sec1(uncompressed.as_bytes()).unwrap(),
                signer.address()
            );
            verify_share(&k, signer.address()).unwrap();
            assert!(verify_share(&be(7), signer.address()).is_err());
        }
        let mut not_on_curve = [0xFFu8; 33];
        not_on_curve[0] = 2;
        assert!(point_address_sec1(&not_on_curve).is_err());
    }

    /// A Ferry share (Pallas scalar < 2^254 with a cross-group DLEQ proof) commits to the same
    /// address whether derived from its published secp256k1 point or from the scalar.
    #[test]
    fn ferry_share_addresses() {
        use ferry_dleq::k256::elliptic_curve::PrimeField as _;
        let share = ferry_dleq::random_mutual_scalar(&mut rand_core::OsRng);
        let proven = ferry_dleq::prove(&mut rand_core::OsRng, b"test", share.clone()).unwrap();
        let secp_be: [u8; 32] = ferry_dleq::to_secp_scalar(&share).unwrap().to_repr().into();
        let from_point = point_address_sec1(&ferry_dleq::secp_bytes(&proven.secp_pub)).unwrap();
        assert_eq!(scalar_address(&secp_be), Some(from_point));
    }
}
