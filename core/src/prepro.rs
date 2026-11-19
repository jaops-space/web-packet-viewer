//! Packet preprocessors: the generation time and sequence count of the packets read from files,
//! like the Yamcs `IssPacketPreprocessor` and `GenericPacketPreprocessor`.
//!
//! The checksums are not verified: the packet viewer does not use the result.

use serde_json::{Map, Value};
use xtce_rs::time::{self, INVALID_INSTANT};

use crate::config::{byte_order, Args, GENERIC_PREPROCESSOR, ISS_PREPROCESSOR};

#[derive(Debug, Clone, PartialEq)]
pub enum Preprocessor {
    Iss,
    Generic(GenericPrepro),
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenericPrepro {
    pub timestamp_offset: i64,
    pub seq_count_offset: i64,
    pub big_endian: bool,
    pub use_local_generation_time: bool,
    pub time_decoder: TimeDecoder,
    pub epoch: Epoch,
    pub root_container: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TimeDecoder {
    /// implicit pfield (-1: read from the packet), implicit pfield continuation
    Cuc { basic_bytes: i32, fractional_bytes: i32 },
    Fixed { size: usize, multiplier: f64 },
    Float64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Epoch {
    Tai,
    J2000,
    Unix,
    Gps,
    /// epoch instant (or unix millis if the time does not include the leap seconds), includes leap seconds
    Custom(i64, bool),
    /// the time needs a time correlation service: not supported
    None,
}

/// Result of the preprocessing
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacketTime {
    /// instant; INVALID_INSTANT if it could not be determined
    pub generation_time: i64,
    pub seq_count: i32,
}

impl Preprocessor {
    pub fn from_config(class_name: &str, args: Option<&Map<String, Value>>) -> Result<Preprocessor, String> {
        let args = Args(args);
        match class_name {
            ISS_PREPROCESSOR => Ok(Preprocessor::Iss),
            GENERIC_PREPROCESSOR => {
                let big_endian = byte_order(&args)?;
                let use_local = args.bool_or("useLocalGenerationTime", false)?;
                let (time_decoder, epoch) = match args.map("timeEncoding") {
                    Some(te) if !use_local => time_config(&Args(Some(te)), big_endian)?,
                    _ => (TimeDecoder::Fixed { size: 8, multiplier: 1.0 }, Epoch::Unix),
                };
                Ok(Preprocessor::Generic(GenericPrepro {
                    timestamp_offset: args.int("timestampOffset")?,
                    seq_count_offset: args.int("seqCountOffset")?,
                    big_endian,
                    use_local_generation_time: use_local,
                    time_decoder,
                    epoch,
                    root_container: args.str_opt("rootContainer")?.map(|s| s.to_owned()),
                }))
            }
            _ => Err(format!("unsupported packet preprocessor {}", class_name)),
        }
    }

    /// The root container imposed by the preprocessor (GenericPacketPreprocessor `rootContainer`)
    pub fn root_container(&self) -> Option<&str> {
        match self {
            Preprocessor::Generic(g) => g.root_container.as_deref(),
            _ => None,
        }
    }

    /// Processes a packet; `now` is the reception time. None if the packet is rejected.
    pub fn process(&self, p: &[u8], now: i64) -> Option<PacketTime> {
        match self {
            Preprocessor::Iss => {
                if p.len() < 16 {
                    return None;
                }
                let apidseqcount = i32::from_be_bytes([p[0], p[1], p[2], p[3]]);
                let coarse = u32::from_be_bytes([p[6], p[7], p[8], p[9]]) as i64;
                let gps_millis = coarse * 1000 + 1000 * p[10] as i64 / 256;
                Some(PacketTime { generation_time: time::from_gps_millis(gps_millis), seq_count: apidseqcount })
            }
            Preprocessor::Generic(g) => {
                let generation_time = if g.use_local_generation_time {
                    now
                } else if g.timestamp_offset < 0 {
                    now
                } else {
                    g.decode_time(p, g.timestamp_offset as usize).unwrap_or(INVALID_INSTANT)
                };
                let mut seq_count = 0;
                if g.seq_count_offset >= 0 {
                    let o = g.seq_count_offset as usize;
                    seq_count = match p.get(o..o + 4) {
                        Some(b) => {
                            let b = [b[0], b[1], b[2], b[3]];
                            if g.big_endian { i32::from_be_bytes(b) } else { i32::from_le_bytes(b) }
                        }
                        None => -1,
                    };
                }
                Some(PacketTime { generation_time, seq_count })
            }
        }
    }
}

fn time_config(c: &Args, big_endian: bool) -> Result<(TimeDecoder, Epoch), String> {
    let decoder = match c.str_opt("type")?.unwrap_or("FIXED") {
        "CUC" => {
            let pfield = c.int_or("implicitPField", -1)?;
            let pfield2 = c.int_or("implicitPFieldCont", -1)?;
            if pfield != -1 {
                let mut bt = 1 + ((pfield >> 2) & 3);
                let mut ft = pfield & 3;
                // like Yamcs: (pfield1 & 0x80) == 1 is never true, the continuation is ignored
                #[allow(clippy::bad_bit_mask)]
                if (pfield & 0x80) == 1 {
                    bt += (pfield2 >> 6) & 3;
                    ft += (pfield2 >> 2) & 7;
                }
                TimeDecoder::Cuc { basic_bytes: bt as i32, fractional_bytes: ft as i32 }
            } else {
                TimeDecoder::Cuc { basic_bytes: -1, fractional_bytes: -1 }
            }
        }
        "FIXED" => {
            let size = c.int_or("size", 8)?;
            if size != 4 && size != 8 {
                return Err(format!("Unsupported size {} for fixed decoder. Only 4 and 8 bytes supported", size));
            }
            TimeDecoder::Fixed { size: size as usize, multiplier: c.f64_or("multiplier", 1.0)? }
        }
        "FLOAT64" => TimeDecoder::Float64,
        t => return Err(format!("unknown time decoder type {}", t)),
    };
    let _ = big_endian;
    let epoch = match c.str_opt("epoch")?.unwrap_or("GPS") {
        "TAI" => Epoch::Tai,
        "J2000" => Epoch::J2000,
        "UNIX" => Epoch::Unix,
        "GPS" => Epoch::Gps,
        "NONE" => Epoch::None,
        "CUSTOM" => {
            let include_leap = c.bool_or("timeIncludesLeapSeconds", true)?;
            let s = c.str_opt("epochUTC")?.ok_or("missing argument 'epochUTC'")?;
            let e = time::parse(s).ok_or_else(|| format!("invalid epochUTC '{}'", s))?;
            Epoch::Custom(if include_leap { e } else { time::to_unix_millis(e) }, include_leap)
        }
        e => return Err(format!("unknown epoch {}", e)),
    };
    Ok((decoder, epoch))
}

impl GenericPrepro {
    /// the generation time; None if it cannot be decoded (the Java preprocessor marks the packet invalid)
    fn decode_time(&self, p: &[u8], offset: usize) -> Option<i64> {
        let t = match &self.time_decoder {
            TimeDecoder::Cuc { basic_bytes, fractional_bytes } => decode_cuc(p, offset, *basic_bytes, *fractional_bytes)?,
            TimeDecoder::Fixed { size, multiplier } => {
                let b = p.get(offset..offset + size)?;
                let v: i64 = match (size, self.big_endian) {
                    (4, true) => i32::from_be_bytes(b.try_into().ok()?) as i64,
                    (4, false) => i32::from_le_bytes(b.try_into().ok()?) as i64,
                    (_, true) => i64::from_be_bytes(b.try_into().ok()?),
                    (_, false) => i64::from_le_bytes(b.try_into().ok()?),
                };
                (v as f64 * multiplier) as i64
            }
            TimeDecoder::Float64 => {
                let b: [u8; 8] = p.get(offset..offset + 8)?.try_into().ok()?;
                let bits = if self.big_endian { u64::from_be_bytes(b) } else { u64::from_le_bytes(b) };
                (f64::from_bits(bits) * 1000.0) as i64
            }
        };
        Some(match self.epoch {
            Epoch::Gps => time::from_gps_millis(t),
            Epoch::J2000 => time::from_j2000_millis(t),
            Epoch::Tai => time::from_tai_millis(t),
            Epoch::Unix => time::from_unix_millis(t),
            Epoch::Custom(e, true) => e + t,
            Epoch::Custom(e, false) => time::from_unix_millis(e + t),
            Epoch::None => return None,
        })
    }
}

/// Yamcs `CucTimeDecoder.decode`: milliseconds
fn decode_cuc(p: &[u8], offset: usize, basic: i32, fractional: i32) -> Option<i64> {
    let mut i = offset;
    let mut next = || {
        let b = *p.get(i)?;
        i += 1;
        Some(b as i64)
    };
    let (mut bt, ft) = if basic < 0 {
        let pfield = next()?;
        let mut bt = 1 + ((pfield >> 2) & 3);
        let mut ft = pfield & 3;
        if (pfield >> 7) == 1 {
            let ext = next()?;
            bt += (ext >> 6) & 3;
            ft += (ext >> 2) & 7;
        }
        if bt > 6 {
            return None;
        }
        (bt, ft)
    } else {
        (basic as i64, fractional as i64)
    };
    let mut coarse: i64 = 0;
    while bt > 0 {
        coarse = (coarse << 8) + next()?;
        bt -= 1;
    }
    let mut fine: i64 = 0;
    if ft > 0 {
        let used = ft.min(2);
        for _ in 0..used {
            fine = (fine << 8) + next()?;
        }
        let shift = used * 8;
        fine = (1000 * fine + (1 << shift)) >> shift;
        for _ in used..ft {
            next()?;
        }
    }
    Some(coarse * 1000 + fine)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn generic(args: Value) -> Preprocessor {
        Preprocessor::from_config(GENERIC_PREPROCESSOR, args.as_object()).unwrap()
    }

    #[test]
    fn iss() {
        // simulator DHS packet: coarse time 0x517e58c1, fine 0xb0
        let p = [
            0x08, 0x01, 0xff, 0xf5, 0x00, 0x15, 0x51, 0x7e, 0x58, 0xc1, 0xb0, 0x65, 0, 0, 0, 2, 4, 1,
        ];
        let t = Preprocessor::Iss.process(&p, 0).unwrap();
        assert_eq!("2023-05-04T11:25:35.687Z", time::to_string(t.generation_time));
        assert_eq!(0x0801fff5, t.seq_count);
        assert_eq!(None, Preprocessor::Iss.process(&p[..15], 0));
    }

    #[test]
    fn generic_default_unix_ms() {
        let pp = generic(json!({"timestampOffset": 0, "seqCountOffset": 8}));
        let mut p = 1_700_000_000_123i64.to_be_bytes().to_vec();
        p.extend(7i32.to_be_bytes());
        let t = pp.process(&p, 0).unwrap();
        assert_eq!("2023-11-14T22:13:20.123Z", time::to_string(t.generation_time));
        assert_eq!(7, t.seq_count);
        // too short for the sequence count
        assert_eq!(-1, pp.process(&p[..10], 0).unwrap().seq_count);
        // too short for the time
        assert_eq!(INVALID_INSTANT, pp.process(&p[..4], 0).unwrap().generation_time);
    }

    #[test]
    fn generic_cuc_gps_and_local() {
        // explicit pfield 0x2E: 4 bytes coarse, 2 bytes fine; GPS epoch by default
        let pp = generic(json!({"timestampOffset": 1, "seqCountOffset": -1, "timeEncoding": {"type": "CUC"}}));
        let p = [0xFF, 0x2E, 0, 0, 0, 3, 0x80, 0x00];
        let t = pp.process(&p, 0).unwrap();
        // Yamcs rounds the fine time with (1000 * fine + 2^bits) >> bits: 0.5 s gives 501 ms
        assert_eq!("1980-01-06T00:00:03.501Z", time::to_string(t.generation_time));
        assert_eq!(0, t.seq_count);

        let pp = generic(json!({"timestampOffset": 0, "seqCountOffset": -1, "useLocalGenerationTime": true}));
        assert_eq!(42, pp.process(&p, 42).unwrap().generation_time);
        let pp = generic(json!({"timestampOffset": -1, "seqCountOffset": -1}));
        assert_eq!(43, pp.process(&p, 43).unwrap().generation_time);
    }

    #[test]
    fn generic_fixed_custom_epoch() {
        let pp = generic(json!({"timestampOffset": 0, "seqCountOffset": -1, "byteOrder": "LITTLE_ENDIAN",
            "timeEncoding": {"type": "FIXED", "size": 4, "multiplier": 1000.0, "epoch": "CUSTOM",
                             "epochUTC": "2020-01-01T00:00:00Z", "timeIncludesLeapSeconds": false}}));
        let t = pp.process(&10i32.to_le_bytes(), 0).unwrap();
        assert_eq!("2020-01-01T00:00:10.000Z", time::to_string(t.generation_time));
    }
}
