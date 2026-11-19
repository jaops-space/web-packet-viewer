//! The hex dump of the packet viewer (`ListPacket.hexdump`) and the highlighting of bit ranges
//! (`PacketViewer.highlightBitRanges`), as character ranges in the text.

const HEX: &[u8; 16] = b"0123456789abcdef";

/// characters per line: "oooo " + 8 x "hhhh " + 16 ascii + '\n'
pub const LINE_SIZE: usize = 5 + 5 * 8 + 16 + 1;

/// the length of the offset at the beginning of each line (shown in gray)
pub const OFFSET_SIZE: usize = 4;

/// `0000 0801 fff5 0015 517e 58c1 b065 0000 0002 ......Q~X..e....`, 16 bytes per line; all the lines
/// have the same length (the last one is padded with spaces). The offset has 4 hex digits (it wraps
/// after 64 KiB, where the Java version fails).
pub fn hexdump(buf: &[u8]) -> String {
    let mut s = String::with_capacity(buf.len().div_ceil(16) * LINE_SIZE);
    let mut i = 0;
    while i < buf.len() {
        for shift in [12, 8, 4, 0] {
            s.push(HEX[(i >> shift) & 0xf] as char);
        }
        s.push(' ');
        let mut ascii = String::with_capacity(16);
        for j in 0..16 {
            if i < buf.len() {
                let b = buf[i];
                s.push(HEX[(b >> 4) as usize] as char);
                s.push(HEX[(b & 0xf) as usize] as char);
                if j & 1 == 1 {
                    s.push(' ');
                }
                ascii.push(if !(32..=126).contains(&b) { '.' } else { b as char });
            } else {
                s.push_str(if j & 1 == 1 { "   " } else { "  " });
                ascii.push(' ');
            }
            i += 1;
        }
        s.push_str(&ascii);
        s.push('\n');
    }
    s
}

/// A bit range in the packet
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BitRange {
    pub offset: usize,
    pub size: usize,
}

/// The character ranges `[start, end)` of the hex dump to highlight for the given bit ranges (hex digits and
/// ascii characters), and the character position to scroll to (the line of the first range).
pub fn highlight(ranges: &[BitRange]) -> (Vec<(usize, usize)>, usize) {
    let mut out = Vec::new();
    for r in ranges {
        if r.size == 0 {
            continue;
        }
        let start_nibble = (r.offset / 4) as i64;
        let stop_nibble = ((r.offset + r.size + 3) / 4) as i64;
        let mut n = start_nibble / 32 * 32;
        while n < stop_nibble {
            let mut bin_start = 5;
            let mut asc_start = 5 + 5 * 8;
            let tmp = start_nibble - n;
            if tmp > 0 {
                bin_start += tmp + tmp / 4;
                asc_start += tmp / 2;
            }
            let mut bin_stop = 5 + 5 * 8 - 1;
            let mut asc_stop = 5 + 5 * 8 + 16;
            let tmp = n + 32 - stop_nibble;
            if tmp > 0 {
                bin_stop -= tmp + tmp / 4;
                asc_stop -= tmp / 2;
            }
            let text_offset = LINE_SIZE as i64 * (n / 32);
            for (a, b) in [(bin_start, bin_stop), (asc_start, asc_stop)] {
                if b > a {
                    out.push(((text_offset + a) as usize, (text_offset + b) as usize));
                }
            }
            n += 32;
        }
    }
    let scroll = ranges.first().map_or(0, |r| LINE_SIZE * (r.offset / 128));
    (out, scroll)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dump() {
        let p: Vec<u8> = (0u8..20).map(|i| i + 60).collect();
        let d = hexdump(&p);
        let lines: Vec<&str> = d.split_terminator('\n').collect();
        assert_eq!(2, lines.len());
        assert_eq!("0000 3c3d 3e3f 4041 4243 4445 4647 4849 4a4b <=>?@ABCDEFGHIJK", lines[0]);
        assert_eq!("0010 4c4d 4e4f                               LMNO            ", lines[1]);
        assert!(d.len() == 2 * LINE_SIZE);
        assert_eq!("0000 00ff 7f20                               ...             \n", hexdump(&[0, 255, 127, 32]));
        assert_eq!("", hexdump(&[]));
    }

    #[test]
    fn highlight_ranges() {
        let p: Vec<u8> = (0u8..40).collect();
        let d = hexdump(&p);
        let text = |r: &(usize, usize)| &d[r.0..r.1];

        // byte 1 (bits 8..16)
        let (h, scroll) = highlight(&[BitRange { offset: 8, size: 8 }]);
        assert_eq!(vec!["01", "."], h.iter().map(text).collect::<Vec<_>>());
        assert_eq!(0, scroll);

        // bytes 14..18 cross the line
        let (h, scroll) = highlight(&[BitRange { offset: 14 * 8, size: 32 }]);
        assert_eq!(4, h.len());
        assert_eq!("0e0f", text(&h[0]));
        assert_eq!("1011", text(&h[2]));
        assert_eq!(0, scroll);

        // a nibble
        let (h, _) = highlight(&[BitRange { offset: 4, size: 4 }]);
        assert_eq!("0", text(&h[0]));

        // second line: scroll there
        let (_, scroll) = highlight(&[BitRange { offset: 16 * 8, size: 8 }]);
        assert_eq!(LINE_SIZE, scroll);

        assert!(highlight(&[BitRange { offset: 3, size: 0 }]).0.is_empty());
    }
}
