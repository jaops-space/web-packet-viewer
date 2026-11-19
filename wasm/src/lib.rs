//! The WebAssembly interface of the packet viewer: a single entry point taking a JSON request and an
//! optional binary payload, returning a JSON reply (see docs/protocol.md).
//!
//! The functions exported to JavaScript:
//! - `pv_alloc(len) -> ptr` reserves memory for a request or payload; `pv_call` frees it.
//! - `pv_call(req_ptr, req_len, data_ptr, data_len) -> ptr` handles a request; the reply is at `ptr`:
//!   a little-endian u32 length followed by the UTF-8 JSON, valid until the next call.

use pv_core::{
    config::ViewerConfig,
    split::PacketReader,
    viewer::{Viewer, MAX_HISTORY},
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    /// must be the first request
    Init {
        #[serde(default)]
        config: ViewerConfig,
    },
    LoadMdb {
        xtce: Vec<String>,
        /// the root container of the MDB as determined by Yamcs
        root_container: Option<String>,
    },
    SetSource {
        format: Option<usize>,
    },
    SetMaxLines {
        max_lines: Option<usize>,
    },
    Clear,
    /// clears the packets and starts reading a file in the given format; the payload of `fileChunk`
    /// requests is the content of the file
    BeginFile {
        format: usize,
    },
    FileChunk {
        now: f64,
    },
    EndFile,
    /// packets from Yamcs: the payload is the concatenated packets
    AddPackets {
        lengths: Vec<usize>,
        /// UTC (ISO 8601); null: the realtime preprocessor gives the time
        generation_times: Vec<Option<String>>,
        now: f64,
    },
    Status,
    Rows {
        from: usize,
        to: usize,
    },
    RowOf {
        nr: u32,
    },
    AddColumn {
        qualified_name: String,
    },
    RemoveColumn {
        index: usize,
    },
    ValidateFilter {
        expr: String,
    },
    StartFilter {
        expr: Option<String>,
    },
    FilterStep {
        max: usize,
    },
    Select {
        nr: u32,
    },
    Back,
    Forward,
    Neighbour {
        row: Option<usize>,
        up: bool,
    },
    ToggleMark {
        nr: u32,
    },
    Highlight {
        ranges: Vec<(u32, u32)>,
    },
    CopyHex {
        nr: u32,
    },
    EnumValues {
        qualified_name: String,
    },
    Parameters,
}

#[derive(Default)]
pub struct Session {
    viewer: Option<Viewer>,
    reader: Option<PacketReader>,
    file_packets: usize,
}

impl Session {
    /// Handles a request; the reply is `{"error": message}` on failure. The log messages produced by the
    /// request are in `log`.
    pub fn call(&mut self, req: &[u8], data: &[u8]) -> String {
        let mut reply = match serde_json::from_slice::<Request>(req) {
            Ok(r) => self.handle(r, data).unwrap_or_else(|e| json!({ "error": e })),
            Err(e) => json!({ "error": format!("bad request: {e}") }),
        };
        if let Some(v) = &mut self.viewer {
            let log = v.take_log();
            if !log.is_empty() {
                reply["log"] = json!(log);
            }
        }
        reply.to_string()
    }

