//! One JSON file per route under `<data-dir>/routes`, written atomically, like ferryd's swap
//! records (`crates/ferryd/src/record.rs:246-315`). A route links both legs of a hop through
//! shielded ZEC, so the directory is 0700 and every file 0600.

use std::path::{Path, PathBuf};

use crate::route::Route;

#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn open(data_dir: &Path) -> std::io::Result<Store> {
        private_dir(data_dir)?;
        let dir = data_dir.join("routes");
        private_dir(&dir)?;
        Ok(Store { dir })
    }

    /// Durable once it returns Ok: the file is fsynced, renamed into place and the directory
    /// entry fsynced. A crash leaves either the old record or the new one, never a mix.
    pub fn save(&self, route: &Route) -> std::io::Result<()> {
        if !valid_id(&route.id) {
            return Err(std::io::Error::other(format!(
                "bad route id {:?}",
                route.id
            )));
        }
        let tmp = self.dir.join(format!(".{}.json.tmp", route.id));
        write_private(&tmp, &serde_json::to_vec_pretty(route)?)?;
        std::fs::rename(tmp, self.dir.join(format!("{}.json", route.id)))?;
        std::fs::File::open(&self.dir)?.sync_all()
    }

    /// Every route on disk. A route saved by a ferry-route from before parts (no `parts`) is left
    /// where it is and not resumed: its swaps run on in ferryd without the router, and its ZEC
    /// waits in the leg-2 wallet. Any other file that doesn't read is an error.
    pub fn load_all(&self) -> std::io::Result<Vec<Route>> {
        let mut out: Vec<Route> = vec![];
        for entry in std::fs::read_dir(&self.dir)? {
            let path = entry?.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if path.extension().is_some_and(|e| e == "json") && !name.starts_with('.') {
                let bad = |e: serde_json::Error| {
                    std::io::Error::other(format!("{}: {e}", path.display()))
                };
                let v: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&path)?).map_err(bad)?;
                if v.get("parts").is_none() && v.get("legs").is_some() {
                    tracing::warn!(
                        "{} was saved by an older ferry-route (one swap per leg); it is not resumed",
                        path.display()
                    );
                    continue;
                }
                out.push(serde_json::from_value(v).map_err(bad)?);
            }
        }
        out.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        Ok(out)
    }
}

/// Route ids are generated here: `r` and lowercase hex.
pub fn valid_id(id: &str) -> bool {
    (2..=40).contains(&id.len())
        && id.starts_with('r')
        && id[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Create `dir` (and parents) and restrict it to the owner.
pub fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write a fresh owner-only (0600) file at `path`, replacing a stale one. Created with
/// `create_new`, so its mode is never looser than 0600, not even briefly.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route::tests::new_route;
    use crate::route::Policy;

    #[test]
    fn saves_loads_and_replaces() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let mut r = new_route(&Policy::default());
        store.save(&r).unwrap();
        r.parts[1].not_before = Some(42);
        store.save(&r).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all, vec![r]);
        // A leftover temp file from a crash mid-write is ignored.
        std::fs::write(tmp.path().join("routes/.rdead.json.tmp"), b"{").unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
        // A route from before parts is left alone, not resumed; a broken one is an error.
        std::fs::write(
            tmp.path().join("routes/rold.json"),
            br#"{"id": "rold", "legs": [{}, {}], "phase": "leg2"}"#,
        )
        .unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
        std::fs::write(
            tmp.path().join("routes/rbad.json"),
            br#"{"id": "rbad", "parts": 3}"#,
        )
        .unwrap();
        assert!(store.load_all().is_err());
    }

    #[test]
    fn ids_are_checked() {
        assert!(valid_id("r0123456789abcdef"));
        assert!(!valid_id("../x") && !valid_id("r") && !valid_id("R01") && !valid_id("r01/2"));
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let mut r = new_route(&Policy::default());
        r.id = "../escape".into();
        assert!(store.save(&r).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_and_never_partial() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let store = Store::open(&data).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&data), mode(&data.join("routes"))), (0o700, 0o700));
        let r = new_route(&Policy::default());
        store.save(&r).unwrap();
        assert_eq!(mode(&data.join(format!("routes/{}.json", r.id))), 0o600);

        let routes = data.join("routes");
        std::fs::set_permissions(&routes, std::fs::Permissions::from_mode(0o500)).unwrap();
        let mut r2 = r.clone();
        r2.parts[1].not_before = Some(1);
        assert!(
            store.save(&r2).is_err(),
            "a read-only directory surfaces as an error"
        );
        std::fs::set_permissions(&routes, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            store.load_all().unwrap(),
            vec![r],
            "the old record is intact"
        );
    }
}
