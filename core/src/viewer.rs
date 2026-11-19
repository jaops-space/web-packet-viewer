//! The state of the packet viewer: the packets, their names and parameter columns, the display filter,
//! the marks, the navigation history and the decoding of the selected packet.
//!
//! All decoding is stateless (`update_cache: false`, no algorithms, like the Java viewer which has no
//! algorithm manager), so a packet gives the same result whenever and in whatever order it is decoded.
//! This allows decoding the visible rows and the filter on demand instead of keeping all values.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;
use xtce_rs::{
    format,
    mdb::{
        types::{DataEncoding, DataType, NumericRange, TypeData},
        ContainerIdx, MissionDatabase, NamedItem, ParameterIdx,
    },
    parser,
    proc::{ProcError, ProcessOptions, TmProcessor, TmResult},
    time::INVALID_INSTANT,
};

use crate::{
    config::{FileFormat, ViewerConfig},
    filter::{FilterError, FilterSubject, PacketFilter},
    hexdump::{self, BitRange},
    prepro::Preprocessor,
    timefmt,
};

struct Decoder<'a> {
    tmp: TmProcessor<'a>,
}

self_cell::self_cell!(
    struct MdbCell {
        owner: MissionDatabase,
        #[covariant]
        dependent: Decoder,
    }
);

/// qualified names, computed once
struct Names {
    params: Vec<String>,
    containers: Vec<String>,
    param_by_qn: HashMap<String, ParameterIdx>,
}

struct Mdb {
    cell: MdbCell,
    names: Names,
}

impl Mdb {
    fn mdb(&self) -> &MissionDatabase {
        self.cell.borrow_owner()
    }

    fn decode(&mut self, data: &[u8], root: ContainerIdx, details: bool) -> Result<TmResult, ProcError> {
        let opts = ProcessOptions { details, algorithms: false, update_cache: false };
        self.cell.with_dependent_mut(|_, d| d.tmp.process_with(data, root, INVALID_INSTANT, INVALID_INSTANT, &opts))
    }

    fn param_qn(&self, pidx: ParameterIdx) -> &str {
        &self.names.params[pidx.index()]
    }

    fn container_qn(&self, cidx: ContainerIdx) -> &str {
        &self.names.containers[cidx.index()]
    }
}

struct ListPacket {
    nr: u32,
    data: Box<[u8]>,
    generation_time: i64,
    /// index in Viewer::names
    name: u32,
}

/// A row of the packets table
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub nr: u32,
    pub generation_time: String,
    pub name: String,
    pub length: usize,
    /// the values of the parameter columns (engineering values), None if not in the packet
    pub columns: Vec<Option<String>>,
    pub marked: bool,
}

