//! The EIP-712 `Ready(bytes32 id)` signature: B's permission for Z to claim, signed off-chain
//! once the ZEC lock has N confirmations (the EVM form of the redeem adaptor signature).

use alloy::primitives::{keccak256, Address, Signature, B256, U256};
use alloy::sol_types::{eip712_domain, Eip712Domain, SolStruct, SolValue};

alloy::sol! {
    /// `Ready(bytes32 id)`, as FerryLock hashes it.
    struct Ready {
        bytes32 id;
    }
}

/// secp256k1 n / 2: FerryLock refuses signatures with a larger s.
const HALF_N: U256 = U256::from_be_bytes([
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
]);

/// FerryLock's EIP-712 domain: name "FerryLock", version "1", the chain and the contract.
pub fn domain(chain_id: u64, contract: Address) -> Eip712Domain {
    eip712_domain! {
        name: "FerryLock",
        version: "1",
        chain_id: chain_id,
        verifying_contract: contract,
    }
}

/// The digest B signs for swap `id` (`FerryLock.readyDigest`).
pub fn ready_digest(chain_id: u64, contract: Address, id: B256) -> B256 {
    Ready { id }.eip712_signing_hash(&domain(chain_id, contract))
}

/// Who signed a 65-byte `r || s || v` ready signature, applying FerryLock's rules (v is 27 or
/// 28, s is at most n/2). None if the contract would refuse it.
pub fn ready_signer(digest: &B256, sig: &[u8; 65]) -> Option<Address> {
    if !matches!(sig[64], 27 | 28) {
        return None;
    }
    let sig = Signature::from_raw_array(sig).ok()?;
    if sig.s() > HALF_N {
        return None;
    }
    sig.recover_address_from_prehash(digest).ok()
}

/// The id FerryLock gives a lock by `locker` with `salt`: `keccak256(abi.encode(locker,
/// salt))`.
pub fn swap_id(locker: Address, salt: B256) -> B256 {
    keccak256((locker, salt).abi_encode())
}

/// Sign `Ready(id)` with B's key (low-s, v = 27/28, as the contract wants).
#[cfg(feature = "client")]
pub fn sign_ready(
    signer: &alloy::signers::local::PrivateKeySigner,
    chain_id: u64,
    contract: Address,
    id: B256,
) -> [u8; 65] {
    use alloy::signers::SignerSync;
    let digest = ready_digest(chain_id, contract, id);
    let sig = signer
        .sign_hash_sync(&digest)
        .expect("signing a 32-byte digest with a local key cannot fail");
    let sig = sig.normalize_s().unwrap_or(sig);
    sig.as_bytes()
}

#[cfg(all(test, feature = "client"))]
mod tests {
    use super::*;
    use alloy::signers::local::PrivateKeySigner;

    #[test]
    fn sign_and_recover() {
        let b = PrivateKeySigner::random();
        let contract = Address::repeat_byte(7);
        let id = B256::repeat_byte(9);
        let sig = sign_ready(&b, 31337, contract, id);
        let digest = ready_digest(31337, contract, id);
        assert_eq!(ready_signer(&digest, &sig), Some(b.address()));
        // Another chain, contract or id is another digest.
        assert_ne!(
            ready_signer(&ready_digest(84532, contract, id), &sig),
            Some(b.address())
        );
        assert_ne!(
            ready_signer(&ready_digest(31337, Address::ZERO, id), &sig),
            Some(b.address())
        );
        // v must be 27/28 and s low, as in the contract.
        let mut bad_v = sig;
        bad_v[64] -= 27;
        assert_eq!(ready_signer(&digest, &bad_v), None);
        let s = U256::from_be_slice(&sig[32..64]);
        let n = HALF_N * U256::from(2) + U256::from(1);
        let mut twin = sig;
        twin[32..64].copy_from_slice(&(n - s).to_be_bytes::<32>());
        twin[64] = if sig[64] == 27 { 28 } else { 27 };
        assert_eq!(ready_signer(&digest, &twin), None);
    }

    #[test]
    fn swap_id_matches_abi_encoding() {
        let locker = Address::repeat_byte(0xab);
        let salt = B256::repeat_byte(1);
        let mut enc = [0u8; 64];
        enc[12..32].copy_from_slice(locker.as_slice());
        enc[32..].copy_from_slice(salt.as_slice());
        assert_eq!(swap_id(locker, salt), keccak256(enc));
    }
}
