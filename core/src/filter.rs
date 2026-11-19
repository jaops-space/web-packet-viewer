//! The display filter of the packet viewer: a port of the JavaCC grammar `PacketFilter.jj` and of
//! `PacketFilter.matches`, with the same lexical states and the same quirks:
//!
//! - after a reference the lexer is in the "expression" state, where `AND`, `OR`, `(` and `)` are not
//!   tokens: a reference without comparison is valid only at the end of the expression;
//! - unquoted literals cannot contain `.`: `x == "1.5"` must be quoted;
//! - `NOT`/`!` must be followed by a parenthesized expression.
//!
//! Where the Java code throws an exception while matching (unknown qualified parameter in the packet,
//! number format, regular expression syntax) the packet does not match.

use std::{cmp::Ordering, collections::BTreeSet, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    EqualTo,
    NotEqualTo,
    GreaterThan,
    GreaterThanOrEqualTo,
    LessThan,
    LessThanOrEqualTo,
    Contains,
    Matches,
}

#[derive(Debug, Clone)]
pub struct Comparison {
    pub reference: String,
    pub op: Option<Operator>,
    pub comparand: String,
    /// compiled for MATCHES; None if the regular expression is invalid
    regex: Option<regex_lite::Regex>,
}

#[derive(Debug, Clone)]
pub enum Unary {
    Comparison(Comparison),
    Expr(Or),
}

#[derive(Debug, Clone)]
pub struct UnaryExpression {
    pub not: bool,
    pub expr: Unary,
}

#[derive(Debug, Clone)]
pub struct And(pub Vec<UnaryExpression>);

#[derive(Debug, Clone)]
pub struct Or(pub Vec<And>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterError {
    pub message: String,
    /// character position in the expression
    pub position: usize,
}

impl fmt::Display for FilterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at position {}", self.message, self.position)
    }
}

/// What the filter needs to know about a packet
pub trait FilterSubject {
    fn packet_name(&self) -> &str;
    fn packet_length(&self) -> usize;
    /// the engineering value (Yamcs text) of the last value of the parameter with this qualified name in the
    /// packet; None if the parameter is unknown or not in the packet
    fn value_by_qualified_name(&self, qualified_name: &str) -> Option<String>;
    /// the engineering value (Yamcs text) of the first parameter of the packet with this (short) name;
    /// None if there is no such parameter in the packet
    fn value_by_name(&self, name: &str) -> Option<String>;
}

#[derive(Debug, Clone)]
pub struct PacketFilter {
    expression: Or,
    references: BTreeSet<String>,
}

impl PacketFilter {
    pub fn parse(text: &str) -> Result<PacketFilter, FilterError> {
        let tokens = lex(text)?;
        let mut p = Parser { tokens, pos: 0, references: BTreeSet::new() };
        let expression = p.or()?;
        p.expect(Tok::Eof)?;
        Ok(PacketFilter { expression, references: p.references })
    }

    /// the references (parameter names, `packet.name`...) used in the filter
    pub fn references(&self) -> &BTreeSet<String> {
        &self.references
    }

    pub fn expression(&self) -> &Or {
        &self.expression
    }

    pub fn matches(&self, packet: &dyn FilterSubject) -> bool {
        match_or(&self.expression, packet)
    }
}

/// The expression of the "Apply as Filter" context menu: `name == value` or, for "Not Selected",
/// `!(name == value)` (which also keeps the packets without the parameter).
///
/// Unlike the Java version, the value is quoted when needed (e.g. `"12.5"`), so the expression is valid.
pub fn filter_expression_for(name: &str, eng_value: &str, not: bool) -> String {
    let value = if !eng_value.is_empty() && eng_value.chars().all(is_string_char) {
        eng_value.to_owned()
    } else {
        format!("\"{}\"", eng_value.replace('\\', "\\\\").replace('"', "\\\""))
    };
    if not {
        format!("!({} == {})", name, value)
    } else {
        format!("{} == {}", name, value)
    }
}

fn match_or(e: &Or, packet: &dyn FilterSubject) -> bool {
    e.0.iter().any(|and| and.0.iter().all(|u| match_unary(u, packet)))
}

