//! Prove/verify timing: `cargo run --release -p ferry-dleq --example bench`


use std::time::Instant;

use ferry_dleq::*;
use rand_core::OsRng;

fn main() {
    const RUNS: u32 = 20;
    let ctx = b"ferry-bench/swap-0001/Z";

    println!(
        "SpendAuthG (Orchard)  = {}",
        hex::encode(pallas_bytes(&spend_auth_g()))
    );
    println!("mutual capacity        = {} bits", mutual_capacity());

    let xs: Vec<_> = (0..RUNS)
        .map(|_| random_mutual_scalar(&mut OsRng))
        .collect();

    let t = Instant::now();
    let proofs: Vec<Proven> = xs
        .iter()
        .map(|x| prove(&mut OsRng, ctx, x.clone()).unwrap())
        .collect();
    let prove_ms = t.elapsed().as_secs_f64() * 1e3 / f64::from(RUNS);

    let t = Instant::now();
    for p in &proofs {
        verify_for(&mut OsRng, ctx, &p.proof, &p.pallas_pub, &p.secp_pub).expect("verify failed");
    }
    let verify_ms = t.elapsed().as_secs_f64() * 1e3 / f64::from(RUNS);

    let p = &proofs[0];
    println!(
        "X_p (Pallas)           = {}",
        hex::encode(pallas_bytes(&p.pallas_pub))
    );
    println!(
        "X_s (secp256k1)        = {}",
        hex::encode(secp_bytes(&p.secp_pub))
    );
    println!("proof size             = {} bytes", p.proof.len());
    println!("prove time (avg/{RUNS})   = {prove_ms:.1} ms");
    println!("verify time (avg/{RUNS})  = {verify_ms:.1} ms");
    println!("verification           = OK");

    // Negative: proof for x checked against a secp key for a different scalar y.
    let other = &proofs[1];
    let neg = verify_for(&mut OsRng, ctx, &p.proof, &p.pallas_pub, &other.secp_pub);
    println!("negative (x vs y keys) = {neg:?}");
    assert_eq!(neg, Err(VerifyError::KeyMismatch));

    // Negative: splice y's secp commitment (bits 0-1) into x's proof.
    let mut forged = p.proof.clone();
    forged[32..65].copy_from_slice(&other.proof[32..65]);
    let neg = verify(&mut OsRng, ctx, &forged);
    println!("negative (spliced)     = {:?}", neg.as_ref().map(|_| ()));
    assert!(neg.is_err());
}
