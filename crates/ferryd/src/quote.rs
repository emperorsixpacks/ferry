//! Firm quotes: a maker's signed price for one amount bucket, good for a few seconds.
//!
//! Intent-style, settled by the same atomic swap. The taker's UI server asks its allowlisted makers
//! `POST /peer/quote {pair, taker_role, bucket_zat}`; each answers with a quote signed by its quote
//! key (`quote_key` in its offer); the taker proposes naming the best quote's id, and the maker
//! holds that proposal to the quote's rate and range until the quote expires. Nobody holds funds in
//! between: settlement is the swap, as before.
//!
//! Privacy: a request carries a bucket (the amount rounded UP to the next of [`BUCKETS_ZAT`]), never
//! the amount, and nothing about the user: no address, swap id, URL or name. The maker the swap goes
//! to learns the exact amount from the proposal, as it always did; the others learn a bucket and a
//! time.
//!
//! Signature: ECDSA over secp256k1 (compact r||s, low S) on SHA-256 of [`Quote::signing_text`],
//! which is domain-separated and has one `key=value` field per line. ECDSA rather than BIP340 so the
//! UI server can check it with Node's built-in crypto, without a dependency.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use ferry_btc::bitcoin::secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1, SecretKey};
use ferry_core::{Role, ZecLeg};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::{checked_btc_for, Offer};
use crate::daemon::{ApiError, Daemon};

/// The buckets a request may name, in zatoshi: 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100 ZEC.
/// A 1-2.5-5 series: each bucket is 2 to 2.5 times the one below, so a partner learns the order of
/// magnitude and no more, and a maker never sets aside more than 2.5 times what the swap needs.
/// Above 100 ZEC there is no firm quote; the indicative offer still applies.
pub const BUCKETS_ZAT: [u64; 10] = [
    10_000_000,
    25_000_000,
    50_000_000,
    100_000_000,
    250_000_000,
    500_000_000,
    1_000_000_000,
    2_500_000_000,
    5_000_000_000,
    10_000_000_000,
];

/// How long a quote is good for, by default (`--maker-quote-secs`).
pub const QUOTE_TTL: Duration = Duration::from_secs(45);
/// Quote requests per requesting address per minute.
pub const ASKS_PER_PEER_PER_MINUTE: usize = 20;
/// Quote requests per minute in all.
pub const ASKS_PER_MINUTE: usize = 240;
/// Unexpired, untaken quotes per requesting address.
pub const OPEN_PER_PEER: usize = 6;
/// Unexpired, untaken quotes in all.
pub const MAX_OPEN: usize = 32;
/// A quote is remembered this long after it expires, so a late or repeated proposal is refused as
/// "expired" or "used" rather than "unknown".
const KEEP_AFTER_EXPIRY: Duration = Duration::from_secs(600);
const SIGNING_TAG: &str = "ferry-quote/1";

/// The bucket `zat` rounds up into: (the bucket below it, or 0; the bucket). None for 0 and above
/// the largest bucket.
pub fn bucket_for(zat: u64) -> Option<(u64, u64)> {
    if zat == 0 {
        return None;
    }
    let i = BUCKETS_ZAT.iter().position(|&b| zat <= b)?;
    Some((if i == 0 { 0 } else { BUCKETS_ZAT[i - 1] }, BUCKETS_ZAT[i]))
}

/// `POST /peer/quote`
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuoteRequest {
    /// "ZEC/BTC", "ZEC/USDC"...
    pub pair: String,
    /// The taker's role: `Z` sells ZEC, `B` buys it.
    pub taker_role: Role,
    /// One of [`BUCKETS_ZAT`]: the amount rounded up, never the amount.
    pub bucket_zat: u64,
}

/// What a maker commits to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    /// Format version: 1.
    pub v: u8,
    /// 16 random bytes, hex.
    pub quote_id: String,
    pub pair: String,
    /// The exact market: `btc:regtest`, `ltc:regtest`, or `evm:<chain id>:<token address>`.
    pub market: String,
    pub maker_role: Role,
    pub taker_role: Role,
    /// Counter-coin base units per ZEC, as in the offer.
    pub rate_sat_per_zec: u64,
    /// The amounts the quote covers, inclusive: the bucket, within the maker's range and balance.
    pub min_zat: u64,
    pub max_zat: u64,
    /// Unix seconds, by the maker's clock (the maker enforces expiry with its own monotonic clock).
    pub issued_at: u64,
    pub expires_at: u64,
}

/// `POST /peer/quote` → a quote and the maker's signature on it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedQuote {
    #[serde(flatten)]
    pub quote: Quote,
    /// The maker's quote key (compressed secp256k1, hex): `quote_key` in its offer.
    pub maker_key: String,
    /// ECDSA signature (compact r||s, hex) on SHA-256 of [`Quote::signing_text`].
    pub sig: String,
}

fn safe_field(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/:._-".contains(&b))
}