fn match_unary(u: &UnaryExpression, packet: &dyn FilterSubject) -> bool {
    let r = match &u.expr {
        Unary::Comparison(c) => match_comparison(c, packet),
        Unary::Expr(e) => match_or(e, packet),
    };
    r != u.not
}

fn match_comparison(c: &Comparison, packet: &dyn FilterSubject) -> bool {
    let value = match c.reference.as_str() {
        "packet.name" => packet.packet_name().to_owned(),
        "packet.length" => packet.packet_length().to_string(),
        r if r.starts_with('/') => match packet.value_by_qualified_name(r) {
            Some(v) => v,
            None => return false,
        },
        r => match packet.value_by_name(r) {
            Some(v) => v,
            None => return false,
        },
    };
    let Some(op) = c.op else {
        return true;
    };
    let num = |f: fn(Ordering) -> bool| match (java_parse_double(&value), java_parse_double(&c.comparand)) {
        (Some(a), Some(b)) => f(java_double_compare(a, b)),
        _ => false,
    };
    match op {
        Operator::EqualTo => value == c.comparand,
        Operator::NotEqualTo => value != c.comparand,
        Operator::GreaterThan => num(|o| o == Ordering::Greater),
        Operator::GreaterThanOrEqualTo => num(|o| o != Ordering::Less),
        Operator::LessThan => num(|o| o == Ordering::Less),
        Operator::LessThanOrEqualTo => num(|o| o != Ordering::Greater),
        Operator::Contains => value.to_lowercase().contains(&c.comparand.to_lowercase()),
        Operator::Matches => c.regex.as_ref().is_some_and(|re| re.is_match(&value)),
    }
}

/// Java `Double.compareTo`: -0.0 < 0.0, NaN is equal to itself and greater than everything
fn java_double_compare(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => a.total_cmp(&b),
    }
}

/// Java `Double.valueOf` (decimal forms; hexadecimal floating point literals are not supported)
pub fn java_parse_double(s: &str) -> Option<f64> {
    let s = s.trim_matches(|c: char| c <= ' ');
    let (sign, body) = match s.as_bytes().first() {
        Some(b'-') => (-1.0, &s[1..]),
        Some(b'+') => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    match body {
        "NaN" => return Some(f64::NAN),
        "Infinity" => return Some(sign * f64::INFINITY),
        _ => {}
    }
    let body = body.strip_suffix(['f', 'F', 'd', 'D']).unwrap_or(body);
    // only digits, one dot, an exponent: refuse what Rust accepts and Java does not (inf, nan...)
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
        return None;
    }
    body.parse::<f64>().ok().map(|x| sign * x)
}

// ---------------------------------------------------------------- lexer

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    And,
    Or,
    Not,
    LParen,
    RParen,
    Ref(String),
    Op(Operator),
    Str(String),
    Quoted(String),
    Eof,
}

impl Tok {
    fn describe(&self) -> String {
        match self {
            Tok::And => "AND".into(),
            Tok::Or => "OR".into(),
            Tok::Not => "NOT".into(),
            Tok::LParen => "\"(\"".into(),
            Tok::RParen => "\")\"".into(),
            Tok::Ref(s) | Tok::Str(s) => format!("\"{}\"", s),
            Tok::Quoted(s) => s.clone(),
            Tok::Op(o) => format!("{:?}", o),
            Tok::Eof => "end of expression".into(),
        }
    }
}

fn is_ref_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '[' | ']' | '.')
}

fn is_string_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '/' | '-')
}

/// length (in bytes) of the literal at the start of s, ignoring case, or 0
fn lit(s: &str, literal: &str) -> usize {
    if s.len() >= literal.len() && s.as_bytes()[..literal.len()].eq_ignore_ascii_case(literal.as_bytes()) {
        literal.len()
    } else {
        0
    }
}

