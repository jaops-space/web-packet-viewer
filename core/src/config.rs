//! Configuration, with the keys of the Java `packet-viewer.yaml` (given here as JSON).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{prepro::Preprocessor, split::Splitter};

pub const CCSDS_INPUT_STREAM: &str = "org.yamcs.tctm.CcsdsPacketInputStream";
pub const GENERIC_INPUT_STREAM: &str = "org.yamcs.tctm.GenericPacketInputStream";
pub const ISS_PREPROCESSOR: &str = "org.yamcs.tctm.IssPacketPreprocessor";
pub const GENERIC_PREPROCESSOR: &str = "org.yamcs.tctm.GenericPacketPreprocessor";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerConfig {
    /// alias namespace used for the packet names (default: qualified names)
    #[serde(default)]
    pub default_namespace: Option<String>,
    /// preprocessor of the realtime packets and default one of the file formats
    #[serde(default)]
    pub packet_preprocessor_class_name: Option<String>,
    #[serde(default)]
    pub packet_preprocessor_args: Option<Map<String, Value>>,
    #[serde(default)]
    pub file_formats: Vec<FileFormatConfig>,
    /// legacy single format (used if there are no fileFormats)
    #[serde(default)]
    pub packet_input_stream_class_name: Option<String>,
    #[serde(default)]
    pub packet_input_stream_args: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFormatConfig {
    pub name: String,
    pub packet_input_stream_class_name: String,
    #[serde(default)]
    pub packet_input_stream_args: Option<Map<String, Value>>,
    #[serde(default)]
    pub packet_preprocessor_class_name: Option<String>,
    #[serde(default)]
    pub packet_preprocessor_args: Option<Map<String, Value>>,
    #[serde(default)]
    pub root_container: Option<String>,
}

/// A file format ready to use
#[derive(Debug, Clone)]
pub struct FileFormat {
    pub name: String,
    pub splitter: Splitter,
    pub preprocessor: Preprocessor,
    pub root_container: Option<String>,
}

impl ViewerConfig {
    /// the preprocessor of the packets received from Yamcs
    pub fn realtime_preprocessor(&self) -> Result<Preprocessor, String> {
        Preprocessor::from_config(
            self.packet_preprocessor_class_name.as_deref().unwrap_or(ISS_PREPROCESSOR),
            self.packet_preprocessor_args.as_ref(),
        )
    }

    /// the file formats, with the defaults of the Java packet viewer
    pub fn file_formats(&self) -> Result<Vec<FileFormat>, String> {
        let realtime = self.realtime_preprocessor()?;
        if self.file_formats.is_empty() {
            let (name, class) = match &self.packet_input_stream_class_name {
                Some(c) => ("Default", c.as_str()),
                None => ("CCSDS Packets", CCSDS_INPUT_STREAM),
            };
            return Ok(vec![FileFormat {
                name: name.to_owned(),
                splitter: Splitter::from_config(class, self.packet_input_stream_args.as_ref())?,
                preprocessor: realtime,
                root_container: None,
            }]);
        }
        self.file_formats
            .iter()
            .map(|f| {
                let preprocessor = match &f.packet_preprocessor_class_name {
                    Some(c) => Preprocessor::from_config(c, f.packet_preprocessor_args.as_ref())?,
                    None => realtime.clone(),
                };
                Ok(FileFormat {
                    name: f.name.clone(),
                    splitter: Splitter::from_config(&f.packet_input_stream_class_name, f.packet_input_stream_args.as_ref())
                        .map_err(|e| format!("file format {}: {}", f.name, e))?,
                    preprocessor,
                    root_container: f.root_container.clone(),
                })
            })
            .collect()
    }
}

/// helpers to read the (YConfiguration like) arguments
pub(crate) struct Args<'a>(pub Option<&'a Map<String, Value>>);

impl<'a> Args<'a> {
    pub fn get(&self, key: &str) -> Option<&'a Value> {
        self.0.and_then(|m| m.get(key))
    }
    pub fn int(&self, key: &str) -> Result<i64, String> {
        self.int_opt(key)?.ok_or_else(|| format!("missing argument '{}'", key))
    }
    pub fn int_or(&self, key: &str, default: i64) -> Result<i64, String> {
        Ok(self.int_opt(key)?.unwrap_or(default))
    }
    pub fn int_opt(&self, key: &str) -> Result<Option<i64>, String> {
        match self.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v.as_i64().map(Some).ok_or_else(|| format!("argument '{}' must be an integer", key)),
        }
    }
    pub fn f64_or(&self, key: &str, default: f64) -> Result<f64, String> {
        match self.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(v) => v.as_f64().ok_or_else(|| format!("argument '{}' must be a number", key)),
        }
    }
    pub fn bool_or(&self, key: &str, default: bool) -> Result<bool, String> {
        match self.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(v) => v.as_bool().ok_or_else(|| format!("argument '{}' must be a boolean", key)),
        }
    }
    pub fn str_opt(&self, key: &str) -> Result<Option<&'a str>, String> {
        match self.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v.as_str().map(Some).ok_or_else(|| format!("argument '{}' must be a string", key)),
        }
    }
    pub fn map(&self, key: &str) -> Option<&'a Map<String, Value>> {
        self.get(key).and_then(|v| v.as_object())
    }
}

/// Java `AbstractPacketPreprocessor.getByteOrder`
pub(crate) fn byte_order(args: &Args) -> Result<bool, String> {
    match args.str_opt("byteOrder")? {
        None => Ok(true),
        Some(s) if s.eq_ignore_ascii_case("BIG_ENDIAN") => Ok(true),
        Some(s) if s.eq_ignore_ascii_case("LITTLE_ENDIAN") => Ok(false),
        Some(s) => Err(format!("Invalid '{}' byte order specified. Use one of BIG_ENDIAN or LITTLE_ENDIAN", s)),
    }
}
