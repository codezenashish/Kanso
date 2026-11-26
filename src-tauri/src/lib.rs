mod database;
#[cfg(desktop)]
mod window_state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            #[cfg(desktop)]
            window_state::attach(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::load_workspace,
            database::save_workspace,
            database::attachments::markdown::pick_markdown_import,
            database::attachments::markdown::export_markdown_files,
            database::attachments::import_attachment,
            database::attachments::resolve_attachment,
            database::attachments::open_attachment,
            database::attachments::import_attachment_bytes,
            database::attachments::read_attachment_image,
            database::attachments::lifecycle::attachment_storage,
            database::attachments::lifecycle::cleanup_attachments,
            database::attachments::portable::export_attachment_backup,
            database::attachments::portable::restore_attachment_backup,
            database::history::list_note_versions,
            database::history::get_note_version,
            database::history::create_note_version,
            database::history::prune_note_versions,
            database::history::get_version_history_config,
            database::history::update_version_history_config,
            database::history::restore_note_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kanso application");
}