    fn handle(&mut self, req: Request, data: &[u8]) -> Result<Value, String> {
        if let Request::Init { config } = req {
            let v = Viewer::new(config)?;
            let formats: Vec<&str> = v.file_formats().iter().map(|f| f.name.as_str()).collect();
            let reply = json!({ "fileFormats": formats });
            *self = Session { viewer: Some(v), ..Default::default() };
            return Ok(reply);
        }
        let v = self.viewer.as_mut().ok_or("not initialised")?;
        Ok(match req {
            Request::Init { .. } => unreachable!(),
            Request::LoadMdb { xtce, root_container } => {
                let docs: Vec<&str> = xtce.iter().map(|s| s.as_str()).collect();
                let message = v.load_mdb(&docs)?;
                v.set_default_root_container(root_container);
                json!({ "message": message, "rootContainer": v.root_container() })
            }
            Request::SetSource { format } => {
                v.set_source(format)?;
                json!({ "rootContainer": v.root_container() })
            }
            Request::SetMaxLines { max_lines } => {
                v.set_max_lines(max_lines);
                status(v)
            }
            Request::Clear => {
                v.clear();
                status(v)
            }
            Request::BeginFile { format } => {
                v.set_source(Some(format))?;
                v.clear();
                self.reader = Some(PacketReader::new(v.file_formats()[format].splitter.clone()));
                self.file_packets = 0;
                status(v)
            }
            Request::FileChunk { now } => {
                let r = self.reader.as_mut().ok_or("no file is being read")?;
                let packets = r.push(data)?;
                let now = xtce_rs::time::from_unix_millis(now as i64);
                for p in packets {
                    v.add_file_packet(p.data, now);
                    self.file_packets += 1;
                }
                let mut s = status(v);
                s["filePackets"] = json!(self.file_packets);
                s
            }
            Request::EndFile => {
                let r = self.reader.take().ok_or("no file is being read")?;
                let mut s = status(v);
                s["filePackets"] = json!(self.file_packets);
                // the Java viewer gets an EOFException from the incomplete packet
                s["truncated"] = json!(r.remaining() > 0);
                s
            }
            Request::AddPackets { lengths, generation_times, now } => {
                if lengths.len() != generation_times.len() || lengths.iter().sum::<usize>() != data.len() {
                    return Err("addPackets: lengths, generationTimes and data do not match".into());
                }
                let now = xtce_rs::time::from_unix_millis(now as i64);
                let mut offset = 0;
                let mut added = 0;
                for (len, t) in lengths.iter().zip(generation_times) {
                    let p = data[offset..offset + len].to_vec();
                    offset += len;
                    let ok = match t {
                        Some(t) => {
                            let t = parse_time(&t).ok_or_else(|| format!("invalid time {t}"))?;
                            v.add_packet(p, t);
                            true
                        }
                        None => v.add_file_packet(p, now).is_some(),
                    };
                    added += ok as usize;
                }
                let mut s = status(v);
                s["added"] = json!(added);
                s
            }
            Request::Status => status(v),
            Request::Rows { from, to } => json!({ "rows": v.rows(from, to), "rowCount": v.row_count() }),
            Request::RowOf { nr } => match v.row_of(nr) {
                Some(row) => json!({ "row": row }),
                None => match v.packet_data(nr) {
                    // filtered out
                    Some(_) => json!({ "row": null }),
                    None => return Err(format!("There is no packet number {nr}")),
                },
            },
            Request::AddColumn { qualified_name } => {
                json!({ "added": v.add_column(&qualified_name), "columns": v.columns() })
            }
            Request::RemoveColumn { index } => {
                v.remove_column(index);
                json!({ "columns": v.columns() })
            }
            Request::ValidateFilter { expr } => match Viewer::validate_filter(&expr) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "message": e.message, "position": e.position }),
            },
            Request::StartFilter { expr } => match v.start_filter(expr.as_deref()) {
                Ok(scan) => json!({ "ok": true, "scan": scan, "rowCount": v.row_count() }),
                Err(e) => json!({ "ok": false, "message": e.message, "position": e.position, "rowCount": v.row_count() }),
            },
            Request::FilterStep { max } => {
                let p = v.filter_step(max);
                json!({ "scanned": p.scanned, "total": p.total, "done": p.done, "rowCount": v.row_count() })
            }
            Request::Select { nr } => {
                let d = v.select(nr)?;
                let mut r = serde_json::to_value(d).map_err(|e| e.to_string())?;
                r["row"] = json!(v.row_of(nr));
                r["canGoBack"] = json!(v.can_go_back());
                r["canGoForward"] = json!(v.can_go_forward());
                r
            }
            Request::Back => json!({ "nr": v.go_back() }),
            Request::Forward => json!({ "nr": v.go_forward() }),
            Request::Neighbour { row, up } => json!({ "row": v.neighbour_row(row, up) }),
            Request::ToggleMark { nr } => json!({ "marked": v.toggle_mark(nr) }),
            Request::Highlight { ranges } => {
                let (spans, scroll) = Viewer::highlight(&ranges);
                json!({ "spans": spans, "scroll": scroll })
            }
            Request::CopyHex { nr } => {
                let d = v.packet_data(nr).ok_or_else(|| format!("There is no packet number {nr}"))?;
                json!({ "hex": xtce_rs::format::hex_upper(d) })
            }
            Request::EnumValues { qualified_name } => json!(v.enum_values(&qualified_name)),
            Request::Parameters => json!({ "parameters": v.parameter_names() }),
        })
    }
}

