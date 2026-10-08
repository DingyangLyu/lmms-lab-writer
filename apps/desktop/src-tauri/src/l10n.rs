//! Chinese or English for backend messages that reach the interface.
//!
//! The frontend reports the interface language with the `set_locale` command; Chinese is the default until it
//! does. Use `tr!("中文", "English")` for fixed text and `trf!("…{x}", "…{x}", args)` to format.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
thread_local! {
    /// Tests choose a language per thread so parallel tests keep the Chinese default.
    static TEST_ENGLISH: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

pub fn english() -> bool {
    #[cfg(test)]
    if let Some(english) = TEST_ENGLISH.with(|value| value.get()) {
        return english;
    }
    ENGLISH.load(Ordering::Relaxed)
}

/// The interface language code: "en" or "zh".
pub fn locale() -> &'static str {
    if english() {
        "en"
    } else {
        "zh"
    }
}

pub fn set_english(english: bool) {
    ENGLISH.store(english, Ordering::Relaxed);
}

#[macro_export]
macro_rules! tr {
    ($zh:literal, $en:literal $(,)?) => {
        if $crate::l10n::english() {
            $en
        } else {
            $zh
        }
    };
}

#[macro_export]
macro_rules! trf {
    ($zh:literal, $en:literal $(, $($arg:tt)*)?) => {
        if $crate::l10n::english() {
            format!($en $(, $($arg)*)?)
        } else {
            format!($zh $(, $($arg)*)?)
        }
    };
}

#[cfg(test)]
mod tests {
    #[test]
    fn picks_the_interface_language() {
        let name = "main.tex";
        assert_eq!(tr!("保存", "Save"), "保存");
        assert_eq!(
            trf!("无法读取 {name}", "Could not read {name}"),
            "无法读取 main.tex"
        );
        assert_eq!(trf!("第 {} 行", "Line {}", 3), "第 3 行");
        assert_eq!(super::locale(), "zh");
        super::TEST_ENGLISH.with(|value| value.set(Some(true)));
        assert_eq!(tr!("保存", "Save"), "Save");
        assert_eq!(
            trf!("无法读取 {name}", "Could not read {name}"),
            "Could not read main.tex"
        );
        assert_eq!(trf!("第 {} 行", "Line {}", 3), "Line 3");
        assert_eq!(super::locale(), "en");
    }
}