/// A row of the parameters table of the selected packet
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParamRow {
    pub qualified_name: String,
    /// the name shown (short name)
    pub name: String,
    pub eng_value: String,
    pub raw_value: Option<String>,
    pub nominal_low: String,
    pub nominal_high: String,
    pub danger_low: String,
    pub danger_high: String,
    pub bit_offset: Option<u32>,
    pub bit_size: Option<u32>,
    pub calibration: Calibration,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Calibration {
    None,
    /// the calibrator of the encoding (or "" if there is none)
    Text { text: String },
    /// an enumerated type: shown as a link to the list of values
    Enumeration { type_name: String },
}

/// A node of the structure tree
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub label: String,
    /// for the parameter entries (leaves)
    pub bit_offset: Option<u32>,
    pub bit_size: Option<u32>,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PacketDetails {
    pub nr: u32,
    pub name: String,
    pub hex: String,
    pub params: Vec<ParamRow>,
    pub tree: TreeNode,
    /// the decoding error; the parameters extracted before it are shown
    #[serde(rename = "decodeError")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnumValues {
    pub type_name: String,
    pub values: Vec<(i64, String)>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct FilterProgress {
    pub scanned: usize,
    pub total: usize,
    pub done: bool,
}

/// The result of adding a packet
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Added {
    pub nr: u32,
    /// the packet passes the display filter
    pub visible: bool,
}

/// the number of packets remembered for Back/Forward
pub const MAX_HISTORY: usize = 10;

pub struct Viewer {
    config: ViewerConfig,
    file_formats: Vec<FileFormat>,
    realtime_preprocessor: Preprocessor,
    /// None: packets from Yamcs
    current_format: Option<usize>,
    /// the default root container (from Yamcs, else guessed)
    default_root: Option<String>,
    mdb: Option<Mdb>,
    root: Option<ContainerIdx>,
    max_lines: Option<usize>,

    packets: VecDeque<ListPacket>,
    next_nr: u32,
    names: Vec<String>,
    name_idx: HashMap<String, u32>,

    columns: Vec<ParameterIdx>,
    filter: Option<PacketFilter>,
    /// packet numbers passing the filter (all if no filter), in order
    view: VecDeque<u32>,
    /// index of the next packet to filter while the filter is applied in steps
    scan: Option<usize>,
    filter_text: Option<String>,

    marks: HashSet<u32>,
    history: Vec<u32>,
    history_pos: isize,
    selected: Option<u32>,
    log: Vec<String>,
}

impl Viewer {
    pub fn new(config: ViewerConfig) -> Result<Viewer, String> {
        Ok(Viewer {
            file_formats: config.file_formats()?,
            realtime_preprocessor: config.realtime_preprocessor()?,
            config,
            current_format: None,
            default_root: None,
            mdb: None,
            root: None,
            max_lines: None,
            packets: VecDeque::new(),
            next_nr: 1,
            names: Vec::new(),
            name_idx: HashMap::new(),
            columns: Vec::new(),
            filter: None,
            view: VecDeque::new(),
            scan: None,
            filter_text: None,
            marks: HashSet::new(),
            history: Vec::new(),
            history_pos: -1,
            selected: None,
            log: Vec::new(),
        })
    }

    pub fn file_formats(&self) -> &[FileFormat] {
        &self.file_formats
    }

    /// the messages for the log panel since the last call
    pub fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log)
    }

    fn log(&mut self, msg: String) {
        self.log.push(msg);
    }

    // ------------------------------------------------------------ MDB

    /// Loads the MDB from XTCE documents; clears the packets and the columns. Returns the log message.
    pub fn load_mdb(&mut self, xtce: &[&str]) -> Result<String, String> {
        // the viewer needs no commands: their definitions are not even read
        let opts = parser::ParseOptions { commands: false };
        let mdb = parser::parse_strs_with(xtce, &opts).map_err(|e| format!("Cannot load the MDB: {:?}", e))?;
        let names = compute_names(&mdb);
        let cell = MdbCell::try_new(mdb, |mdb| TmProcessor::new(mdb).map(|tmp| Decoder { tmp }))
            .map_err(|e| format!("Cannot load the MDB: {}", e))?;
        let m = Mdb { cell, names };
        let (nc, np) = (m.mdb().containers.len(), m.mdb().parameters.len());
        self.mdb = Some(m);
        self.columns.clear();
        self.clear();
        self.update_root();
        let msg = format!(
            "Loaded definition of {} sequence container{} and {} parameter{}",
            nc,
            if nc != 1 { "s" } else { "" },
            np,
            if np != 1 { "s" } else { "" }
        );
        self.log(msg.clone());
        Ok(msg)
    }

    /// The root container of the MDB as determined by Yamcs (`Mdb.getRootSequenceContainer()`); if not set,
    /// a container without base container is guessed.
    pub fn set_default_root_container(&mut self, qualified_name: Option<String>) {
        self.default_root = qualified_name;
        self.update_root();
    }

    /// Selects the source of the packets: a file format (index in [Viewer::file_formats]) or None for the
    /// packets received from Yamcs.
    pub fn set_source(&mut self, file_format: Option<usize>) -> Result<(), String> {
        if let Some(i) = file_format {
            if i >= self.file_formats.len() {
                return Err(format!("no file format {}", i));
            }
        }
        self.current_format = file_format;
        self.update_root();
        Ok(())
    }

    pub fn set_max_lines(&mut self, max_lines: Option<usize>) {
        self.max_lines = max_lines;
        self.trim();
    }

    pub fn root_container(&self) -> Option<String> {
        let m = self.mdb.as_ref()?;
        Some(m.container_qn(self.root?).to_owned())
    }

    fn update_root(&mut self) {
        let Some(m) = &self.mdb else {
            self.root = None;
            return;
        };
        let configured = self.current_format.and_then(|i| self.file_formats[i].root_container.clone());
        let mut msgs = Vec::new();
        let mut root = None;
        for name in configured.iter().chain(self.default_root.iter()) {
            match m.mdb().search_container(name) {
                Some(c) => {
                    root = Some(c);
                    break;
                }
                None => msgs.push(format!("Cannot find the root container {}", name)),
            }
        }
        let root = root.or_else(|| guess_root(m.mdb()));
        if let Some(c) = root {
            if let Some((base, _)) = m.mdb().get_container(c).base_container {
                msgs.push(format!(
                    "{} is not a proper root container: it extends {}",
                    m.container_qn(c),
                    m.container_qn(base)
                ));
            }
        }
        self.root = root;
        for msg in msgs {
            self.log(msg);
        }
    }

    // ------------------------------------------------------------ packets

    pub fn clear(&mut self) {
        self.packets.clear();
        self.view.clear();
        self.scan = None;
        self.names.clear();
        self.name_idx.clear();
        self.marks.clear();
        self.history.clear();
        self.history_pos = -1;
        self.selected = None;
        self.next_nr = 1;
    }

    /// Adds a packet read from a file: the preprocessor of the current file format gives the generation time.
    /// None if the preprocessor rejects it.
    pub fn add_file_packet(&mut self, data: Vec<u8>, now: i64) -> Option<Added> {
        let prepro = match self.current_format {
            Some(i) => &self.file_formats[i].preprocessor,
            None => &self.realtime_preprocessor,
        };
        match prepro.process(&data, now) {
            Some(t) => Some(self.add_packet(data, t.generation_time)),
            None => {
                self.log("preprocessor returned null packet".into());
                None
            }
        }
    }

    /// Adds a packet with a known generation time (received from Yamcs)
    pub fn add_packet(&mut self, data: Vec<u8>, generation_time: i64) -> Added {
        let name = self.packet_name(&data);
        let name = match self.name_idx.get(&name) {
            Some(i) => *i,
            None => {
                let i = self.names.len() as u32;
                self.name_idx.insert(name.clone(), i);
                self.names.push(name);
                i
            }
        };
        let nr = self.next_nr;
        self.next_nr += 1;
        self.packets.push_back(ListPacket { nr, data: data.into_boxed_slice(), generation_time, name });
        let visible = match self.filter.take() {
            // the scan will get to it
            Some(f) if self.scan.is_some() => {
                self.filter = Some(f);
                false
            }
            Some(f) => {
                let v = self.matches(&f, self.packets.len() - 1);
                self.filter = Some(f);
                v
            }
            None => true,
        };
        if visible {
            self.view.push_back(nr);
        }
        self.trim();
        Added { nr, visible }
    }

    /// the packet name like the Java viewer: the last container extracted at offset 0, by alias in the default
    /// namespace or else qualified name
    fn packet_name(&mut self, data: &[u8]) -> String {
        let (Some(m), Some(root)) = (self.mdb.as_mut(), self.root) else {
            return "unknown".into();
        };
        let Ok(r) = m.decode(data, root, true) else {
            return "unknown".into();
        };
        let Some(c) = r.packet_container() else {
            return "unknown".into();
        };
        if let Some(ns) = &self.config.default_namespace {
            if let Some(a) = m.mdb().get_container(c).name_descr().alias(ns) {
                return a.to_owned();
            }
        }
        m.container_qn(c).to_owned()
    }

    fn trim(&mut self) {
        let Some(max) = self.max_lines.filter(|m| *m > 0) else {
            return;
        };
        while self.packets.len() > max {
            let p = self.packets.pop_front().unwrap();
            if let Some(c) = &mut self.scan {
                *c = c.saturating_sub(1);
            }
            if self.view.front() == Some(&p.nr) {
                self.view.pop_front();
            }
            self.marks.remove(&p.nr);
            if let Some(i) = self.history.iter().position(|n| *n == p.nr) {
                self.history.remove(i);
                if i as isize <= self.history_pos {
                    self.history_pos -= 1;
                }
            }
            if self.selected == Some(p.nr) {
                self.selected = None;
            }
        }
    }

    pub fn packet_count(&self) -> usize {
        self.packets.len()
    }

    /// the number of rows (packets passing the filter)
    pub fn row_count(&self) -> usize {
        self.view.len()
    }

    fn index_of(&self, nr: u32) -> Option<usize> {
        let first = self.packets.front()?.nr;
        let i = nr.checked_sub(first)? as usize;
        (i < self.packets.len()).then_some(i)
    }

    /// the row of a packet number, None if it is not shown
    pub fn row_of(&self, nr: u32) -> Option<usize> {
        self.view.binary_search(&nr).ok()
    }

    pub fn packet_at_row(&self, row: usize) -> Option<u32> {
        self.view.get(row).copied()
    }

    /// The rows [from, to)
    pub fn rows(&mut self, from: usize, to: usize) -> Vec<Row> {
        let to = to.min(self.view.len());
        let nrs: Vec<u32> = (from..to).map(|r| self.view[r]).collect();
        nrs.into_iter().filter_map(|nr| self.row(nr)).collect()
    }

    fn row(&mut self, nr: u32) -> Option<Row> {
        let i = self.index_of(nr)?;
        let p = &self.packets[i];
        let mut row = Row {
            nr,
            generation_time: timefmt::combined(p.generation_time),
            name: self.names[p.name as usize].clone(),
            length: p.data.len(),
            columns: vec![None; self.columns.len()],
            marked: self.marks.contains(&nr),
        };
        if !self.columns.is_empty() {
            if let (Some(m), Some(root)) = (self.mdb.as_mut(), self.root) {
                let data = &self.packets[i].data;
                let r = m.decode(data, root, false).ok()?;
                let mdb = m.mdb();
                for (k, pidx) in self.columns.iter().enumerate() {
                    if let Some(pv) = r.params.last_inserted(*pidx) {
                        row.columns[k] = Some(eng_text(mdb, *pidx, &pv.eng_value));
                    }
                }
            }
        }
        Some(row)
    }

    // ------------------------------------------------------------ columns

    /// the parameter columns (qualified names)
    pub fn columns(&self) -> Vec<String> {
        let Some(m) = &self.mdb else { return Vec::new() };
        self.columns.iter().map(|p| m.param_qn(*p).to_owned()).collect()
    }

    /// Adds a column; false if the parameter is unknown or already shown
    pub fn add_column(&mut self, qualified_name: &str) -> bool {
        let Some(pidx) = self.mdb.as_ref().and_then(|m| m.names.param_by_qn.get(qualified_name).copied()) else {
            return false;
        };
        if self.columns.contains(&pidx) {
            return false;
        }
        self.columns.push(pidx);
        true
    }

    pub fn remove_column(&mut self, index: usize) {
        if index < self.columns.len() {
            self.columns.remove(index);
        }
    }

    // ------------------------------------------------------------ filter

    pub fn validate_filter(text: &str) -> Result<(), FilterError> {
        PacketFilter::parse(text).map(|_| ())
    }

    /// Sets the display filter (None or blank: no filter) and applies it to all the packets; returns the
    /// number of rows. An invalid filter removes the filter, like the Java viewer.
    pub fn set_filter(&mut self, text: Option<&str>) -> Result<usize, FilterError> {
        self.start_filter(text)?;
        self.filter_step(usize::MAX);
        Ok(self.view.len())
    }

    /// Sets the display filter without applying it; [Viewer::filter_step] scans the packets. Until the
    /// scan is done, the rows are those of the packets scanned so far. Returns true if a scan is needed.
    pub fn start_filter(&mut self, text: Option<&str>) -> Result<bool, FilterError> {
        let parsed = match text.map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => PacketFilter::parse(t).map(Some),
            None => Ok(None),
        };
        self.filter = parsed.as_ref().ok().cloned().flatten();
        self.filter_text = self.filter.as_ref().and(text.map(|t| t.trim().to_owned()));
        self.view.clear();
        self.scan = None;
        if self.filter.is_some() {
            self.scan = Some(0);
        } else {
            self.view = self.packets.iter().map(|p| p.nr).collect();
        }
        parsed.map(|f| f.is_some())
    }

    /// Applies the filter to at most `max` more packets
    pub fn filter_step(&mut self, max: usize) -> FilterProgress {
        let total = self.packets.len();
        let Some(start) = self.scan else {
            return FilterProgress { scanned: total, total, done: true };
        };
        let filter = self.filter.take().expect("scan without filter");
        let end = start.saturating_add(max).min(total);
        for i in start..end {
            if self.matches(&filter, i) {
                self.view.push_back(self.packets[i].nr);
            }
        }
        self.filter = Some(filter);
        let done = end == total;
        self.scan = if done { None } else { Some(end) };
        FilterProgress { scanned: end, total, done }
    }

    /// the filter is being applied
    pub fn filtering(&self) -> bool {
        self.scan.is_some()
    }

    /// the current filter text
    pub fn filter(&self) -> Option<&str> {
        self.filter_text.as_deref()
    }

    fn matches(&mut self, f: &PacketFilter, i: usize) -> bool {
        let p = &self.packets[i];
        let name = &self.names[p.name as usize];
        let (Some(m), Some(root)) = (self.mdb.as_mut(), self.root) else {
            return f.matches(&Subject { name, length: p.data.len(), mdb: None, result: None });
        };
        let r = m.decode(&p.data, root, false).ok();
        let m = &*m;
        f.matches(&Subject { name, length: p.data.len(), mdb: Some(m), result: r.as_ref() })
    }

    // ------------------------------------------------------------ marks and navigation

    pub fn toggle_mark(&mut self, nr: u32) -> bool {
        if !self.marks.remove(&nr) {
            self.marks.insert(nr);
            true
        } else {
            false
        }
    }

    pub fn is_marked(&self, nr: u32) -> bool {
        self.marks.contains(&nr)
    }

    /// (first, last) packet numbers, like the Java "Go to Packet" range
    pub fn packet_number_range(&self) -> Option<(u32, u32)> {
        let first = self.packets.front()?.nr;
        Some((first, first + self.view.len().saturating_sub(1) as u32))
    }

    pub fn can_go_back(&self) -> bool {
        self.history_pos > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.history_pos < self.history.len() as isize - 1
    }

    /// the packet to select for "Back"
    pub fn go_back(&mut self) -> Option<u32> {
        if self.history_pos > 0 {
            self.history_pos -= 1;
            return Some(self.history[self.history_pos as usize]);
        }
        None
    }

    pub fn go_forward(&mut self) -> Option<u32> {
        if self.can_go_forward() {
            self.history_pos += 1;
            return Some(self.history[self.history_pos as usize]);
        }
        None
    }

    /// the row for "Previous Packet" (`up`) or "Next Packet" given the selected row
    pub fn neighbour_row(&self, selected_row: Option<usize>, up: bool) -> Option<usize> {
        let n = self.view.len();
        match selected_row {
            Some(r) if up => (r > 0).then(|| r - 1).or(Some(r)),
            Some(r) => (r + 1 < n).then_some(r + 1).or(Some(r)),
            None => (n > 0).then_some(0),
        }
    }

    // ------------------------------------------------------------ selection

    /// Selects a packet: records it in the history and returns its details
    pub fn select(&mut self, nr: u32) -> Result<PacketDetails, String> {
        let i = self.index_of(nr).ok_or_else(|| format!("There is no packet number {}", nr))?;
        self.selected = Some(nr);
        if self.history.is_empty() || self.history[self.history_pos as usize] != nr {
            self.history_pos += 1;
            self.history.insert(self.history_pos as usize, nr);
            self.history.truncate(self.history_pos as usize + 1);
            if self.history.len() > MAX_HISTORY {
                self.history.remove(0);
                self.history_pos -= 1;
            }
        }
        self.details(i)
    }

    pub fn selected(&self) -> Option<u32> {
        self.selected
    }

    fn details(&mut self, i: usize) -> Result<PacketDetails, String> {
        let p = &self.packets[i];
        let name = self.names[p.name as usize].clone();
        let mut details = PacketDetails {
            nr: p.nr,
            name: name.clone(),
            hex: hexdump::hexdump(&p.data),
            params: Vec::new(),
            tree: TreeNode { label: name.clone(), bit_offset: None, bit_size: None, children: Vec::new() },
            error: None,
        };
        let prepro_root = match self.current_format {
            Some(f) => self.file_formats[f].preprocessor.root_container().map(|s| s.to_owned()),
            None => None,
        };
        let Some(m) = self.mdb.as_mut() else {
            return Ok(details);
        };
        let root = prepro_root.and_then(|r| m.mdb().search_container(&r)).or(self.root);
        let Some(root) = root else {
            return Ok(details);
        };
        let r = m.decode(&self.packets[i].data, root, true).map_err(|e| e.to_string())?;
        details.error = r.error.as_ref().map(|e| e.to_string());
        let mdb = m.mdb();
        let mut tree = Tree::new(name);
        for (k, pv) in r.params.iter().enumerate() {
            let param = mdb.get_parameter(pv.pidx);
            let dtype = param.ptype.map(|t| mdb.get_data_type(t));
            let pos = r.positions.get(k).copied().flatten();
            let ranges = r.alarm_ranges.get(k).cloned().flatten();
            let (nominal, danger) = match &ranges {
                Some(ar) => (ar.warning.as_ref(), ar.critical.as_ref()),
                None => (None, None),
            };
            details.params.push(ParamRow {
                qualified_name: m.param_qn(pv.pidx).to_owned(),
                name: mdb.name2str(param.name()).to_owned(),
                eng_value: match dtype {
                    Some(dt) => format::eng_value_to_string(mdb, dt, &pv.eng_value),
                    None => format::value_to_string(mdb, &pv.eng_value),
                },
                raw_value: pv.raw_value.as_ref().map(|v| match dtype {
                    Some(dt) => format::raw_value_to_string(mdb, dt, v),
                    None => format::value_to_string(mdb, v),
                }),
                nominal_low: range_min(nominal),
                nominal_high: range_max(nominal),
                danger_low: range_min(danger),
                danger_high: range_max(danger),
                bit_offset: pos.map(|p| p.bit_offset),
                bit_size: pos.map(|p| p.bit_size),
                calibration: calibration(mdb, dtype),
            });
            if let Some(p) = pos {
                let label = format!("{}/{} {}", p.bit_offset, p.bit_size, ops_name(param.name_descr(), mdb));
                let node = tree.container_node(mdb, p.container_start, p.container);
                let leaf = tree.add_node(label, Some((p.bit_offset, p.bit_size)));
                tree.attach(node, leaf);
            }
        }
        details.tree = tree.export(0);
        Ok(details)
    }

    /// The values of an enumerated parameter type (for the "List of Values" dialog)
    pub fn enum_values(&self, qualified_name: &str) -> Option<EnumValues> {
        let m = self.mdb.as_ref()?;
        let pidx = m.names.param_by_qn.get(qualified_name)?;
        let mdb = m.mdb();
        let dt = mdb.get_data_type(mdb.get_parameter(*pidx).ptype?);
        let TypeData::Enumerated(et) = &dt.type_data else { return None };
        Some(EnumValues {
            type_name: mdb.name2str(dt.name()).to_owned(),
            values: et.enumeration.iter().map(|v| (v.value, v.label.clone())).collect(),
        })
    }

    /// The highlighted character ranges of the hex dump and the scroll position for the given bit ranges
    pub fn highlight(ranges: &[(u32, u32)]) -> (Vec<(usize, usize)>, usize) {
        let r: Vec<BitRange> = ranges.iter().map(|(o, s)| BitRange { offset: *o as usize, size: *s as usize }).collect();
        hexdump::highlight(&r)
    }

    /// the raw bytes of a packet (for "Copy hex")
    pub fn packet_data(&self, nr: u32) -> Option<&[u8]> {
        Some(&self.packets[self.index_of(nr)?].data)
    }

    /// all the parameters of the MDB (qualified names)
    pub fn parameter_names(&self) -> Vec<String> {
        self.mdb.as_ref().map(|m| m.names.params.clone()).unwrap_or_default()
    }
}