fn status(v: &Viewer) -> Value {
    json!({
        "packetCount": v.packet_count(),
        "rowCount": v.row_count(),
        "filtering": v.filtering(),
        "range": v.packet_number_range(),
        "maxHistory": MAX_HISTORY,
        "memoryBytes": memory_bytes(),
    })
}

/// the size of the wasm memory (it only grows)
fn memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    return core::arch::wasm32::memory_size(0) * 65536;
    #[cfg(not(target_arch = "wasm32"))]
    0
}

/// Yamcs JSON timestamps may have up to nanosecond precision; xtce-rs parses milliseconds
fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches('Z');
    let s = match s.split_once('.') {
        Some((a, frac)) => format!("{}.{}", a, &frac[..frac.len().min(3)]),
        None => s.to_owned(),
    };
    xtce_rs::time::parse(&s)
}

// ------------------------------------------------------------ exports

#[cfg(target_arch = "wasm32")]
mod ffi {
    use std::cell::RefCell;

    use super::Session;

    thread_local! {
        static SESSION: RefCell<Session> = RefCell::new(Session::default());
        static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }

    #[no_mangle]
    pub extern "C" fn pv_alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len.max(1));
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr` must come from `pv_alloc(len)`
    #[no_mangle]
    pub unsafe extern "C" fn pv_free(ptr: *mut u8, len: usize) {
        drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
    }

    /// # Safety
    /// the buffers must come from `pv_alloc`, with the given lengths; they are freed
    #[no_mangle]
    pub unsafe extern "C" fn pv_call(req: *mut u8, req_len: usize, data: *mut u8, data_len: usize) -> *const u8 {
        let r = Vec::from_raw_parts(req, req_len, req_len.max(1));
        let d = Vec::from_raw_parts(data, data_len, data_len.max(1));
        let out = SESSION.with_borrow_mut(|s| s.call(&r, &d));
        drop(r);
        drop(d);
        REPLY.with_borrow_mut(|buf| {
            buf.clear();
            buf.extend_from_slice(&(out.len() as u32).to_le_bytes());
            buf.extend_from_slice(out.as_bytes());
            buf.as_ptr()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times() {
        assert_eq!(parse_time("2026-01-02T03:04:05.123Z"), parse_time("2026-01-02T03:04:05.123456789Z"));
        assert_eq!(parse_time("2026-01-02T03:04:05.100Z"), parse_time("2026-01-02T03:04:05.1Z"));
        assert!(parse_time("2026-01-02T03:04:05Z").is_some());
        assert!(parse_time("x").is_none());
    }

    #[test]
    fn errors() {
        let mut s = Session::default();
        assert_eq!(r#"{"error":"not initialised"}"#, s.call(br#"{"op":"status"}"#, &[]));
        assert!(s.call(br#"{"op":"nope"}"#, &[]).starts_with(r#"{"error":"bad request"#));
        assert_eq!(r#"{"fileFormats":["CCSDS Packets"]}"#, s.call(br#"{"op":"init"}"#, &[]));
        assert!(s.call(br#"{"op":"select","nr":3}"#, &[]).contains("There is no packet number 3"));
    }
}
