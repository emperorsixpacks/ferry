//! `ferry-route`: the privacy hub. Moves value between two non-ZEC assets by chaining two Ferry
//! swaps through Zcash's shielded pool (coin A → shielded ZEC → coin C), driving the user's own
//! two ferryd daemons through their control APIs. It holds no keys and no funds.
//!
//! - [`legs`]: the ferryd control-API contract, behind the [`legs::Ferryd`] trait.
//! - [`route`]: the route record and its pure state machine.
//! - [`store`]: one atomic, private JSON file per route.
//! - [`hub`]: the driver (observe, step, persist, act) and route creation.
//! - [`api`]: the HTTP API.

pub mod api;
#[cfg(test)]
pub(crate) mod fake;
pub mod hub;
pub mod legs;
pub mod route;
pub mod store;
pub mod view;
