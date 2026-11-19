//! Splitting a byte stream (a file) into packets, like the Yamcs `PacketInputStream`s.
//!
//! The data is pushed in chunks; complete packets are returned as soon as they are available.

use serde_json::{Map, Value};

use crate::config::{byte_order, Args, CCSDS_INPUT_STREAM, GENERIC_INPUT_STREAM};

#[derive(Debug, Clone, PartialEq)]
pub enum Splitter {
    /// `CcsdsPacketInputStream`: the length from the CCSDS primary header
    Ccsds { max_packet_length: usize },
    /// `GenericPacketInputStream`
    Generic(GenericArgs),
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenericArgs {
    pub max_packet_length: i64,
    pub length_field_offset: usize,
    pub length_field_length: usize,
    pub length_adjustment: i64,
    pub initial_bytes_to_strip: usize,
    pub big_endian: bool,
}

impl Splitter {
    pub fn from_config(class_name: &str, args: Option<&Map<String, Value>>) -> Result<Splitter, String> {
        let args = Args(args);
        match class_name {
            CCSDS_INPUT_STREAM => {
                Ok(Splitter::Ccsds { max_packet_length: args.int_or("maxPacketLength", 1500)?.max(0) as usize })
            }
            GENERIC_INPUT_STREAM => {
                let lfl = args.int("lengthFieldLength")?;
                if !(1..=4).contains(&lfl) {
                    return Err("Unsupported lengthFieldLength, supported values are 1,2,3 or 4".into());
                }
                let nonneg = |k: &str| -> Result<usize, String> {
                    let v = args.int(k)?;
                    usize::try_from(v).map_err(|_| format!("argument '{}' must not be negative", k))
                };
                Ok(Splitter::Generic(GenericArgs {
                    max_packet_length: args.int("maxPacketLength")?,
                    length_field_offset: nonneg("lengthFieldOffset")?,
                    length_field_length: lfl as usize,
                    length_adjustment: args.int("lengthAdjustment")?,
                    initial_bytes_to_strip: nonneg("initialBytesToStrip")?,
                    big_endian: byte_order(&args)?,
                }))
            }
            _ => Err(format!("unsupported packet input stream {}", class_name)),
        }
    }
}

/// Incremental packet reader
pub struct PacketReader {
    splitter: Splitter,
    buf: Vec<u8>,
    /// start of the unconsumed data in buf
    pos: usize,
    /// offset in the stream of buf[pos]
    stream_offset: u64,
}

/// A packet and its offset in the stream
#[derive(Debug, Clone, PartialEq)]
pub struct SplitPacket {
    pub offset: u64,
    pub data: Vec<u8>,
}

impl PacketReader {
    pub fn new(splitter: Splitter) -> Self {
        PacketReader { splitter, buf: Vec::new(), pos: 0, stream_offset: 0 }
    }

    /// Adds data and returns the complete packets. After an error the reader should not be used anymore.
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<SplitPacket>, String> {
        if self.pos > 0 && self.pos >= self.buf.len() / 2 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        while let Some((start, end, consumed)) = self.next_packet()? {
            let p = &self.buf[self.pos..];
            out.push(SplitPacket { offset: self.stream_offset + start as u64, data: p[start..end].to_vec() });
            self.pos += consumed;
            self.stream_offset += consumed as u64;
        }
        Ok(out)
    }

