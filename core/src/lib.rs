//! Core of the Yamcs packet viewer: the functionality of the Java packet viewer
//! (`yamcs/packet-viewer`) without the UI, on top of xtce-rs.

pub mod config;
pub mod filter;
pub mod hexdump;
pub mod prepro;
pub mod split;
pub mod timefmt;
pub mod viewer;
