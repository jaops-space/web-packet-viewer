//! Times the list pass (naming), the filter and the detail decoding on the test data repeated n times.
//! cargo run --release --example bench -- [n]
use std::time::Instant;

use pv_core::{config::ViewerConfig, split::PacketReader, viewer::Viewer};

const DIR: &str = "target/golden";

fn main() {
    let n: usize = std::env::args().nth(1).map_or(100, |s| s.parse().unwrap());
    let config: ViewerConfig = serde_json::from_str(
        r#"{"fileFormats": [{"name": "CCSDS Packets", "packetInputStreamClassName": "org.yamcs.tctm.GenericPacketInputStream",
            "packetInputStreamArgs": {"lengthFieldOffset": 4, "maxPacketLength": 1500, "lengthFieldLength": 2,
            "lengthAdjustment": 7, "initialBytesToStrip": 0}}]}"#,
    )
    .unwrap();
    let mut v = Viewer::new(config).unwrap();
    v.load_mdb(&[&std::fs::read_to_string(format!("{DIR}/mdb/xtce.xml")).unwrap()]).unwrap();
    v.set_source(Some(0)).unwrap();
    let data = std::fs::read(format!("{DIR}/tm-data/testdata.ccsds")).unwrap().repeat(n);

    let t = Instant::now();
    let packets = PacketReader::new(v.file_formats()[0].splitter.clone()).push(&data).unwrap();
    let split = t.elapsed();
    let t = Instant::now();
    for p in packets {
        v.add_packet(p.data, 0);
    }
    let add = t.elapsed();
    let np = v.packet_count();
    let us = |d: std::time::Duration| d.as_secs_f64() * 1e6 / np as f64;
    println!("{} packets, {} bytes", np, data.len());
    println!("split      {:?} ({:.2} us/packet)", split, us(split));
    println!("add (name) {:?} ({:.2} us/packet)", add, us(add));

    let t = Instant::now();
    let m = v.set_filter(Some("ElapsedSeconds > 5 AND Shadow == true")).unwrap();
    let f = t.elapsed();
    println!("filter     {:?} ({:.2} us/packet), {} match", f, us(f), m);
    v.set_filter(None).unwrap();

    v.add_column("/myproject/Height");
    v.add_column("/myproject/Position");
    let t = Instant::now();
    let rows = v.rows(0, 1000);
    println!("1000 rows with 2 columns {:?} ({})", t.elapsed(), rows.len());

    let t = Instant::now();
    for nr in 1..=1000 {
        v.select(nr).unwrap();
    }
    println!("select     {:.2} us/packet", t.elapsed().as_secs_f64() * 1e6 / 1000.0);
}
