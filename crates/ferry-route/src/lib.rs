//! `ferry-route`: the privacy hub. Moves value between two non-ZEC assets by chaining two Ferry
//! swaps through Zcash's shielded pool (coin A → shielded ZEC → coin C), driving the user's own
//! two ferryd daemons through their control APIs. It holds no keys and no funds.
//!
//! - [`legs`]: the ferryd control-API contract, behind the [`legs::Ferryd`] trait.
//! - [`route`]: the route record and its pure state machine.
//! - [`store`]: one atomic, private JSON file per route.

pub mod legs;
pub mod route;
pub mod store;
