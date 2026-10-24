//! Helper for `ferry-zec`, built outside the Ferry workspace and pinned to zcash-devtool's
//! librustzcash revision (Cargo.lock copied from vendor/zcash-devtool) so its PCZTs
//! round-trip with the devtool binary.
//!
//!   ferry-zec-signer ufvk <regtest|test|main> <fvk hex>
//!       Joint Orchard-encoded FVK (ak || nk || rivk, 96 bytes) -> `UFVK=…` and `UA=…` lines.
//!   ferry-zec-signer sign <in.pczt> <out.pczt>      (ask hex on stdin)
//!       Signs every Ironwood/Orchard spend still awaiting a signature with
//!       rsk = ask + alpha (RedPallas SpendAuth over the transaction's shielded sighash).
//!   ferry-zec-signer spends <pczt>
//!       The values of the notes a PCZT's Ironwood and Orchard actions spend, as
//!       `ironwood=<v>,<v>… orchard=<v>,…` (zatoshi; dummy spends show as 0). Used to make sure
//!       a sweep includes the lock note.
//!   ferry-zec-signer address <regtest|test|main> <ua>
//!       Whether a sweep may pay this address: a unified address of that network with an Orchard
//!       receiver (Ironwood shares it). Prints `ADDRESS_OK`, or fails saying why not. Used to
//!       check a route's sweep destination (`sweep_to`) before a swap starts.
//!   ferry-zec-signer pools <file>
//!       What a PCZT or a raw transaction (binary or hex) touches, as one line of `key=count`:
//!       transparent_inputs, transparent_outputs, sapling_spends, sapling_outputs,
//!       orchard_actions, ironwood_actions. Used to keep every Ferry ZEC transaction Ironwood-only.

use std::{env, fs, io::Read};

use anyhow::{Context, anyhow, bail};
use ff::PrimeField;
use orchard::{
    keys::FullViewingKey,
    primitives::redpallas::{self, SpendAuth},
};
use pasta_curves::pallas;
use pczt::{
    Pczt,
    roles::low_level_signer::{OrchardParseError, Signer},
};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use zcash_keys::address::UnifiedAddress;
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_primitives::transaction::{
    Transaction, TxVersion, sighash::SignableInput, sighash_v5::v5_signature_hash,
    sighash_v6::v6_signature_hash, txid::TxIdDigester,
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Network},
    local_consensus::LocalNetwork,
};

/// Address encodings only depend on the network type, so the regtest heights are immaterial.
fn regtest() -> LocalNetwork {
    let h = Some(BlockHeight::from_u32(1));
    LocalNetwork {
        overwinter: h,
        sapling: h,
        blossom: h,
        heartwood: h,
        canopy: h,
        nu5: h,
        nu6: h,
        nu6_1: h,
        nu6_2: h,
        nu6_3: h,
        nu7: None,
    }
}

fn ufvk(network: &str, fvk_hex: &str) -> anyhow::Result<()> {
    let raw: [u8; 96] = hex::decode(fvk_hex)?
        .try_into()
        .map_err(|_| anyhow!("FVK must be 96 bytes"))?;
    let fvk = FullViewingKey::from_bytes(&raw)
        .ok_or_else(|| anyhow!("not a valid Orchard FVK (ak must have ỹ = 0)"))?;
    let ufvk = UnifiedFullViewingKey::from_orchard_fvk(fvk).map_err(|e| anyhow!("UFVK: {e:?}"))?;
    let (ua, _) = ufvk
        .default_address(UnifiedAddressRequest::ALLOW_ALL)
        .map_err(|e| anyhow!("UA: {e:?}"))?;
    let (ufvk, ua) = match network {
        "regtest" => (ufvk.encode(&regtest()), ua.encode(&regtest())),
        "test" => (
            ufvk.encode(&Network::TestNetwork),
            ua.encode(&Network::TestNetwork),
        ),
        "main" => (
            ufvk.encode(&Network::MainNetwork),
            ua.encode(&Network::MainNetwork),
        ),
        n => bail!("unknown network {n}"),
    };
    println!("UFVK={}", ufvk.map_err(|e| anyhow!("UFVK encode: {e:?}"))?);
    println!("UA={ua}");
    Ok(())
}