struct Subject<'a> {
    name: &'a str,
    length: usize,
    mdb: Option<&'a Mdb>,
    result: Option<&'a TmResult>,
}

impl FilterSubject for Subject<'_> {
    fn packet_name(&self) -> &str {
        self.name
    }
    fn packet_length(&self) -> usize {
        self.length
    }
    fn value_by_qualified_name(&self, qn: &str) -> Option<String> {
        let (m, r) = (self.mdb?, self.result?);
        let pidx = *m.names.param_by_qn.get(qn)?;
        let pv = r.params.last_inserted(pidx)?;
        Some(eng_text(m.mdb(), pidx, &pv.eng_value))
    }
    fn value_by_name(&self, name: &str) -> Option<String> {
        let (m, r) = (self.mdb?, self.result?);
        let mdb = m.mdb();
        let pidx = r.params.iter().find(|pv| mdb.name2str(mdb.get_parameter(pv.pidx).name()) == name)?.pidx;
        let pv = r.params.last_inserted(pidx)?;
        Some(eng_text(mdb, pidx, &pv.eng_value))
    }
}

fn eng_text(mdb: &MissionDatabase, pidx: ParameterIdx, v: &xtce_rs::value::Value) -> String {
    match mdb.get_parameter(pidx).ptype {
        Some(t) => format::eng_value_to_string(mdb, mdb.get_data_type(t), v),
        None => format::value_to_string(mdb, v),
    }
}

