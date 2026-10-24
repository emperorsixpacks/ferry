//! jointkey: an Ironwood (NU6.3) key whose spend authorizing key is split additively,
//! ask = a + b, ak = A + B. `infra/e2e-real.sh` uses it for the privacy check's control run: a
//! joint-key sweep signed without `--discard-ovk`, which the counterparty can read.
//!
//!   jointkey keygen <keys.json>                 random a, b, nk, rivk -> UFVK + UA
//!   jointkey sign <keys.json> <in.pczt> <out.pczt>
//!                                               sign every Ironwood/Orchard spend with
//!                                               rsk = ask + alpha, ask recombined from a, b

use std::{env, fs};

use anyhow::{Context, anyhow, bail};
use ff::{FromUniformBytes, PrimeField};
use group::{Group, GroupEncoding};
use orchard::{
    keys::FullViewingKey,
    primitives::redpallas::{self, SpendAuth},
};
use pasta_curves::pallas;
use pczt::{Pczt, roles::low_level_signer::Signer};
use rand::{
    rand_core::{Rng as _, UnwrapErr},
    rngs::SysRng,
};
use serde::{Deserialize, Serialize};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_primitives::transaction::{
    TxVersion, sighash::SignableInput, sighash_v5::v5_signature_hash,
    sighash_v6::v6_signature_hash, txid::TxIdDigester,
};
use zcash_protocol::{consensus::BlockHeight, local_consensus::LocalNetwork};

/// Matches conf/activation_heights.toml and zebrad.toml: everything through NU6.3 at 1.
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

#[derive(Serialize, Deserialize)]
struct Keys {
    /// Alice's share (hex LE Pallas scalar), as originally sampled.
    a: String,
    /// Bob's share.
    b: String,
    /// True if A + B had ỹ = 1, so the effective key is ask = -(a + b), ak = -(A + B).
    negated: bool,
    /// Public shares A = [a]G, B = [b]G (G = SpendAuth basepoint), point encodings.
    a_pub: String,
    b_pub: String,
    ak: String,
    nk: String,
    rivk: String,
    ufvk: String,
    ua: String,
}

fn rng() -> UnwrapErr<SysRng> {
    UnwrapErr(SysRng)
}

fn random_scalar() -> pallas::Scalar {
    let mut wide = [0u8; 64];
    rng().fill_bytes(&mut wide);
    pallas::Scalar::from_uniform_bytes(&wide)
}

fn random_base() -> pallas::Base {
    let mut wide = [0u8; 64];
    rng().fill_bytes(&mut wide);
    pallas::Base::from_uniform_bytes(&wide)
}

/// [x]G on the RedPallas SpendAuth basepoint, via the signing-key -> verification-key map.
fn spendauth_pub(x: &pallas::Scalar) -> pallas::Point {
    let sk = redpallas::SigningKey::<SpendAuth>::try_from(x.to_repr()).expect("nonzero scalar");
    let vk = redpallas::VerificationKey::from(&sk);
    let bytes: [u8; 32] = (&vk).into();
    pallas::Point::from_bytes(&bytes).unwrap()
}

fn scalar_from_hex(s: &str) -> anyhow::Result<pallas::Scalar> {
    let bytes: [u8; 32] = hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow!("scalar must be 32 bytes"))?;
    Option::from(pallas::Scalar::from_repr(bytes)).ok_or_else(|| anyhow!("non-canonical scalar"))
}

/// ask = ±(a + b), the key the party holding both shares signs with.
fn combined_ask(keys: &Keys) -> anyhow::Result<pallas::Scalar> {
    let sum = scalar_from_hex(&keys.a)? + scalar_from_hex(&keys.b)?;
    Ok(if keys.negated { -sum } else { sum })
}

fn keygen(out: &str) -> anyhow::Result<()> {
    let params = regtest();
    loop {
        let a = random_scalar();
        let b = random_scalar();
        let (a_pub, b_pub) = (spendauth_pub(&a), spendauth_pub(&b));
        let sum_pub = a_pub + b_pub;
        if bool::from(sum_pub.is_identity()) {
            continue;
        }
        // Orchard requires repr(ak) to have ỹ = 0 (top bit of the encoding). The sign
        // of A + B is public, so both parties agree to negate their shares if needed.
        let negated = sum_pub.to_bytes()[31] >> 7 == 1;
        let ak_pub = if negated { -sum_pub } else { sum_pub };
        let ask = if negated { -(a + b) } else { a + b };
        assert_eq!(spendauth_pub(&ask).to_bytes(), ak_pub.to_bytes());

        let mut raw = [0u8; 96];
        raw[..32].copy_from_slice(&ak_pub.to_bytes());
        raw[32..64].copy_from_slice(&random_base().to_repr());
        raw[64..].copy_from_slice(&random_scalar().to_repr());
        let Some(fvk) = FullViewingKey::from_bytes(&raw) else {
            continue;
        };

        let ufvk = UnifiedFullViewingKey::from_orchard_fvk(fvk)
            .map_err(|e| anyhow!("UFVK: {e:?}"))?;
        let (ua, _) = ufvk
            .default_address(UnifiedAddressRequest::ALLOW_ALL)
            .map_err(|e| anyhow!("UA: {e:?}"))?;

        let keys = Keys {
            a: hex::encode(a.to_repr()),
            b: hex::encode(b.to_repr()),
            negated,
            a_pub: hex::encode(a_pub.to_bytes()),
            b_pub: hex::encode(b_pub.to_bytes()),
            ak: hex::encode(&raw[..32]),
            nk: hex::encode(&raw[32..64]),
            rivk: hex::encode(&raw[64..]),
            ufvk: ufvk.encode(&params).map_err(|e| anyhow!("UFVK encode: {e:?}"))?,
            ua: ua.encode(&params),
        };
        fs::write(out, serde_json::to_string_pretty(&keys)?)?;
        println!("negated={negated}");
        println!("UFVK={}", keys.ufvk);
        println!("UA={}", keys.ua);
        return Ok(());
    }
}

