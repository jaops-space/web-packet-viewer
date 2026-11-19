use pv_core::{config::ViewerConfig, split::PacketReader, viewer::Viewer};

const MDB: &str = "../../yamcs/packet-viewer/mdb-packaged/xtce.xml";
const CONFIG: &str = r#"{"packetPreprocessorClassName": "org.yamcs.tctm.GenericPacketPreprocessor", "packetPreprocessorArgs": {"timestampOffset": -1, "seqCountOffset": -1}, "fileFormats": [{"name": "CCSDS Packets", "packetInputStreamClassName": "org.yamcs.tctm.GenericPacketInputStream", "packetInputStreamArgs": {"lengthFieldOffset": 4, "maxPacketLength": 1500, "lengthFieldLength": 2, "lengthAdjustment": 7, "initialBytesToStrip": 0}}]}"#;
const TESTDATA: &str = "../../yamcs/packet-viewer/tm-data/testdata.ccsds";

pub fn load() -> Viewer {
    let mut v = Viewer::new(serde_json::from_str::<ViewerConfig>(CONFIG).unwrap()).unwrap();
    let xtce = std::fs::read_to_string(MDB).unwrap();
    v.load_mdb(&[&xtce]).unwrap();
    v.set_source(Some(0)).unwrap();
    let data = std::fs::read(TESTDATA).unwrap();
    let mut r = PacketReader::new(v.file_formats()[0].splitter.clone());
    for p in r.push(&data).unwrap() {
        v.add_file_packet(p.data, 0);
    }
    v
}

fn labels(n: &pv_core::viewer::TreeNode, depth: usize, out: &mut Vec<String>) {
    out.push(format!("{}{}", "  ".repeat(depth), n.label));
    for c in &n.children {
        labels(c, depth + 1, out);
    }
}

#[test]
fn rows_and_details() {
    let mut v = load();
    assert_eq!(Some("/myproject/CCSDSPacket".into()), v.root_container());
    assert_eq!(vec!["Loaded definition of 3 sequence containers and 40 parameters"], v.take_log());
    assert_eq!(1800, v.packet_count());
    assert_eq!(1800, v.row_count());

    assert!(v.add_column("/myproject/ElapsedSeconds"));
    assert!(!v.add_column("/myproject/ElapsedSeconds"));
    assert!(!v.add_column("/myproject/Nope"));
    let rows = v.rows(0, 2);
    assert_eq!(2, rows.len());
    assert_eq!("/myproject/Spacecraft", rows[0].name);
    assert_eq!(123, rows[0].length);
    assert_eq!(vec![Some("0".to_owned())], rows[0].columns);
    assert_eq!(vec![Some("1".to_owned())], rows[1].columns);

    let d = v.select(3).unwrap();
    assert_eq!(None, d.error);
    let p = d.params.iter().find(|p| p.name == "Position").unwrap();
    assert_eq!("x : 2443.6577, y : 6758.0093, z : 22.090302", p.eng_value);
    assert_eq!((Some(208), Some(96)), (p.bit_offset, p.bit_size));
    let mut l = Vec::new();
    labels(&d.tree, 0, &mut l);
    assert_eq!("/myproject/Spacecraft", l[0]);
    assert_eq!("  0/16 CCSDS_Packet_ID", l[1]);
    assert_eq!(["  TelemetryPacket", "    Spacecraft", "      48/32 EpochUSNO"], l[4..7]);
    assert_eq!("      29/3 Enum_Para_1", l[l.len() - 3]);
    let e = d.params.iter().find(|p| p.name == "Enum_Para_1").unwrap();
    assert_eq!(pv_core::viewer::Calibration::Enumeration { type_name: "EnumerationTest".into() }, e.calibration);
    let lov = v.enum_values("/myproject/Enum_Para_1").unwrap();
    assert_eq!("EnumerationTest", lov.type_name);
    assert!(!lov.values.is_empty());
    assert_eq!(None, v.enum_values("/myproject/A"));
    assert_eq!("There is no packet number 5000", v.select(5000).unwrap_err());
}