impl Quote {
    /// The text the maker signs. Every string field is checked to be one plain token
    /// ([`Quote::well_formed`]), so no two quotes have the same text.
    pub fn signing_text(&self) -> String {
        format!(
            "{SIGNING_TAG}\nv={}\nquote_id={}\npair={}\nmarket={}\nmaker_role={}\ntaker_role={}\n\
             rate_sat_per_zec={}\nmin_zat={}\nmax_zat={}\nissued_at={}\nexpires_at={}",
            self.v,
            self.quote_id,
            self.pair,
            self.market,
            self.maker_role.as_str(),
            self.taker_role.as_str(),
            self.rate_sat_per_zec,
            self.min_zat,
            self.max_zat,
            self.issued_at,
            self.expires_at
        )
    }

    pub fn well_formed(&self) -> bool {
        self.v == 1
            && self.quote_id.len() == 32
            && self.quote_id.bytes().all(|b| b.is_ascii_hexdigit())
            && safe_field(&self.pair)
            && safe_field(&self.market)
            && self.maker_role != self.taker_role
            && self.min_zat <= self.max_zat
            && self.issued_at <= self.expires_at
    }

    fn digest(&self) -> Message {
        Message::from_digest(Sha256::digest(self.signing_text().as_bytes()).into())
    }
}

/// The maker's quote signing key, kept at `<data-dir>/quote-key` (hex, mode 0600). It signs quotes
/// and nothing else; it holds no funds.
pub struct QuoteKey {
    secret: SecretKey,
    public: PublicKey,
}

impl std::fmt::Debug for QuoteKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "QuoteKey({})", self.public_hex())
    }
}

impl QuoteKey {
    pub fn from_secret_bytes(bytes: &[u8; 32]) -> Option<QuoteKey> {
        let secret = SecretKey::from_slice(bytes).ok()?;
        let public = PublicKey::from_secret_key(&Secp256k1::new(), &secret);
        Some(QuoteKey { secret, public })
    }

    pub fn generate() -> QuoteKey {
        loop {
            let mut b = [0u8; 32];
            OsRng.fill_bytes(&mut b);
            if let Some(k) = QuoteKey::from_secret_bytes(&b) {
                return k;
            }
        }
    }

    /// The key in `path`, or a new one written there. A file that is there but unreadable is an
    /// error, never silently replaced (takers know the key from the offer).
    pub fn load_or_create(path: &Path) -> anyhow::Result<QuoteKey> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let bytes: [u8; 32] = hex::decode(text.trim())
                    .ok()
                    .and_then(|v| v.try_into().ok())
                    .with_context(|| format!("{} must hold a 32-byte hex key", path.display()))?;
                QuoteKey::from_secret_bytes(&bytes)
                    .with_context(|| format!("{} is not a valid secp256k1 key", path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)
                        .with_context(|| format!("creating {}", dir.display()))?;
                }
                let key = QuoteKey::generate();
                crate::record::write_private(
                    path,
                    hex::encode(key.secret.secret_bytes()).as_bytes(),
                )
                .with_context(|| format!("writing {}", path.display()))?;
                Ok(key)
            }
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Compressed public key, hex: what the offer publishes as `quote_key`.
    pub fn public_hex(&self) -> String {
        hex::encode(self.public.serialize())
    }

    pub fn sign(&self, quote: Quote) -> SignedQuote {
        let sig = Secp256k1::new().sign_ecdsa(&quote.digest(), &self.secret);
        SignedQuote {
            maker_key: self.public_hex(),
            sig: hex::encode(sig.serialize_compact()),
            quote,
        }
    }
}

