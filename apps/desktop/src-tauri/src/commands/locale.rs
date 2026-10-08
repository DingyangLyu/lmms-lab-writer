/// The frontend reports its interface language ("zh" or "en") for backend messages.
#[tauri::command]
pub fn set_locale(locale: String) {
    crate::l10n::set_english(locale == "en");
}
