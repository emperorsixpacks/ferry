//! Firm quotes (crate::quote) on an EVM daemon: the same book and checks, with the EVM offer.

use std::net::IpAddr;
use std::time::Instant;

use ferry_core::{Role, ZecLeg};

use super::config::EvmOffer;
use super::daemon::EvmDaemon;
use crate::daemon::ApiError;
use crate::quote::{Claim, MakerState, OfferRef, QuoteError, QuoteRequest, SignedQuote};

impl EvmOffer {
    /// The exact market a quote names: `evm:<chain id>:<token address>` (lowercase hex), so a
    /// quote for USDC on one chain is never one for WETH, or for USDC on another.
    pub fn market(&self) -> String {
        format!("evm:{}:0x{}", self.chain_id, hex::encode(self.token))
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

impl<L: ZecLeg + 'static> EvmDaemon<L> {
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
        token_amount: u64,
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
            token_amount,
            Instant::now(),
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evm::config::{Counter, EvmTerms};

    fn offer(token: [u8; 20], chain_id: u64) -> EvmOffer {
        EvmOffer {
            counter: Counter::Evm,
            role: Role::B,
            chain_id,
            network: "anvil".into(),
            contract: [0x11; 20],
            token,
            token_symbol: "USDC".into(),
            token_decimals: 6,
            making: true,
            rate_sat_per_zec: 40_000_000,
            min_zat: 1,
            max_zat: 1_000_000_000,
            terms: EvmTerms {
                t1_secs: 600,
                refund_secs: 600,
                claim_margin: 60,
                refund_margin: 60,
                lock_confirmations: 1,
                zec_confirmations: 1,
                max_tip: 0,
            },
            rate_source: None,
            rate_updated_at: None,
            liquidity: None,
            paused: false,
            quote_key: None,
        }
    }

    #[test]
    fn markets_name_the_chain_and_token() {
        let base = offer([0xab; 20], 8453);
        assert_eq!(base.market(), format!("evm:8453:0x{}", "ab".repeat(20)));
        assert_ne!(base.market(), offer([0xab; 20], 42161).market());
        assert_ne!(base.market(), offer([0xcd; 20], 8453).market());
        assert_eq!(base.quote_ref().pair, "ZEC/USDC");
    }
}