/// the tokens with their positions; like JavaCC: longest match, the first declared token on equal lengths
fn lex(text: &str) -> Result<Vec<(Tok, usize)>, FilterError> {
    let mut out = Vec::new();
    let mut in_expression = false;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let c = rest.chars().next().unwrap();
        if matches!(c, ' ' | '\t' | '\n' | '\r') {
            i += 1;
            continue;
        }
        // candidates in declaration order: (length, token kind)
        let mut best: Option<(usize, Tok)> = None;
        let mut consider = |len: usize, tok: &dyn Fn(&str) -> Tok| {
            if len > 0 && best.as_ref().map_or(true, |(l, _)| len > *l) {
                best = Some((len, tok(&rest[..len])));
            }
        };
        if !in_expression {
            consider(lit(rest, "AND").max(lit(rest, "&&")), &|_| Tok::And);
            consider(lit(rest, "OR").max(lit(rest, "||")), &|_| Tok::Or);
            consider(lit(rest, "NOT").max(lit(rest, "!")), &|_| Tok::Not);
            consider(lit(rest, "("), &|_| Tok::LParen);
            consider(lit(rest, ")"), &|_| Tok::RParen);
            let n = rest.find(|c| !is_ref_char(c)).unwrap_or(rest.len());
            consider(n, &|s| Tok::Ref(s.to_owned()));
        } else {
            use Operator::*;
            consider(lit(rest, "EQ").max(lit(rest, "==")), &|_| Tok::Op(EqualTo));
            consider(lit(rest, "NE").max(lit(rest, "!=")), &|_| Tok::Op(NotEqualTo));
            consider(lit(rest, "LT").max(lit(rest, "<")), &|_| Tok::Op(LessThan));
            consider(lit(rest, "LE").max(lit(rest, "<=")), &|_| Tok::Op(LessThanOrEqualTo));
            consider(lit(rest, "GT").max(lit(rest, ">")), &|_| Tok::Op(GreaterThan));
            consider(lit(rest, "GE").max(lit(rest, ">=")), &|_| Tok::Op(GreaterThanOrEqualTo));
            consider(lit(rest, "CONTAINS"), &|_| Tok::Op(Contains));
            consider(lit(rest, "MATCHES").max(lit(rest, "~")), &|_| Tok::Op(Matches));
            let n = rest.find(|c| !is_string_char(c)).unwrap_or(rest.len());
            consider(n, &|s| Tok::Str(s.to_owned()));
            consider(quoted_len(rest), &|s| Tok::Quoted(s.to_owned()));
        }
        let Some((len, tok)) = best else {
            return Err(FilterError { message: format!("unexpected character '{}'", c), position: char_pos(text, i) });
        };
        match tok {
            Tok::Ref(_) => in_expression = true,
            Tok::Str(_) | Tok::Quoted(_) => in_expression = false,
            _ => {}
        }
        out.push((tok, char_pos(text, i)));
        i += len;
    }
    out.push((Tok::Eof, text.chars().count()));
    Ok(out)
}

/// length of a quoted string at the start of s (including the quotes), 0 if none
fn quoted_len(s: &str) -> usize {
    let mut chars = s.char_indices();
    if !matches!(chars.next(), Some((_, '"'))) {
        return 0;
    }
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return i + 1,
            '\\' => {
                if chars.next().is_none() {
                    return 0;
                }
            }
            _ => {}
        }
    }
    0
}

fn char_pos(text: &str, byte_pos: usize) -> usize {
    text[..byte_pos].chars().count()
}

// ---------------------------------------------------------------- parser

