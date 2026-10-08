/// The frontend reports its interface language ("zh" or "en") for backend messages.
#[tauri::command]
pub fn set_locale(app: tauri::AppHandle, locale: String) {
    crate::l10n::set_english(locale == "en");
    super::windows::relabel_menu(&app);
}