fn ops_name(nd: &xtce_rs::mdb::NameDescription, mdb: &MissionDatabase) -> String {
    nd.ops_name().map(|s| s.to_owned()).unwrap_or_else(|| mdb.name2str(nd.name).to_owned())
}

/// Yamcs DoubleRange min/max: the inclusive or exclusive limit, -/+ infinity if none
fn range_min(r: Option<&NumericRange>) -> String {
    r.map_or(String::new(), |r| format::java_double(r.min_inclusive.or(r.min_exclusive).unwrap_or(f64::NEG_INFINITY)))
}

fn range_max(r: Option<&NumericRange>) -> String {
    r.map_or(String::new(), |r| format::java_double(r.max_inclusive.or(r.max_exclusive).unwrap_or(f64::INFINITY)))
}

/// the Calibration column of the Java viewer
fn calibration(mdb: &MissionDatabase, dtype: Option<&DataType>) -> Calibration {
    let Some(dt) = dtype else { return Calibration::None };
    match &dt.type_data {
        TypeData::Enumerated(_) => Calibration::Enumeration { type_name: mdb.name2str(dt.name()).to_owned() },
        TypeData::Aggregate(_) | TypeData::Array(_) => Calibration::None,
        _ => {
            let numeric_encoding = matches!(dt.encoding, DataEncoding::Integer(_) | DataEncoding::Float(_));
            let text = match (&dt.calibrator, numeric_encoding) {
                (Some(c), true) => format::calibrator_to_string(c),
                _ => String::new(),
            };
            Calibration::Text { text }
        }
    }
}