struct Parser {
    tokens: Vec<(Tok, usize)>,
    pos: usize,
    references: BTreeSet<String>,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.tokens[self.pos].0
    }

    fn next(&mut self) -> Tok {
        let t = self.tokens[self.pos].0.clone();
        if self.pos < self.tokens.len() - 1 {
            self.pos += 1;
        }
        t
    }

    fn error(&self, expected: &str) -> FilterError {
        let (tok, position) = &self.tokens[self.pos];
        FilterError { message: format!("expected {}, found {}", expected, tok.describe()), position: *position }
    }

    fn expect(&mut self, t: Tok) -> Result<(), FilterError> {
        if *self.peek() == t {
            self.next();
            Ok(())
        } else {
            Err(self.error(&t.describe()))
        }
    }

    fn or(&mut self) -> Result<Or, FilterError> {
        let mut clauses = vec![self.and()?];
        while *self.peek() == Tok::Or {
            self.next();
            clauses.push(self.and()?);
        }
        Ok(Or(clauses))
    }

    fn and(&mut self) -> Result<And, FilterError> {
        let mut clauses = vec![self.unary()?];
        while *self.peek() == Tok::And {
            self.next();
            clauses.push(self.unary()?);
        }
        Ok(And(clauses))
    }

    fn unary(&mut self) -> Result<UnaryExpression, FilterError> {
        match self.peek().clone() {
            Tok::Not => {
                self.next();
                self.expect(Tok::LParen)?;
                let e = self.or()?;
                self.expect(Tok::RParen)?;
                Ok(UnaryExpression { not: true, expr: Unary::Expr(e) })
            }
            Tok::LParen => {
                self.next();
                let e = self.or()?;
                self.expect(Tok::RParen)?;
                Ok(UnaryExpression { not: false, expr: Unary::Expr(e) })
            }
            Tok::Ref(r) => {
                self.next();
                self.references.insert(r.clone());
                let (op, comparand) = if let Tok::Op(op) = self.peek().clone() {
                    self.next();
                    let comparand = match self.next() {
                        Tok::Str(s) => s,
                        Tok::Quoted(q) => q[1..q.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\"),
                        _ => {
                            self.pos -= 1;
                            return Err(self.error("a value"));
                        }
                    };
                    (Some(op), comparand)
                } else {
                    (None, String::new())
                };
                let regex = if op == Some(Operator::Matches) {
                    regex_lite::Regex::new(&format!("(?i)\\A(?:{})\\z", comparand)).ok()
                } else {
                    None
                };
                Ok(UnaryExpression { not: false, expr: Unary::Comparison(Comparison { reference: r, op, comparand, regex }) })
            }
            _ => Err(self.error("a parameter, NOT or \"(\"")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct P {
        name: &'static str,
        len: usize,
        values: Vec<(&'static str, &'static str, &'static str)>, // qualified name, short name, value
    }

    impl FilterSubject for P {
        fn packet_name(&self) -> &str {
            self.name
        }
        fn packet_length(&self) -> usize {
            self.len
        }
        fn value_by_qualified_name(&self, qn: &str) -> Option<String> {
            self.values.iter().rev().find(|v| v.0 == qn).map(|v| v.2.to_owned())
        }
        fn value_by_name(&self, n: &str) -> Option<String> {
            self.values.iter().find(|v| v.1 == n).map(|v| v.2.to_owned())
        }
    }

    fn packet() -> P {
        P {
            name: "/YSS/SIMULATOR/DHS",
            len: 28,
            values: vec![
                ("/YSS/ccsds-apid", "ccsds-apid", "1"),
                ("/YSS/SIMULATOR/Mode", "Mode", "SAFE"),
                ("/YSS/SIMULATOR/Volt", "Volt", "12.5"),
                ("/YSS/SIMULATOR/Neg", "Neg", "-3"),
            ],
        }
    }

    fn m(expr: &str) -> bool {
        PacketFilter::parse(expr).unwrap_or_else(|e| panic!("{}: {}", expr, e)).matches(&packet())
    }

    fn valid(expr: &str) -> bool {
        PacketFilter::parse(expr).is_ok()
    }

    #[test]
    fn comparisons() {
        assert!(m("ccsds-apid == 1"));
        assert!(m("ccsds-apid eq 1"));
        assert!(!m("ccsds-apid != 1"));
        assert!(m("Volt > 12"));
        assert!(m("Volt >= \"12.5\""));
        assert!(!m("Volt < 12"));
        assert!(m("Neg LT 0"));
        assert!(m("Neg le -3"));
        assert!(m("Mode contains af"));
        assert!(m("Mode CONTAINS \"AF\""));
        assert!(m("Mode ~ \"s.*\""));
        assert!(!valid("Mode ~ s.*"));
        assert!(m("Mode matches \"S.F.\""));
        assert!(!m("Mode matches \"S.F\""));
        // numeric comparison of a non number: no match (exception in Java)
        assert!(!m("Mode > 1"));
        // string equality, case sensitive
        assert!(!m("Mode == safe"));
    }

    #[test]
    fn references() {
        assert!(m("packet.name == /YSS/SIMULATOR/DHS"));
        assert!(m("packet.length == 28"));
        assert!(m("packet.length > 27"));
        assert!(m("/YSS/SIMULATOR/Mode == SAFE"));
        // unknown parameter: no match
        assert!(!m("/YSS/SIMULATOR/Other == SAFE"));
        assert!(!m("Other == SAFE"));
        // "Not Selected" of the context menu: also the packets without the parameter
        assert!(m("!(Other == SAFE)"));
        // presence
        assert!(m("Mode"));
        assert!(!m("Other"));
        let f = PacketFilter::parse("a == 1 OR (b != 2 AND /x/c ~ q)").unwrap();
        assert_eq!(vec!["/x/c", "a", "b"], f.references().iter().collect::<Vec<_>>());
    }

    #[test]
    fn boolean_logic() {
        assert!(m("ccsds-apid == 2 OR Mode == SAFE"));
        assert!(!m("ccsds-apid == 2 || Mode == SAFE && Volt < 0"));
        assert!(m("ccsds-apid == 1 && (Mode == OTHER OR Volt > 10)"));
        assert!(m("NOT(ccsds-apid == 2)"));
        assert!(m("!(ccsds-apid == 2) and Mode == SAFE"));
        assert!(m("ccsds-apid == 1 AND Mode"));
    }

    #[test]
    fn quirks_of_the_java_grammar() {
        assert!(valid("x == 1"));
        assert!(valid("x"));
        assert!(valid("x == 1 AND y"));
        // a reference without comparison is only valid at the end
        assert!(!valid("x AND y == 1"));
        assert!(!valid("(x)"));
        // unquoted values cannot contain '.'
        assert!(!valid("x == 1.5"));
        assert!(valid("x == \"1.5\""));
        // NOT needs parentheses
        assert!(!valid("NOT x == 1"));
        assert!(!valid("!x"));
        // keywords are case insensitive, longest match wins
        assert!(valid("x == 1 and y == 2"));
        assert!(valid("ORx == 1"));
        assert!(!valid("x == 1 AND"));
        assert!(!valid(""));
        assert!(!valid("x =="));
        assert!(!valid("x == \"unterminated"));
        // array/member references
        assert!(valid("arr[1].m == 3"));
    }

    #[test]
    fn quoted_strings() {
        let f = PacketFilter::parse(r#"x == "a \"b\" c\\d""#).unwrap();
        let Unary::Comparison(c) = &f.expression().0[0].0[0].expr else { panic!() };
        assert_eq!(r#"a "b" c\d"#, c.comparand);
    }

    #[test]
    fn invalid_regex_does_not_match() {
        assert!(valid("Mode ~ \"(\""));
        assert!(!m("Mode ~ \"(\""));
    }

    #[test]
    fn error_position() {
        let e = PacketFilter::parse("x == 1 AND (y").unwrap_err();
        assert_eq!(13, e.position);
    }

    #[test]
    fn java_doubles() {
        assert_eq!(Some(1.5), java_parse_double(" 1.5 "));
        assert_eq!(Some(2.0), java_parse_double("2f"));
        assert_eq!(Some(-1e3), java_parse_double("-1.0E3"));
        assert_eq!(None, java_parse_double("inf"));
        assert_eq!(None, java_parse_double("abc"));
        assert!(java_parse_double("NaN").unwrap().is_nan());
        assert_eq!(Some(f64::NEG_INFINITY), java_parse_double("-Infinity"));
        assert_eq!(Ordering::Less, java_double_compare(-0.0, 0.0));
        assert_eq!(Ordering::Greater, java_double_compare(f64::NAN, f64::INFINITY));
    }
}