#[test]
fn filter() {
    let mut v = load();
    assert_eq!(Ok(1), v.set_filter(Some("ElapsedSeconds == 7")));
    assert_eq!(Some(8), v.packet_at_row(0));
    assert_eq!(Ok(10), v.set_filter(Some("/myproject/ElapsedSeconds < 10")));
    assert_eq!(Ok(1800), v.set_filter(Some("packet.name == \"/myproject/Spacecraft\"")));
    assert_eq!(Ok(0), v.set_filter(Some("packet.length > 200")));
    assert!(v.set_filter(Some("ElapsedSeconds ==")).is_err());
    assert_eq!(1800, v.row_count());
    assert_eq!(Ok(1800), v.set_filter(None));
    v.set_filter(Some("ElapsedSeconds < 3")).unwrap();
    let a = v.add_packet(v.packet_data(1).unwrap().to_vec(), 0);
    assert_eq!((1801, true), (a.nr, a.visible));
    assert_eq!(4, v.row_count());
    assert_eq!(Some(3), v.row_of(1801));
}

#[test]
fn navigation() {
    let mut v = load();
    for nr in 1..=12 {
        v.select(nr).unwrap();
    }
    v.select(12).unwrap();
    assert!(v.can_go_back());
    assert!(!v.can_go_forward());
    assert_eq!(Some(11), v.go_back());
    assert_eq!(Some(10), v.go_back());
    assert_eq!(Some(11), v.go_forward());
    // selecting a new packet drops the forward history
    v.select(100).unwrap();
    assert!(!v.can_go_forward());
    let mut back = Vec::new();
    while let Some(n) = v.go_back() {
        back.push(n);
    }
    assert_eq!(vec![11, 10, 9, 8, 7, 6, 5, 4, 3], back);

    assert!(v.toggle_mark(5));
    assert!(v.rows(4, 5)[0].marked);
    assert!(!v.toggle_mark(5));
    assert_eq!(Some((1, 1800)), v.packet_number_range());
    assert_eq!(Some(0), v.neighbour_row(None, false));
    assert_eq!(Some(0), v.neighbour_row(Some(0), true));
    assert_eq!(Some(1799), v.neighbour_row(Some(1799), false));
}

#[test]
fn max_lines() {
    let mut v = load();
    v.select(1).unwrap();
    v.select(1795).unwrap();
    v.toggle_mark(2);
    v.set_max_lines(Some(10));
    assert_eq!(10, v.packet_count());
    assert_eq!(Some(1791), v.packet_at_row(0));
    assert!(!v.is_marked(2));
    assert!(!v.can_go_back());
    assert_eq!(Some(1795), v.selected());
    assert!(v.select(1).is_err());
    assert_eq!(Some((1791, 1800)), v.packet_number_range());
}

#[test]
fn filter_in_steps() {
    let mut v = load();
    assert_eq!(Ok(true), v.start_filter(Some(" ElapsedSeconds < 10 ")));
    assert_eq!(Some("ElapsedSeconds < 10"), v.filter());
    let p = v.filter_step(5);
    assert_eq!((5, 1800, false), (p.scanned, p.total, p.done));
    assert_eq!(5, v.row_count());
    // packets added while scanning are left to the scan
    let a = v.add_packet(v.packet_data(1).unwrap().to_vec(), 0);
    assert!(!a.visible);
    v.set_max_lines(Some(1798));
    let p = v.filter_step(1000);
    assert_eq!((1002, 1798, false), (p.scanned, p.total, p.done));
    assert!(v.filtering());
    assert!(v.filter_step(usize::MAX).done);
    assert!(!v.filtering());
    // packets 1..3 were dropped, 1801 is a copy of packet 1
    assert_eq!(vec![4, 5, 6, 7, 8, 9, 10, 1801], (0..v.row_count()).map(|r| v.packet_at_row(r).unwrap()).collect::<Vec<_>>());
    assert!(v.start_filter(Some("x ==")).is_err());
    assert_eq!(None, v.filter());
    assert_eq!(1798, v.row_count());
}