/// Whether `sq` is well formed and signed by `key_hex` (a compressed public key, hex).
pub fn verify(sq: &SignedQuote, key_hex: &str) -> Result<(), QuoteError> {
    if !sq.maker_key.eq_ignore_ascii_case(key_hex) {
        return Err(QuoteError::BadSignature);
    }
    if !sq.quote.well_formed() {
        return Err(QuoteError::Mismatch("it is not a well-formed quote"));
    }
    let key = hex::decode(key_hex)
        .ok()
        .and_then(|b| PublicKey::from_slice(&b).ok())
        .ok_or(QuoteError::BadSignature)?;
    let mut sig = hex::decode(&sq.sig)
        .ok()
        .and_then(|b| Signature::from_compact(&b).ok())
        .ok_or(QuoteError::BadSignature)?;
    sig.normalize_s();
    Secp256k1::verification_only()
        .verify_ecdsa(&sq.quote.digest(), &sig, &key)
        .map_err(|_| QuoteError::BadSignature)
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum QuoteError {
    // asking for a quote
    #[error("firm quotes are asked for by bucket (0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50 or 100 ZEC), not by amount")]
    NotABucket,
    #[error("this maker swaps {0}")]
    WrongPair(String),
    #[error("this maker quotes takers with role {0}")]
    WrongRole(&'static str),
    #[error("not making offers")]
    NotMaking,
    #[error("busy with another swap; ask again when it is done")]
    Busy,
    #[error("this maker's swaps are {0}")]
    OutsideOffer(String),
    #[error("not enough liquidity for this bucket right now")]
    NoLiquidity,
    #[error("too many quote requests; try again in a minute")]
    RateLimited,
    #[error("too many open quotes; try again when some have expired")]
    TooManyOpen,
    // proposing with one
    #[error("unknown firm quote (it expired a while ago, or the maker restarted); get a new one")]
    Unknown,
    #[error("the firm quote expired; get a new one")]
    Expired,
    #[error("the firm quote was already used for another swap")]
    Used,
    #[error("the amount is outside the firm quote's range")]
    OutOfRange,
    #[error("the amount does not match the firm quote's rate")]
    WrongAmount,
    #[error("the firm quote is for the other side of the swap")]
    WrongTaker,
    // the taker's checks
    #[error("this maker does not sign firm quotes")]
    NoKey,
    #[error("the firm quote is not signed by this maker")]
    BadSignature,
    #[error("the firm quote does not match this maker's offer: {0}")]
    Mismatch(&'static str),
}

impl QuoteError {
    pub fn status(&self) -> u16 {
        match self {
            QuoteError::NotMaking => 403,
            QuoteError::Busy | QuoteError::NoLiquidity | QuoteError::TooManyOpen => 409,
            QuoteError::RateLimited => 429,
            _ => 400,
        }
    }
}

impl From<QuoteError> for ApiError {
    fn from(e: QuoteError) -> ApiError {
        ApiError(e.status(), e.to_string())
    }
}

/// The maker's offer as it stands, for issuing a quote.
#[derive(Clone, Debug)]
pub struct MakerState {
    pub pair: String,
    pub market: String,
    pub role: Role,
    pub making: bool,
    /// A swap is in progress: the daemon runs one at a time, so no quote could be honoured.
    pub busy: bool,
    pub rate: u64,
    pub min_zat: u64,
    pub max_zat: u64,
    /// The most ZEC the balance covers now (None: not known yet).
    pub liquidity_zat: Option<u64>,
}

struct Entry {
    quote: Quote,
    peer: Option<IpAddr>,
    expires: Instant,
    /// The session id of the swap that took it.
    used_by: Option<String>,
}

#[derive(Default)]
struct Book {
    open: HashMap<String, Entry>,
    asks: HashMap<Option<IpAddr>, VecDeque<Instant>>,
    all_asks: VecDeque<Instant>,
}

/// A maker's quotes: issues them, and holds proposals that name one to its terms.
///
/// ferryd runs one swap at a time, so quotes never compete for the same coins at once: each is only
/// issued when the maker's balance covers its whole range, none while a swap is in progress, and at
/// most [`MAX_OPEN`] ([`OPEN_PER_PEER`] per requesting address) are open at a time. If two open
/// quotes are taken at the same moment, the second proposal is refused as busy.
pub struct QuoteBook {
    key: QuoteKey,
    ttl: Duration,
    book: Mutex<Book>,
}

fn window(q: &mut VecDeque<Instant>, now: Instant) {
    while q
        .front()
        .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
    {
        q.pop_front();
    }
}

impl QuoteBook {
    pub fn new(key: QuoteKey, ttl: Duration) -> QuoteBook {
        QuoteBook {
            key,
            ttl,
            book: Mutex::new(Book::default()),
        }
    }

    pub fn public_key(&self) -> String {
        self.key.public_hex()
    }

    fn prune(b: &mut Book, now: Instant) {
        b.open
            .retain(|_, e| now.saturating_duration_since(e.expires) < KEEP_AFTER_EXPIRY);
        window(&mut b.all_asks, now);
        b.asks.retain(|_, q| {
            window(q, now);
            !q.is_empty()
        });
    }

    /// Answer a quote request from `peer` (its IP, when known).
    pub fn issue(
        &self,
        req: &QuoteRequest,
        m: &MakerState,
        peer: Option<IpAddr>,
        now: Instant,
        unix: u64,
    ) -> Result<SignedQuote, QuoteError> {
        let mut b = self.book.lock().expect("not poisoned");
        Self::prune(&mut b, now);
        // every request counts, refused or not
        let mine = b.asks.entry(peer).or_default();
        if mine.len() >= ASKS_PER_PEER_PER_MINUTE {
            return Err(QuoteError::RateLimited);
        }
        mine.push_back(now);
        if b.all_asks.len() >= ASKS_PER_MINUTE {
            return Err(QuoteError::RateLimited);
        }
        b.all_asks.push_back(now);

        let (lower, bucket) = bucket_for(req.bucket_zat)
            .filter(|&(_, top)| top == req.bucket_zat)
            .ok_or(QuoteError::NotABucket)?;
        if !req.pair.eq_ignore_ascii_case(&m.pair) {
            return Err(QuoteError::WrongPair(m.pair.clone()));
        }
        if req.taker_role != m.role.peer() {
            return Err(QuoteError::WrongRole(m.role.peer().as_str()));
        }
        if !m.making {
            return Err(QuoteError::NotMaking);
        }
        if m.busy {
            return Err(QuoteError::Busy);
        }
        if bucket < m.min_zat || lower >= m.max_zat {
            return Err(QuoteError::OutsideOffer(format!(
                "{} to {} ZEC",
                zec_text(m.min_zat),
                zec_text(m.max_zat)
            )));
        }
        // the amounts covered: the bucket, within the offer's range and what the balance fills
        let min = lower.max(m.min_zat);
        let max = bucket.min(m.max_zat).min(m.liquidity_zat.unwrap_or(0));
        if max < min || (lower > 0 && max <= lower) {
            return Err(QuoteError::NoLiquidity);
        }
        // the counter amount of the largest swap must fit (u64 base units: 18.4 WETH)
        if checked_btc_for(max, m.rate).is_none() || m.rate == 0 {
            return Err(QuoteError::NoLiquidity);
        }
        let live = |e: &Entry| e.used_by.is_none() && now < e.expires;
        if b.open.values().filter(|e| live(e)).count() >= MAX_OPEN {
            return Err(QuoteError::TooManyOpen);
        }
        if b.open
            .values()
            .filter(|e| live(e) && e.peer == peer)
            .count()
            >= OPEN_PER_PEER
        {
            return Err(QuoteError::TooManyOpen);
        }

        let mut id = [0u8; 16];
        OsRng.fill_bytes(&mut id);
        let quote = Quote {
            v: 1,
            quote_id: hex::encode(id),
            pair: m.pair.clone(),
            market: m.market.clone(),
            maker_role: m.role,
            taker_role: req.taker_role,
            rate_sat_per_zec: m.rate,
            min_zat: min,
            max_zat: max,
            issued_at: unix,
            expires_at: unix + self.ttl.as_secs(),
        };
        b.open.insert(
            quote.quote_id.clone(),
            Entry {
                quote: quote.clone(),
                peer,
                expires: now + self.ttl,
                used_by: None,
            },
        );
        Ok(self.key.sign(quote))
    }

    /// A proposal names `quote_id`: take the quote for swap `session` if the proposal keeps to it.
    /// The returned claim gives the quote back when dropped, unless committed once the swap is
    /// accepted: one quote, one swap.
    pub fn claim(
        &self,
        quote_id: &str,
        session: &str,
        taker: Role,
        zec_amount: u64,
        counter_amount: u64,
        now: Instant,
    ) -> Result<Claim<'_>, QuoteError> {
        let mut b = self.book.lock().expect("not poisoned");
        Self::prune(&mut b, now);
        let e = b.open.get_mut(quote_id).ok_or(QuoteError::Unknown)?;
        match &e.used_by {
            Some(s) if s != session => return Err(QuoteError::Used),
            _ => {}
        }
        if now >= e.expires {
            return Err(QuoteError::Expired);
        }
        let q = &e.quote;
        if taker != q.taker_role {
            return Err(QuoteError::WrongTaker);
        }
        if zec_amount < q.min_zat || zec_amount > q.max_zat {
            return Err(QuoteError::OutOfRange);
        }
        if checked_btc_for(zec_amount, q.rate_sat_per_zec) != Some(counter_amount) {
            return Err(QuoteError::WrongAmount);
        }
        // a retry by the swap that already took it gives nothing back if it fails
        let fresh = e.used_by.is_none();
        e.used_by = Some(session.to_string());
        Ok(Claim {
            book: self,
            id: quote_id.to_string(),
            done: !fresh,
        })
    }

    fn release(&self, id: &str) {
        if let Some(e) = self.book.lock().expect("not poisoned").open.get_mut(id) {
            e.used_by = None;
        }
    }
}

/// A quote taken by a proposal that is still being accepted.
pub struct Claim<'a> {
    book: &'a QuoteBook,
    id: String,
    done: bool,
}

impl Claim<'_> {
    /// The swap was accepted: the quote is used for good.
    pub fn commit(mut self) {
        self.done = true;
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.book.release(&self.id);
        }
    }
}