    /// the number of bytes received after the last complete packet (non zero at the end of the
    /// stream means that the last packet is truncated)
    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    /// returns (start, end, consumed) of the next packet in the unconsumed data, None if more data is needed
    fn next_packet(&self) -> Result<Option<(usize, usize, usize)>, String> {
        let p = &self.buf[self.pos..];
        match &self.splitter {
            Splitter::Ccsds { max_packet_length } => {
                if p.len() < 6 {
                    return Ok(None);
                }
                let len = ((p[4] as usize) << 8) + p[5] as usize + 1 + 6;
                if len > *max_packet_length {
                    return Err(format!(
                        "Invalid packet read: packetLength ({}) > maxPacketLength({})",
                        len, max_packet_length
                    ));
                }
                Ok(if p.len() < len { None } else { Some((0, len, len)) })
            }
            Splitter::Generic(g) => {
                let lfe = g.length_field_offset + g.length_field_length;
                if p.len() < lfe {
                    return Ok(None);
                }
                let f = &p[g.length_field_offset..lfe];
                let mut v: u64 = 0;
                if g.big_endian {
                    for b in f {
                        v = (v << 8) | *b as u64;
                    }
                } else {
                    for b in f.iter().rev() {
                        v = (v << 8) | *b as u64;
                    }
                }
                // a 4 bytes length is a Java (signed) int
                let field = if g.length_field_length == 4 { v as u32 as i32 as i64 } else { v as i64 };
                let length = field + g.length_adjustment;
                if length > g.max_packet_length {
                    return Err(format!(
                        "Error reading packet at offset {}: length {} greater than maximum allowed {}",
                        self.stream_offset, length, g.max_packet_length
                    ));
                }
                let strip = g.initial_bytes_to_strip as i64;
                if length < strip || (strip <= lfe as i64 && length < lfe as i64) {
                    return Err(format!(
                        "Error reading packet at offset {}: invalid length {}",
                        self.stream_offset, length
                    ));
                }
                let length = length as usize;
                Ok(if p.len() < length { None } else { Some((g.initial_bytes_to_strip, length, length)) })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ccsds(len: usize, fill: u8) -> Vec<u8> {
        let mut p = vec![fill; len];
        let l = (len - 7) as u16;
        p[4] = (l >> 8) as u8;
        p[5] = l as u8;
        p
    }

    #[test]
    fn ccsds_chunks() {
        let mut data = ccsds(10, 1);
        data.extend(ccsds(20, 2));
        data.extend(ccsds(7, 3));
        let mut r = PacketReader::new(Splitter::Ccsds { max_packet_length: 1500 });
        let mut all = Vec::new();
        for chunk in data.chunks(3) {
            all.extend(r.push(chunk).unwrap());
        }
        assert_eq!(vec![0, 10, 30], all.iter().map(|p| p.offset).collect::<Vec<_>>());
        assert_eq!(vec![10, 20, 7], all.iter().map(|p| p.data.len()).collect::<Vec<_>>());
        assert_eq!(0, r.remaining());
    }

    #[test]
    fn ccsds_too_long_and_truncated() {
        let mut r = PacketReader::new(Splitter::Ccsds { max_packet_length: 15 });
        assert!(r.push(&ccsds(20, 0)).is_err());
        let mut r = PacketReader::new(Splitter::Ccsds { max_packet_length: 1500 });
        assert!(r.push(&ccsds(20, 0)[..12]).unwrap().is_empty());
        assert_eq!(12, r.remaining());
    }

    #[test]
    fn generic_like_the_packet_viewer_example() {
        // the example of packet-viewer.yaml: equivalent to CCSDS
        let args = serde_json::json!({"lengthFieldOffset": 4, "maxPacketLength": 1500, "lengthFieldLength": 2,
            "lengthAdjustment": 7, "initialBytesToStrip": 0});
        let s = Splitter::from_config(GENERIC_INPUT_STREAM, args.as_object()).unwrap();
        let mut data = ccsds(10, 1);
        data.extend(ccsds(20, 2));
        let mut r = PacketReader::new(s);
        let ps = r.push(&data).unwrap();
        assert_eq!(vec![10, 20], ps.iter().map(|p| p.data.len()).collect::<Vec<_>>());
    }

    #[test]
    fn generic_strip_le() {
        // 2 bytes sync, 1 byte LE length of the whole frame, strip the sync
        let args = serde_json::json!({"lengthFieldOffset": 2, "maxPacketLength": 100, "lengthFieldLength": 1,
            "lengthAdjustment": 0, "initialBytesToStrip": 2, "byteOrder": "LITTLE_ENDIAN"});
        let s = Splitter::from_config(GENERIC_INPUT_STREAM, args.as_object()).unwrap();
        let mut r = PacketReader::new(s);
        let ps = r.push(&[0xAA, 0xBB, 5, 1, 2, 0xAA, 0xBB, 4, 9]).unwrap();
        assert_eq!(vec![SplitPacket { offset: 2, data: vec![5, 1, 2] }, SplitPacket { offset: 7, data: vec![4, 9] }], ps);
    }

    #[test]
    fn generic_config_errors() {
        let args = serde_json::json!({"lengthFieldOffset": 2, "maxPacketLength": 100, "lengthFieldLength": 5,
            "lengthAdjustment": 0, "initialBytesToStrip": 2});
        assert!(Splitter::from_config(GENERIC_INPUT_STREAM, args.as_object()).is_err());
        assert!(Splitter::from_config("x.Y", None).is_err());
    }
}