fn sighash_for(pczt: &Pczt) -> anyhow::Result<(TxVersion, [u8; 32])> {
    let tx_data = pczt
        .clone()
        .into_effects()
        .map_err(|e| anyhow!("effects: {e:?}"))?;
    let txid_parts = tx_data.digest(TxIdDigester);
    let version = tx_data.version();
    let sighash = match version {
        TxVersion::V6 => v6_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts),
        TxVersion::V5 => v5_signature_hash(&tx_data, &SignableInput::Shielded, &txid_parts),
        v => bail!("unsupported tx version {v:?}"),
    };
    Ok((version, sighash.as_ref().try_into()?))
}

#[derive(Debug)]
enum SignErr {
    Parse(#[allow(dead_code)] pczt::roles::low_level_signer::OrchardParseError),
    Sign(#[allow(dead_code)] String),
}

impl From<pczt::roles::low_level_signer::OrchardParseError> for SignErr {
    fn from(e: pczt::roles::low_level_signer::OrchardParseError) -> Self {
        SignErr::Parse(e)
    }
}

/// Signs each real spend still awaiting a signature with rsk = ask + alpha, computed
/// explicitly as a scalar so the share arithmetic is visible, then hands the signature to
/// `apply_signature` (which checks it against the action's rk).
fn sign_bundle(
    bundle: &mut orchard::pczt::Bundle,
    ask: pallas::Scalar,
    sighash: [u8; 32],
    pool: &str,
    count: &mut usize,
) -> Result<(), SignErr> {
    for (idx, action) in bundle.actions_mut().iter_mut().enumerate() {
        if action.spend().spend_auth_sig().is_some() {
            continue;
        }
        let Some(alpha) = *action.spend().alpha() else {
            continue;
        };
        let rsk = ask + alpha;
        let sk = redpallas::SigningKey::<SpendAuth>::try_from(rsk.to_repr())
            .map_err(|e| SignErr::Sign(format!("{e:?}")))?;
        let sig = sk.sign(rng(), &sighash);
        action
            .apply_signature(sighash, sig)
            .map_err(|e| SignErr::Sign(format!("{pool} action {idx}: {e}")))?;
        println!("signed {pool} action #{idx} (alpha={})", hex::encode(alpha.to_repr()));
        *count += 1;
    }
    Ok(())
}

fn sign(keys_path: &str, input: &str, output: &str) -> anyhow::Result<()> {
    let keys: Keys = serde_json::from_str(&fs::read_to_string(keys_path)?)?;
    let ask = combined_ask(&keys)?;
    if hex::encode(spendauth_pub(&ask).to_bytes()) != keys.ak {
        bail!("a + b does not match ak");
    }

    let pczt = Pczt::parse(&fs::read(input)?).map_err(|e| anyhow!("parse: {e:?}"))?;
    let (version, sighash) = sighash_for(&pczt)?;
    println!("tx version {version:?}, SIGHASH {}", hex::encode(sighash));

    let mut count = 0;
    let mut signer = Signer::new(pczt);
    signer = signer
        .sign_ironwood_with(|_, bundle, _| sign_bundle(bundle, ask, sighash, "ironwood", &mut count))
        .map_err(|e| anyhow!("ironwood: {e:?}"))?;
    signer = signer
        .sign_orchard_with(|_, bundle, _| sign_bundle(bundle, ask, sighash, "orchard", &mut count))
        .map_err(|e| anyhow!("orchard: {e:?}"))?;
    if count == 0 {
        bail!("no spends awaiting a signature");
    }

    let bytes = signer
        .finish()
        .serialize()
        .map_err(|e| anyhow!("serialize: {e:?}"))?;
    fs::write(output, bytes).context("write signed PCZT")?;
    println!("wrote {output} ({count} spend signature(s))");
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [_, "keygen", out] => keygen(out),
        [_, "sign", keys, input, output] => sign(keys, input, output),
        _ => bail!("usage: jointkey keygen <keys.json> | jointkey sign <keys.json> <in.pczt> <out.pczt>"),
    }
}
