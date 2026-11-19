//! Compares the viewer with the output of the Java packet viewer code (tools/golden/run.sh generates it).

use std::fmt::Write;

use pv_core::{
    config::ViewerConfig,
    split::PacketReader,
    viewer::{Calibration, TreeNode, Viewer},
};

fn tree(n: &TreeNode, depth: usize, out: &mut String) {
    writeln!(out, "  T {}{}", "  ".repeat(depth), n.label).unwrap();
    for c in &n.children {
        tree(c, depth + 1, out);
    }
}

struct Case {
    /// the Java output
    expected: &'static str,
    config: &'static str,
    xtce: &'static [&'static str],
    packets: &'static str,
    filters: &'static str,
}

/// the packet-viewer quickstart MDB and test data
#[test]
fn quickstart() {
    golden(Case {
        expected: "../target/golden.txt",
        // etc/packet-viewer.yaml, as the Yamcs plugin would send it
        config: r#"{"packetPreprocessorClassName": "org.yamcs.tctm.GenericPacketPreprocessor",
            "packetPreprocessorArgs": {"timestampOffset": -1, "seqCountOffset": -1},
            "fileFormats": [{"name": "CCSDS Packets", "packetInputStreamClassName": "org.yamcs.tctm.GenericPacketInputStream",
            "packetInputStreamArgs": {"lengthFieldOffset": 4, "maxPacketLength": 1500, "lengthFieldLength": 2,
            "lengthAdjustment": 7, "initialBytesToStrip": 0}}]}"#,
        xtce: &["../target/golden/mdb/xtce.xml"],
        packets: "../target/golden/tm-data/testdata.ccsds",
        filters: "../tools/golden/filters.txt",
    });
}

const PUS_CONFIG: &str = r#"{"fileFormats": [{"name": "CCSDS Packets",
    "packetInputStreamClassName": "org.yamcs.tctm.CcsdsPacketInputStream"}]}"#;

/// the PUS simulator MDB of dev/yamcs, as the plugin sends it (its XTCE files), and packets recorded from it
#[test]
fn pus() {
    golden(Case {
        expected: "../target/golden-pus.txt",
        config: PUS_CONFIG,
        xtce: &PUS_FILES,
        packets: "../tools/golden/pus/packets.raw",
        filters: "../tools/golden/pus/filters.txt",
    });
}

/// the order of tools/golden/pus/etc/mdb.yaml
const PUS_FILES: [&str; 7] = [
    "../dev/yamcs/src/main/yamcs/mdb/dt.xml",
    "../dev/yamcs/src/main/yamcs/mdb/pus.xml",
    "../dev/yamcs/src/main/yamcs/mdb/pus5.xml",
    "../dev/yamcs/src/main/yamcs/mdb/pus17.xml",
    "../dev/yamcs/src/main/yamcs/mdb/pus19.xml",
    "../dev/yamcs/src/main/yamcs/mdb/pus22.xml",
    "../dev/yamcs/src/main/yamcs/mdb/landing.xml",
];

/// The same through the XTCE export of Yamcs, which the plugin uses for MDBs not loaded from XTCE files. Fails with
/// Yamcs 5.14: XtceAssembler writes the dynamic size of a BinaryDataEncoding as a fixed -1.
#[test]
#[ignore]
fn pus_export() {
    golden(Case {
        expected: "../target/golden-pus.txt",
        config: PUS_CONFIG,
        xtce: &["../target/golden-pus.xml"],
        packets: "../tools/golden/pus/packets.raw",
        filters: "../tools/golden/pus/filters.txt",
    });
}

fn golden(case: Case) {
    let Ok(expected) = std::fs::read_to_string(case.expected) else {
        eprintln!("no golden output {}, run tools/golden/run.sh", case.expected);
        return;
    };
    let config: ViewerConfig = serde_json::from_str(case.config).unwrap();
    let mut v = Viewer::new(config).unwrap();
    let docs: Vec<String> = case.xtce.iter().map(|f| std::fs::read_to_string(f).unwrap()).collect();
    v.load_mdb(&docs.iter().map(|d| d.as_str()).collect::<Vec<_>>()).unwrap();
    // the root container that Yamcs determined, as the plugin sends it
    let root = expected.lines().next().unwrap().strip_prefix("root ").unwrap();
    v.set_default_root_container(Some(root.to_owned()));
    v.set_source(Some(0)).unwrap();
    let mut r = PacketReader::new(v.file_formats()[0].splitter.clone());
    for p in r.push(&std::fs::read(case.packets).unwrap()).unwrap() {
        v.add_file_packet(p.data, 0);
    }

    let mut out = String::new();
    writeln!(out, "root {}", v.root_container().unwrap()).unwrap();
    let n = v.row_count();
    for row in v.rows(0, n) {
        writeln!(out, "#{} {} {}", row.nr, row.name, row.length).unwrap();
        let d = v.select(row.nr).unwrap();
        for p in &d.params {
            let opt = |x: Option<u32>| x.map_or("-".to_owned(), |x| x.to_string());
            let calib = match &p.calibration {
                Calibration::None => "-".to_owned(),
                Calibration::Text { text } => text.clone(),
                Calibration::Enumeration { type_name } => format!("LOV {type_name}"),
            };
            let cols = [
                p.name.clone(),
                p.eng_value.clone(),
                p.raw_value.clone().unwrap_or("-".into()),
                opt(p.bit_offset),
                opt(p.bit_size),
                calib,
            ];
            writeln!(out, "  {}", cols.join("\t")).unwrap();
        }
        tree(&d.tree, 0, &mut out);
    }

    for f in std::fs::read_to_string(case.filters).unwrap().lines() {
        if f.trim().is_empty() {
            continue;
        }
        writeln!(out, "F {f}").unwrap();
        match v.set_filter(Some(f)) {
            Err(_) => writeln!(out, "invalid").unwrap(),
            Ok(n) => {
                let nrs: Vec<String> = (0..n).map(|r| v.packet_at_row(r).unwrap().to_string()).collect();
                writeln!(out, "match {} {}", n, nrs.join(",")).unwrap();
            }
        }
    }

    let mut diffs = 0;
    for (i, (a, b)) in expected.lines().zip(out.lines()).enumerate() {
        if a != b {
            diffs += 1;
            if diffs <= 20 {
                eprintln!("line {}:\n  java: {}\n  rust: {}", i + 1, a, b);
            }
        }
    }
    assert_eq!(expected.lines().count(), out.lines().count(), "line count");
    assert_eq!(0, diffs, "{} different lines", diffs);
    eprintln!("{} lines identical", expected.lines().count());
}