/// The maker's offer as a taker just fetched it, for checking a quote against.
pub struct OfferRef<'a> {
    pub pair: String,
    pub market: String,
    pub role: Role,
    pub quote_key: Option<&'a str>,
}

/// Taker: `sq` is signed by the key in the maker's offer, names that offer's market and our role,
/// and covers `zec_zat`. Returns the quote's rate. Expiry is left to the maker, whose clock and book
/// decide it; a quote it no longer honours is refused with a clear error.
pub fn check_for_taker(
    sq: &SignedQuote,
    offer: &OfferRef<'_>,
    taker: Role,
    zec_zat: u64,
) -> Result<u64, QuoteError> {
    let key = offer.quote_key.ok_or(QuoteError::NoKey)?;
    verify(sq, key)?;
    let q = &sq.quote;
    if q.pair != offer.pair || q.market != offer.market {
        return Err(QuoteError::Mismatch("another pair or market"));
    }
    if q.maker_role != offer.role || q.taker_role != taker {
        return Err(QuoteError::WrongTaker);
    }
    if zec_zat < q.min_zat || zec_zat > q.max_zat {
        return Err(QuoteError::OutOfRange);
    }
    if checked_btc_for(zec_zat, q.rate_sat_per_zec).is_none() {
        return Err(QuoteError::WrongAmount);
    }
    Ok(q.rate_sat_per_zec)
}

fn zec_text(zat: u64) -> String {
    let s = format!("{:.8}", zat as f64 / 1e8);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The requesting peer's IP, when the listener records it (`into_make_service_with_connect_info`).
pub struct PeerIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for PeerIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(PeerIp(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip()),
        ))
    }
}