/// A sweep may pay `ua`: a unified address of `network` with an Orchard receiver (an Ironwood
/// output goes to the Orchard receiver). A sweep is Ironwood-only, so an address without one
/// could not be paid shielded.
fn check_address(network: &str, ua: &str) -> anyhow::Result<()> {
    let decoded = match network {
        "regtest" => UnifiedAddress::decode(&regtest(), ua),
        "test" => UnifiedAddress::decode(&Network::TestNetwork, ua),
        "main" => UnifiedAddress::decode(&Network::MainNetwork, ua),
        n => bail!("unknown network {n}"),
    }
    .map_err(|e| anyhow!("not a unified address of the Zcash {network} network ({e})"))?;
    if !decoded.has_orchard() {
        bail!("the address has no Orchard receiver, so an Ironwood sweep can't pay it");
    }
    Ok(())
}

fn sighash_for(pczt: &Pczt) -> anyhow::Result<[u8; 32]> {
    let tx_data = pczt
        .clone()
        .into_effects()
        .map_err(|e| anyhow!("effects: {e:?}"))?;
    let txid_parts = tx_data.digest(TxIdDigester);
    let sighash = match tx_data.version() {
        TxVersion::V6 => v6_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts),
        TxVersion::V5 => v5_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts),
        v => bail!("unsupported tx version {v:?}"),
    };
    Ok(sighash.as_ref().try_into()?)
}