/// qualified names of the parameters and containers
fn compute_names(mdb: &MissionDatabase) -> Names {
    let mut params = vec![String::new(); mdb.parameters.len()];
    let mut containers = vec![String::new(); mdb.containers.len()];
    let mut param_by_qn = HashMap::new();
    for ss in &mdb.space_systems {
        let ssqn = mdb.qn_to_string(&ss.fqn);
        let prefix = ssqn.trim_end_matches('/');
        for (name, pidx) in &ss.parameters {
            let qn = format!("{}/{}", prefix, mdb.name2str(*name));
            param_by_qn.insert(qn.clone(), *pidx);
            params[pidx.index()] = qn;
        }
        for (name, cidx) in &ss.containers {
            containers[cidx.index()] = format!("{}/{}", prefix, mdb.name2str(*name));
        }
    }
    Names { params, containers, param_by_qn }
}

/// a root container when Yamcs did not tell: the container without base with the most descendants
/// (alphabetical order on ties)
fn guess_root(mdb: &MissionDatabase) -> Option<ContainerIdx> {
    fn descendants(mdb: &MissionDatabase, c: ContainerIdx, depth: usize) -> usize {
        if depth > 64 {
            return 0;
        }
        mdb.child_containers
            .get(&c)
            .map_or(0, |ch| ch.iter().map(|x| 1 + descendants(mdb, *x, depth + 1)).sum())
    }
    let names = compute_names(mdb);
    mdb.containers
        .iter()
        .filter(|c| c.base_container.is_none())
        .map(|c| (descendants(mdb, c.idx, 0), &names.containers[c.idx.index()], c.idx))
        .max_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(a.1)))
        .map(|x| x.2)
}