/// `<data-dir>/quote-key`, for a daemon that makes offers.
pub fn maker_book(cli: &crate::config::Cli) -> anyhow::Result<Option<QuoteBook>> {
    if cli.maker_offer.is_none() {
        return Ok(None);
    }
    let key = QuoteKey::load_or_create(&cli.data_dir.join("quote-key"))?;
    Ok(Some(QuoteBook::new(
        key,
        Duration::from_secs(cli.maker_quote_secs),
    )))
}

impl Offer {
    /// The exact market a quote names: `btc:regtest`, `ltc:main`...
    pub fn market(&self) -> String {
        format!(
            "{}:{}",
            self.coin.ticker().to_ascii_lowercase(),
            self.network
        )
    }

    pub fn quote_ref(&self) -> OfferRef<'_> {
        OfferRef {
            pair: self.pair(),
            market: self.market(),
            role: self.role,
            quote_key: self.quote_key.as_deref(),
        }
    }
}

// The Bitcoin daemon's side. Kept here so daemon.rs only calls these.
impl<L: ZecLeg + 'static> Daemon<L> {
    /// `POST /peer/quote`
    pub async fn issue_quote(
        &self,
        req: QuoteRequest,
        peer: Option<IpAddr>,
    ) -> Result<SignedQuote, ApiError> {
        let book = self.quotes.as_ref().ok_or(QuoteError::NotMaking)?;
        let offer = self.offer_now().await;
        let busy = self
            .state
            .lock()
            .await
            .swaps
            .values()
            .any(|r| !r.swap.is_final());
        let m = MakerState {
            pair: offer.pair(),
            market: offer.market(),
            role: offer.role,
            making: offer.making,
            busy,
            rate: offer.rate_sat_per_zec,
            min_zat: offer.min_zat,
            max_zat: offer.max_zat,
            liquidity_zat: offer.liquidity.map(|l| l.zec_zat),
        };
        let unix = crate::pricefeed::unix_now();
        Ok(book.issue(&req, &m, peer, Instant::now(), unix)?)
    }

    /// Maker: the quote a proposal names, taken for this swap (None: the proposal names none).
    pub fn claim_quote(
        &self,
        quote_id: Option<&str>,
        session: &str,
        taker: Role,
        zec_amount: u64,
        counter_amount: u64,
    ) -> Result<Option<Claim<'_>>, ApiError> {
        let Some(id) = quote_id else {
            return Ok(None);
        };
        let book = self.quotes.as_ref().ok_or(QuoteError::Unknown)?;
        Ok(Some(book.claim(
            id,
            session,
            taker,
            zec_amount,
            counter_amount,
            Instant::now(),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> QuoteKey {
        QuoteKey::from_secret_bytes(&[7u8; 32]).unwrap()
    }

    fn maker() -> MakerState {
        MakerState {
            pair: "ZEC/BTC".into(),
            market: "btc:regtest".into(),
            role: Role::B,
            making: true,
            busy: false,
            rate: 410_000,
            min_zat: 10_000_000,
            max_zat: 1_000_000_000,
            liquidity_zat: Some(240_000_000),
        }
    }

    fn ask(bucket: u64) -> QuoteRequest {
        QuoteRequest {
            pair: "ZEC/BTC".into(),
            taker_role: Role::Z,
            bucket_zat: bucket,
        }
    }

    const PEER: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 5)));

    fn book() -> QuoteBook {
        QuoteBook::new(key(), QUOTE_TTL)
    }

    #[test]
    fn buckets_round_up() {
        assert_eq!(bucket_for(0), None);
        assert_eq!(bucket_for(1), Some((0, 10_000_000)));
        assert_eq!(bucket_for(10_000_000), Some((0, 10_000_000)));
        assert_eq!(bucket_for(10_000_001), Some((10_000_000, 25_000_000)));
        assert_eq!(bucket_for(70_000_000), Some((50_000_000, 100_000_000)));
        assert_eq!(bucket_for(100_000_000), Some((50_000_000, 100_000_000)));
        assert_eq!(
            bucket_for(10_000_000_000),
            Some((5_000_000_000, 10_000_000_000))
        );
        assert_eq!(bucket_for(10_000_000_001), None);
        // a 1-2.5-5 series: never more than 2.5x the bucket below
        for w in BUCKETS_ZAT.windows(2) {
            assert!(w[1] * 2 >= w[0] * 4 && w[1] * 2 <= w[0] * 5, "{w:?}");
        }
    }

    #[test]
    fn sign_and_verify() {
        let k = key();
        let sq = book()
            .issue(&ask(100_000_000), &maker(), PEER, Instant::now(), 1_000)
            .unwrap();
        assert_eq!(sq.maker_key, k.public_hex());
        verify(&sq, &k.public_hex()).unwrap();
        verify(&sq, &k.public_hex().to_uppercase()).unwrap();
        // every field is covered
        let tampered: [fn(&mut Quote); 9] = [
            |q| q.rate_sat_per_zec += 1,
            |q| q.max_zat += 1,
            |q| q.min_zat -= 1,
            |q| q.expires_at += 1,
            |q| q.issued_at -= 1,
            |q| q.quote_id = "00".repeat(16),
            |q| q.pair = "ZEC/LTC".into(),
            |q| q.market = "btc:main".into(),
            |q| q.taker_role = Role::B,
        ];
        for t in tampered {
            let mut bad = sq.clone();
            t(&mut bad.quote);
            assert!(verify(&bad, &k.public_hex()).is_err(), "{:?}", bad.quote);
        }
        // another maker's key, a mangled signature
        let other = QuoteKey::from_secret_bytes(&[8u8; 32]).unwrap();
        assert_eq!(
            verify(&sq, &other.public_hex()),
            Err(QuoteError::BadSignature)
        );
        let mut forged = other.sign(sq.quote.clone());
        assert!(verify(&forged, &k.public_hex()).is_err());
        forged.maker_key = k.public_hex();
        assert_eq!(
            verify(&forged, &k.public_hex()),
            Err(QuoteError::BadSignature)
        );
        let mut garbled = sq.clone();
        garbled.sig = "zz".into();
        assert_eq!(
            verify(&garbled, &k.public_hex()),
            Err(QuoteError::BadSignature)
        );
        // a field smuggling a newline is refused before any signature check
        let mut odd = sq.quote.clone();
        odd.pair = "ZEC/BTC\nmarket=x".into();
        assert!(!odd.well_formed());
        assert!(verify(&k.sign(odd), &k.public_hex()).is_err());
        // the wire form round-trips, flat
        let json = serde_json::to_value(&sq).unwrap();
        assert_eq!(json["rate_sat_per_zec"], 410_000);
        assert!(json.get("quote").is_none());
        let back: SignedQuote = serde_json::from_value(json).unwrap();
        verify(&back, &k.public_hex()).unwrap();
    }

    /// A fixed vector, also checked by the UI server's verifier (web/server/quotes.mjs).
    #[test]
    fn signing_text_is_stable() {
        let q = Quote {
            v: 1,
            quote_id: "0123456789abcdef0123456789abcdef".into(),
            pair: "ZEC/BTC".into(),
            market: "btc:regtest".into(),
            maker_role: Role::B,
            taker_role: Role::Z,
            rate_sat_per_zec: 410_000,
            min_zat: 50_000_000,
            max_zat: 100_000_000,
            issued_at: 1_792_400_000,
            expires_at: 1_792_400_045,
        };
        assert_eq!(
            q.signing_text(),
            "ferry-quote/1\nv=1\nquote_id=0123456789abcdef0123456789abcdef\npair=ZEC/BTC\n\
             market=btc:regtest\nmaker_role=B\ntaker_role=Z\nrate_sat_per_zec=410000\n\
             min_zat=50000000\nmax_zat=100000000\nissued_at=1792400000\nexpires_at=1792400045"
        );
        let sq = key().sign(q);
        // RFC 6979 nonces: the same key and quote always give this signature
        assert_eq!(
            sq.maker_key,
            "02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f"
        );
        assert_eq!(
            sq.sig,
            "349f4c95e5687e036604e2d771c6b466578b026e62f28c5bfbff06427ccf017e\
             22ff9af410bc3b2163ffa9f991a613ab83a2f643bc401426ff884b83aee60d3f"
        );
        verify(&sq, &sq.maker_key.clone()).unwrap();
    }

    #[test]
    fn quotes_cover_the_bucket_within_the_offer() {
        let b = book();
        let now = Instant::now();
        // 1 ZEC bucket: 0.5 to 1 ZEC
        let q = b
            .issue(&ask(100_000_000), &maker(), PEER, now, 1)
            .unwrap()
            .quote;
        assert_eq!((q.min_zat, q.max_zat), (50_000_000, 100_000_000));
        assert_eq!(q.expires_at - q.issued_at, QUOTE_TTL.as_secs());
        assert_eq!((q.maker_role, q.taker_role), (Role::B, Role::Z));
        // 2.5 ZEC bucket, 2.4 ZEC of liquidity: 1 to 2.4 ZEC
        let q = b
            .issue(&ask(250_000_000), &maker(), PEER, now, 1)
            .unwrap()
            .quote;
        assert_eq!((q.min_zat, q.max_zat), (100_000_000, 240_000_000));
        // 5 ZEC bucket: the balance covers none of 2.5 to 5 ZEC
        assert_eq!(
            b.issue(&ask(500_000_000), &maker(), PEER, now, 1)
                .unwrap_err(),
            QuoteError::NoLiquidity
        );
        // the smallest bucket starts at the maker's minimum
        let q = b
            .issue(&ask(10_000_000), &maker(), PEER, now, 1)
            .unwrap()
            .quote;
        assert_eq!((q.min_zat, q.max_zat), (10_000_000, 10_000_000));
        // outside the offer's range
        let mut m = maker();
        m.min_zat = 300_000_000;
        assert!(matches!(
            b.issue(&ask(100_000_000), &m, PEER, now, 1),
            Err(QuoteError::OutsideOffer(_))
        ));
        let mut m = maker();
        m.max_zat = 50_000_000;
        assert!(matches!(
            b.issue(&ask(100_000_000), &m, PEER, now, 1),
            Err(QuoteError::OutsideOffer(_))
        ));
        // unknown liquidity: no firm quote
        let mut m = maker();
        m.liquidity_zat = None;
        assert_eq!(
            b.issue(&ask(100_000_000), &m, PEER, now, 1).unwrap_err(),
            QuoteError::NoLiquidity
        );
    }

    #[test]
    fn requests_that_are_refused() {
        let b = book();
        let now = Instant::now();
        // an exact amount is not a bucket
        assert_eq!(
            b.issue(&ask(70_000_000), &maker(), PEER, now, 1)
                .unwrap_err(),
            QuoteError::NotABucket
        );
        assert_eq!(
            b.issue(&ask(20_000_000_000), &maker(), PEER, now, 1)
                .unwrap_err(),
            QuoteError::NotABucket
        );
        let mut r = ask(100_000_000);
        r.pair = "ZEC/LTC".into();
        assert!(matches!(
            b.issue(&r, &maker(), PEER, now, 1),
            Err(QuoteError::WrongPair(_))
        ));
        // a B taker asks a B maker
        let mut r = ask(100_000_000);
        r.taker_role = Role::B;
        assert_eq!(
            b.issue(&r, &maker(), PEER, now, 1).unwrap_err(),
            QuoteError::WrongRole("Z")
        );
        // ...but a Z maker quotes it (buying ZEC)
        let mut z = maker();
        z.role = Role::Z;
        z.liquidity_zat = Some(500_000_000);
        let q = b.issue(&r, &z, PEER, now, 1).unwrap().quote;
        assert_eq!((q.maker_role, q.taker_role), (Role::Z, Role::B));
        let mut m = maker();
        m.making = false;
        assert_eq!(
            b.issue(&ask(100_000_000), &m, PEER, now, 1).unwrap_err(),
            QuoteError::NotMaking
        );
        let mut m = maker();
        m.busy = true;
        assert_eq!(
            b.issue(&ask(100_000_000), &m, PEER, now, 1).unwrap_err(),
            QuoteError::Busy
        );
        assert_eq!(QuoteError::Busy.status(), 409);
        assert_eq!(QuoteError::RateLimited.status(), 429);
        assert_eq!(QuoteError::Expired.status(), 400);
    }

    #[test]
    fn rate_limit_and_open_caps() {
        let b = book();
        let t0 = Instant::now();
        // 6 open quotes per peer...
        for _ in 0..OPEN_PER_PEER {
            b.issue(&ask(100_000_000), &maker(), PEER, t0, 1).unwrap();
        }
        assert_eq!(
            b.issue(&ask(100_000_000), &maker(), PEER, t0, 1)
                .unwrap_err(),
            QuoteError::TooManyOpen
        );
        // ...another peer is not held up by them
        let other = Some(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 6)));
        b.issue(&ask(100_000_000), &maker(), other, t0, 1).unwrap();
        // once they expire the peer may ask again
        let later = t0 + QUOTE_TTL;
        b.issue(&ask(100_000_000), &maker(), PEER, later, 1)
            .unwrap();
        // 20 requests a minute per peer, refused ones included
        let peer3 = Some(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 7)));
        for _ in 0..ASKS_PER_PEER_PER_MINUTE {
            let _ = b.issue(&ask(70_000_000), &maker(), peer3, t0, 1);
        }
        assert_eq!(
            b.issue(&ask(100_000_000), &maker(), peer3, t0, 1)
                .unwrap_err(),
            QuoteError::RateLimited
        );
        let next_minute = t0 + Duration::from_secs(61);
        b.issue(&ask(100_000_000), &maker(), peer3, next_minute, 1)
            .unwrap();
        // the global cap
        let b = book();
        for i in 0..ASKS_PER_MINUTE {
            let ip = Some(IpAddr::V4(std::net::Ipv4Addr::from(i as u32 + 1)));
            let _ = b.issue(&ask(70_000_000), &maker(), ip, t0, 1);
        }
        assert_eq!(
            b.issue(&ask(100_000_000), &maker(), None, t0, 1)
                .unwrap_err(),
            QuoteError::RateLimited
        );
    }

    #[test]
    fn honoured_within_the_bucket_before_expiry() {
        let b = book();
        let t0 = Instant::now();
        let q = b
            .issue(&ask(100_000_000), &maker(), PEER, t0, 1)
            .unwrap()
            .quote;
        let id = q.quote_id.as_str();
        let btc = |zat| checked_btc_for(zat, q.rate_sat_per_zec).unwrap();
        // outside the bucket, the wrong amount, the wrong side: refused, and the quote stays good
        assert_eq!(
            b.claim(id, "s1", Role::Z, 40_000_000, btc(40_000_000), t0)
                .err(),
            Some(QuoteError::OutOfRange)
        );
        assert_eq!(
            b.claim(id, "s1", Role::Z, 100_000_001, btc(100_000_001), t0)
                .err(),
            Some(QuoteError::OutOfRange)
        );
        assert_eq!(
            b.claim(id, "s1", Role::Z, 70_000_000, btc(70_000_000) + 1, t0)
                .err(),
            Some(QuoteError::WrongAmount)
        );
        assert_eq!(
            b.claim(id, "s1", Role::B, 70_000_000, btc(70_000_000), t0)
                .err(),
            Some(QuoteError::WrongTaker)
        );
        assert_eq!(
            b.claim(
                "ab".repeat(16).as_str(),
                "s1",
                Role::Z,
                70_000_000,
                btc(70_000_000),
                t0
            )
            .err(),
            Some(QuoteError::Unknown)
        );
        // the exact amount, anywhere in the bucket, at the quote's rate (not today's)
        let t1 = t0 + Duration::from_secs(44);
        b.claim(id, "s1", Role::Z, 70_000_000, btc(70_000_000), t1)
            .unwrap()
            .commit();
        // one quote, one swap: another session can't reuse it, the same one may retry
        assert_eq!(
            b.claim(id, "s2", Role::Z, 70_000_000, btc(70_000_000), t1)
                .err(),
            Some(QuoteError::Used)
        );
        b.claim(id, "s1", Role::Z, 70_000_000, btc(70_000_000), t1)
            .unwrap()
            .commit();
    }

    #[test]
    fn expired_quotes_are_refused() {
        let b = book();
        let t0 = Instant::now();
        let q = b
            .issue(&ask(100_000_000), &maker(), PEER, t0, 1)
            .unwrap()
            .quote;
        let btc = checked_btc_for(100_000_000, q.rate_sat_per_zec).unwrap();
        let late = t0 + QUOTE_TTL;
        assert_eq!(
            b.claim(&q.quote_id, "s1", Role::Z, 100_000_000, btc, late)
                .err(),
            Some(QuoteError::Expired)
        );
        // long after, the maker has forgotten it: still refused
        let much_later = late + KEEP_AFTER_EXPIRY;
        assert_eq!(
            b.claim(&q.quote_id, "s1", Role::Z, 100_000_000, btc, much_later)
                .err(),
            Some(QuoteError::Unknown)
        );
    }

    #[test]
    fn a_failed_accept_gives_the_quote_back() {
        let b = book();
        let t0 = Instant::now();
        let q = b
            .issue(&ask(100_000_000), &maker(), PEER, t0, 1)
            .unwrap()
            .quote;
        let btc = checked_btc_for(100_000_000, q.rate_sat_per_zec).unwrap();
        {
            let _claim = b
                .claim(&q.quote_id, "s1", Role::Z, 100_000_000, btc, t0)
                .unwrap();
            // while it is being accepted, nobody else can take it
            assert_eq!(
                b.claim(&q.quote_id, "s2", Role::Z, 100_000_000, btc, t0)
                    .err(),
                Some(QuoteError::Used)
            );
            // dropped without commit: the accept failed
        }
        b.claim(&q.quote_id, "s2", Role::Z, 100_000_000, btc, t0)
            .unwrap()
            .commit();
    }

    #[test]
    fn taker_checks_against_the_offer() {
        let k = key();
        let sq = book()
            .issue(&ask(100_000_000), &maker(), PEER, Instant::now(), 1)
            .unwrap();
        let pk = k.public_hex();
        let offer = OfferRef {
            pair: "ZEC/BTC".into(),
            market: "btc:regtest".into(),
            role: Role::B,
            quote_key: Some(&pk),
        };
        assert_eq!(
            check_for_taker(&sq, &offer, Role::Z, 70_000_000),
            Ok(410_000)
        );
        assert_eq!(
            check_for_taker(&sq, &offer, Role::Z, 100_000_001),
            Err(QuoteError::OutOfRange)
        );
        assert_eq!(
            check_for_taker(&sq, &offer, Role::B, 70_000_000),
            Err(QuoteError::WrongTaker)
        );
        // the offer has no key, or another maker's
        let none = OfferRef {
            quote_key: None,
            ..offer
        };
        assert_eq!(
            check_for_taker(&sq, &none, Role::Z, 70_000_000),
            Err(QuoteError::NoKey)
        );
        let other = QuoteKey::from_secret_bytes(&[9u8; 32])
            .unwrap()
            .public_hex();
        let theirs = OfferRef {
            quote_key: Some(&other),
            pair: "ZEC/BTC".into(),
            market: "btc:regtest".into(),
            role: Role::B,
        };
        assert_eq!(
            check_for_taker(&sq, &theirs, Role::Z, 70_000_000),
            Err(QuoteError::BadSignature)
        );
        // the right key, another market (say the maker's Litecoin daemon with a copied key)
        let ltc = OfferRef {
            pair: "ZEC/LTC".into(),
            market: "ltc:regtest".into(),
            role: Role::B,
            quote_key: Some(&pk),
        };
        assert!(matches!(
            check_for_taker(&sq, &ltc, Role::Z, 70_000_000),
            Err(QuoteError::Mismatch(_))
        ));
    }

    #[test]
    fn key_file_is_kept_and_private() {
        let dir = tempfile::tempdir().unwrap();
        // a fresh data dir is created (the EVM daemon makes its key before its store)
        let path = dir.path().join("data").join("quote-key");
        let a = QuoteKey::load_or_create(&path).unwrap();
        let b = QuoteKey::load_or_create(&path).unwrap();
        assert_eq!(a.public_hex(), b.public_hex());
        assert_eq!(a.public_hex().len(), 66);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(!format!("{a:?}").contains(&std::fs::read_to_string(&path).unwrap()));
        std::fs::write(&path, "not a key").unwrap();
        assert!(QuoteKey::load_or_create(&path).is_err());
    }
}