#[derive(Debug)]
enum SignErr {
    Parse(#[allow(dead_code)] OrchardParseError),
    Sign(#[allow(dead_code)] String),
}

impl From<OrchardParseError> for SignErr {
    fn from(e: OrchardParseError) -> Self {
        SignErr::Parse(e)
    }
}

/// rsk = ask + alpha for each real spend still awaiting a signature; `apply_signature`
/// checks the result against the action's rk, so a wrong `ask` fails here, not at broadcast.
fn sign_bundle(
    bundle: &mut orchard::pczt::Bundle,
    ask: pallas::Scalar,
    sighash: [u8; 32],
    count: &mut usize,
) -> Result<(), SignErr> {
    for (idx, action) in bundle.actions_mut().iter_mut().enumerate() {
        if action.spend().spend_auth_sig().is_some() {
            continue;
        }
        let Some(alpha) = *action.spend().alpha() else {
            continue;
        };
        let rsk = redpallas::SigningKey::<SpendAuth>::try_from((ask + alpha).to_repr())
            .map_err(|e| SignErr::Sign(format!("{e:?}")))?;
        let sig = rsk.sign(UnwrapErr(SysRng), &sighash);
        action
            .apply_signature(sighash, sig)
            .map_err(|e| SignErr::Sign(format!("action {idx}: {e}")))?;
        *count += 1;
    }
    Ok(())
}

fn sign(input: &str, output: &str) -> anyhow::Result<()> {
    let mut ask_hex = String::new();
    std::io::stdin().read_to_string(&mut ask_hex)?;
    let ask_bytes: [u8; 32] = hex::decode(ask_hex.trim())?
        .try_into()
        .map_err(|_| anyhow!("ask must be 32 bytes"))?;
    let ask = Option::<pallas::Scalar>::from(pallas::Scalar::from_repr(ask_bytes))
        .ok_or_else(|| anyhow!("ask is not a canonical Pallas scalar"))?;

    let pczt = Pczt::parse(&fs::read(input)?).map_err(|e| anyhow!("parse: {e:?}"))?;
    let sighash = sighash_for(&pczt)?;
    let mut count = 0;
    let signer = Signer::new(pczt)
        .sign_ironwood_with(|_, bundle, _| sign_bundle(bundle, ask, sighash, &mut count))
        .map_err(|e| anyhow!("ironwood: {e:?}"))?
        .sign_orchard_with(|_, bundle, _| sign_bundle(bundle, ask, sighash, &mut count))
        .map_err(|e| anyhow!("orchard: {e:?}"))?;
    if count == 0 {
        bail!("no spends awaiting a signature");
    }
    let bytes = signer
        .finish()
        .serialize()
        .map_err(|e| anyhow!("serialize: {e:?}"))?;
    fs::write(output, bytes).context("write signed PCZT")?;
    println!("SIGNED={count}");
    Ok(())
}

fn pools(path: &str) -> anyhow::Result<()> {
    let bytes = fs::read(path)?;
    let counts: [usize; 6] = if bytes.starts_with(b"PCZT") {
        let p = Pczt::parse(&bytes).map_err(|e| anyhow!("parse PCZT: {e:?}"))?;
        [
            p.transparent().inputs().len(),
            p.transparent().outputs().len(),
            p.sapling().spends().len(),
            p.sapling().outputs().len(),
            p.orchard().actions().len(),
            p.ironwood().actions().len(),
        ]
    } else {
        let text = String::from_utf8_lossy(&bytes);
        let raw = match hex::decode(text.trim()) {
            Ok(raw) => raw,
            Err(_) => bytes.clone(),
        };
        // The branch id only matters for pre-v5 transactions, which carry no Ironwood bundle.
        let tx = Transaction::read(&raw[..], BranchId::Nu6_3).context("parse transaction")?;
        [
            tx.transparent_bundle().map_or(0, |b| b.vin.len()),
            tx.transparent_bundle().map_or(0, |b| b.vout.len()),
            tx.sapling_bundle().map_or(0, |b| b.shielded_spends().len()),
            tx.sapling_bundle()
                .map_or(0, |b| b.shielded_outputs().len()),
            tx.orchard_bundle().map_or(0, |b| b.actions().len()),
            tx.ironwood_bundle().map_or(0, |b| b.actions().len()),
        ]
    };
    let [ti, to, ss, so, oa, ia] = counts;
    println!(
        "transparent_inputs={ti} transparent_outputs={to} sapling_spends={ss} sapling_outputs={so} orchard_actions={oa} ironwood_actions={ia}"
    );
    Ok(())
}

fn spends(path: &str) -> anyhow::Result<()> {
    let pczt = Pczt::parse(&fs::read(path)?).map_err(|e| anyhow!("parse PCZT: {e:?}"))?;
    fn values(bundle: &orchard::pczt::Bundle, out: &mut Vec<u64>) {
        for action in bundle.actions() {
            out.push(action.spend().value().map_or(0, |v| v.inner()));
        }
    }
    let (mut iw, mut or) = (vec![], vec![]);
    // The signing entry points are the public way into the parsed bundles; these closures
    // only read, so the PCZT is left as it was.
    Signer::new(pczt)
        .sign_ironwood_with(|_, b, _| -> Result<(), OrchardParseError> {
            values(b, &mut iw);
            Ok(())
        })
        .map_err(|e| anyhow!("ironwood: {e:?}"))?
        .sign_orchard_with(|_, b, _| -> Result<(), OrchardParseError> {
            values(b, &mut or);
            Ok(())
        })
        .map_err(|e| anyhow!("orchard: {e:?}"))?;
    let join = |v: &[u64]| v.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
    println!("ironwood={} orchard={}", join(&iw), join(&or));
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [_, "ufvk", network, fvk] => ufvk(network, fvk),
        [_, "sign", input, output] => sign(input, output),
        [_, "address", network, ua] => {
            check_address(network, ua)?;
            println!("ADDRESS_OK");
            Ok(())
        }
        [_, "pools", path] => pools(path),
        [_, "spends", path] => spends(path),
        _ => bail!(
            "usage: ferry-zec-signer ufvk <regtest|test|main> <fvk hex> | sign <in.pczt> <out.pczt> (ask hex on stdin) | address <regtest|test|main> <ua> | pools <pczt or tx> | spends <pczt>"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::keys::SpendingKey;

    /// The default UA of a fixed Orchard key, encoded for `network`.
    fn orchard_ua(network: &str) -> String {
        let sk = Option::<SpendingKey>::from(SpendingKey::from_bytes([7; 32])).unwrap();
        let ufvk = UnifiedFullViewingKey::from_orchard_fvk(FullViewingKey::from(&sk)).unwrap();
        let (ua, _) = ufvk
            .default_address(UnifiedAddressRequest::ALLOW_ALL)
            .unwrap();
        match network {
            "regtest" => ua.encode(&regtest()),
            "test" => ua.encode(&Network::TestNetwork),
            _ => ua.encode(&Network::MainNetwork),
        }
    }

    #[test]
    fn sweep_destinations() {
        for net in ["regtest", "test", "main"] {
            check_address(net, &orchard_ua(net)).unwrap();
        }
        // Another network's address, in every direction.
        assert!(check_address("test", &orchard_ua("regtest")).is_err());
        assert!(check_address("regtest", &orchard_ua("test")).is_err());
        let err = check_address("main", &orchard_ua("test"))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("not a unified address of the Zcash main network"),
            "{err}"
        );
        assert!(check_address("other", &orchard_ua("main")).is_err());
        // A mainnet UA with transparent and Sapling receivers only (a ZIP 316 test vector).
        let no_orchard = "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf";
        let err = check_address("main", no_orchard).unwrap_err().to_string();
        assert!(err.contains("no Orchard receiver"), "{err}");
        // Not a unified address at all.
        for bad in ["", "tmWxWwf15vYpBNP82EJ2vNWSS5CaikXYbjb", "-h", "uregtest1"] {
            assert!(check_address("regtest", bad).is_err(), "{bad:?}");
        }
    }
}