/// The structure tree, built like the Java viewer (`PacketViewer.process`): a container node is moved to
/// the end of its parent each time an entry is added below it.
struct Tree {
    nodes: Vec<(String, Option<(u32, u32)>, Vec<usize>, Option<usize>)>,
    containers: HashMap<String, usize>,
}

impl Tree {
    fn new(root_label: String) -> Tree {
        Tree { nodes: vec![(root_label, None, Vec::new(), None)], containers: HashMap::new() }
    }

    fn add_node(&mut self, label: String, range: Option<(u32, u32)>) -> usize {
        self.nodes.push((label, range, Vec::new(), None));
        self.nodes.len() - 1
    }

    /// DefaultMutableTreeNode.add: removes the child from its parent and appends it
    fn attach(&mut self, parent: usize, child: usize) {
        if let Some(old) = self.nodes[child].3 {
            self.nodes[old].2.retain(|c| *c != child);
        }
        self.nodes[parent].2.push(child);
        self.nodes[child].3 = Some(parent);
    }

    fn container_node(&mut self, mdb: &MissionDatabase, start: u32, c: ContainerIdx) -> usize {
        let sc = mdb.get_container(c);
        let label = ops_name(&sc.ndescr, mdb);
        let key = format!("{}:{}", start, label);
        match sc.base_container {
            None => {
                if start == 0 {
                    return 0;
                }
                if let Some(n) = self.containers.get(&key) {
                    return *n;
                }
                let n = self.add_node(label, None);
                self.containers.insert(key, n);
                self.attach(0, n);
                n
            }
            Some((base, _)) => {
                let n = match self.containers.get(&key) {
                    Some(n) => *n,
                    None => {
                        let n = self.add_node(label, None);
                        self.containers.insert(key, n);
                        n
                    }
                };
                let parent = self.container_node(mdb, start, base);
                self.attach(parent, n);
                n
            }
        }
    }

    fn export(&self, n: usize) -> TreeNode {
        let (label, range, children, _) = &self.nodes[n];
        TreeNode {
            label: label.clone(),
            bit_offset: range.map(|r| r.0),
            bit_size: range.map(|r| r.1),
            children: children.iter().map(|c| self.export(*c)).collect(),
        }
    }
}
