//! Yamcs time formats

use xtce_rs::time::{self, INVALID_INSTANT};

/// Java `TimeEncoding.toCombinedFormat`: `2023-05-04/124T11:25:35.687` (UTC, no zone)
pub fn combined(instant: i64) -> String {
    if instant == INVALID_INSTANT {
        return String::new();
    }
    // "YYYY-MM-DDTHH:MM:SS.mmmZ"
    let s = time::to_string(instant);
    let (y, m, d) = match (s.get(0..4), s.get(5..7), s.get(8..10)) {
        (Some(y), Some(m), Some(d)) => (y, m, d),
        _ => return s,
    };
    let (Ok(yi), Ok(mi), Ok(di)) = (y.parse::<i32>(), m.parse::<u32>(), d.parse::<u32>()) else {
        return s;
    };
    format!("{}-{}-{}/{:03}T{}", y, m, d, day_of_year(yi, mi, di), s[11..].trim_end_matches('Z'))
}

fn day_of_year(y: i32, m: u32, d: u32) -> u32 {
    const CUM: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    CUM[(m as usize - 1).min(11)] + d + if leap && m > 2 { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combined_format() {
        let t = time::parse("2023-05-04T11:25:35.687Z").unwrap();
        assert_eq!("2023-05-04/124T11:25:35.687", combined(t));
        let t = time::parse("2024-12-31T23:59:59.999Z").unwrap();
        assert_eq!("2024-12-31/366T23:59:59.999", combined(t));
        assert_eq!("", combined(INVALID_INSTANT));
    }
}
