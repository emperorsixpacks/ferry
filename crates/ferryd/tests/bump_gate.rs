//! The real `ferryd` binary refuses to start with the fee bump on, on a Bitcoin or Litecoin
//! mainnet, by the flag or by the environment, before it opens a node or a port. The bump moves
//! funds and has not been reviewed outside the project (docs/THREAT-MODEL.md), so Bitcoin and
//! Litecoin stay off mainnet until it has.
//!
//! Only the refusals are run here: a daemon that is allowed to start would need a node.

use std::path::Path;
use std::process::Command;

/// Run ferryd with `args` (and `env`), and return whether it succeeded and what it printed.
fn ferryd(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> (bool, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ferryd"));
    cmd.args([
        "--role",
        "z",
        "--name",
        "gate",
        "--data-dir",
        dir.join("data").to_str().unwrap(),
        "--zec",
        "mock",
        "--zec-mock-file",
        dir.join("zec.json").to_str().unwrap(),
    ])
    .args(args)
    .env_remove("FERRY_BUMP")
    .env_remove("FERRY_BUMP_SOFT_CAP_PERCENT");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("run ferryd");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    (out.status.success(), text)
}

#[test]
fn bump_on_is_refused_on_a_bitcoin_or_litecoin_mainnet() {
    let dir = tempfile::tempdir().unwrap();
    let refused = |args: &[&str], env: &[(&str, &str)], who: &str| {
        let (ok, text) = ferryd(dir.path(), args, env);
        assert!(!ok, "{args:?} {env:?} started: {text}");
        assert!(
            text.contains("not allowed on") && text.contains(who) && text.contains("mainnet"),
            "{args:?} {env:?}: {text}"
        );
        assert!(text.contains("THREAT-MODEL"), "{text}");
    };
    // The flag, on each coin.
    refused(
        &["--network", "bitcoin", "--bump", "on"],
        &[],
        "Bitcoin mainnet",
    );
    refused(
        &["--chain", "ltc", "--network", "bitcoin", "--bump", "on"],
        &[],
        "Litecoin mainnet",
    );
    // The environment form does the same, with no flag at all.
    refused(
        &["--network", "bitcoin"],
        &[("FERRY_BUMP", "on")],
        "Bitcoin mainnet",
    );
    refused(
        &["--chain", "ltc", "--network", "bitcoin"],
        &[("FERRY_BUMP", "on")],
        "Litecoin mainnet",
    );
}

#[test]
fn the_urgent_window_is_bounded_at_the_command_line() {
    let dir = tempfile::tempdir().unwrap();
    let (ok, text) = ferryd(dir.path(), &["--bump-urgent-blocks", "6"], &[]);
    assert!(!ok);
    assert!(text.contains("--bump-urgent-blocks"), "{text}");
}
