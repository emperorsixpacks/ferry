//! The committed artifacts (ABI + bytecode compiled into the bindings) match a fresh
//! `forge build` of contracts/. Refresh them with `contracts/export-artifacts.sh`.
//! Without a forge binary the test prints a note and passes.

use std::path::{Path, PathBuf};
use std::process::Command;

fn forge_binary() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|p| p.join("forge"))
            .find(|p| p.is_file())
    });
    on_path.or_else(|| {
        let p = PathBuf::from(std::env::var_os("HOME")?).join(".foundry/bin/forge");
        p.is_file().then_some(p)
    })
}

fn json(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn artifacts_match_forge_build() {
    let Some(forge) = forge_binary() else {
        eprintln!("SKIP: no forge binary (install with foundryup)");
        return;
    };
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let contracts = manifest.join("../../contracts");
    let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("ferry-evm-forge-out");
    let status = Command::new(forge)
        .arg("build")
        .arg("--root")
        .arg(&contracts)
        .arg("--out")
        .arg(&out)
        .arg("--cache-path")
        .arg(out.join("cache"))
        .args(["--skip", "test", "--skip", "script"])
        .status()
        .unwrap();
    assert!(status.success(), "forge build failed");
    for name in ["FerryLock", "MockUSDC"] {
        let fresh = json(&out.join(format!("{name}.sol/{name}.json")));
        let committed = json(&manifest.join(format!("artifacts/{name}.json")));
        for key in ["abi", "bytecode", "deployedBytecode"] {
            let f = if key == "abi" {
                fresh[key].clone()
            } else {
                serde_json::json!({ "object": fresh[key]["object"] })
            };
            assert_eq!(
                f, committed[key],
                "{name} {key} is stale: run contracts/export-artifacts.sh"
            );
        }
    }
}
