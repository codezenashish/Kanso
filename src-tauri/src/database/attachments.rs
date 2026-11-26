pub(crate) mod lifecycle;
pub(crate) mod markdown;
pub(crate) mod portable;
pub(super) mod references;
mod storage;
#[cfg(test)]
mod tests;

use super::{WORKSPACE_ID, app_data_directory, database};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, WebviewWindow, async_runtime::spawn_blocking};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentError {
    InvalidFile,
    FileTooLarge,
    UnsupportedType,
    NoteNotAvailable,
    AttachmentNotFound,
    ManagedFileMissing,
    ManagedFileInvalid,
    StorageUnavailable,
    DatabaseUnavailable,
    OpenFailed,
    CleanupChanged,
    InvalidBackup,
    BackupTooLarge,
}

impl From<sqlx::Error> for AttachmentError {
    fn from(_: sqlx::Error) -> Self {
        Self::DatabaseUnavailable
    }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub(in crate::database) id: String,
    original_filename: String,
    mime_type: String,
    size_bytes: i64,
    #[serde(skip_serializing)]
    digest: String,
}

async fn save_attachment(
    pool: &SqlitePool,
    note_id: &str,
    staged: storage::StagedAttachment,
) -> Result<Attachment, AttachmentError> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let note_available: bool = sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM notes WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL
        )",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !note_available {
        return Err(AttachmentError::NoteNotAvailable);
    }

    sqlx::query(
        "INSERT INTO attachments (workspace_id, id, digest, original_filename, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, digest, original_filename) DO NOTHING",
    )
    .bind(WORKSPACE_ID)
    .bind(Uuid::new_v4().to_string())
    .bind(&staged.digest)
    .bind(&staged.original_filename)
    .bind(staged.mime_type)
    .bind(staged.size_bytes)
    .execute(&mut *transaction)
    .await?;

    let attachment = sqlx::query_as::<_, Attachment>(
        "SELECT id, original_filename, mime_type, size_bytes, digest FROM attachments
         WHERE workspace_id = ? AND digest = ? AND original_filename = ?",
    )
    .bind(WORKSPACE_ID)
    .bind(&staged.digest)
    .bind(&staged.original_filename)
    .fetch_one(&mut *transaction)
    .await?;

    sqlx::query(
        "INSERT INTO note_attachments (workspace_id, note_id, attachment_id) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, note_id, attachment_id) DO NOTHING",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(&attachment.id)
    .execute(&mut *transaction)
    .await?;

    // Publish first. If commit is interrupted, the verified blob can be reused by a retry.
    filesystem_task(move || staged.publish()).await?;
    transaction.commit().await?;
    Ok(attachment)
}

async fn find_attachment(
    pool: &SqlitePool,
    note_id: &str,
    attachment_id: &str,
) -> Result<Attachment, AttachmentError> {
    let id = Uuid::parse_str(attachment_id).map_err(|_| AttachmentError::AttachmentNotFound)?;
    sqlx::query_as::<_, Attachment>(
        "SELECT attachments.id, original_filename, mime_type, size_bytes, digest
         FROM attachments JOIN note_attachments
           ON note_attachments.workspace_id = attachments.workspace_id
          AND note_attachments.attachment_id = attachments.id
         WHERE attachments.workspace_id = ? AND note_id = ? AND attachments.id = ?",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(id.to_string())
    .fetch_optional(pool)
    .await?
    .ok_or(AttachmentError::AttachmentNotFound)
}

pub(in crate::database) async fn load_attachment(
    pool: &SqlitePool,
    directory: &Path,
    note_id: &str,
    attachment_id: &str,
) -> Result<(Attachment, PathBuf), AttachmentError> {
    let attachment = find_attachment(pool, note_id, attachment_id).await?;
    let directory = directory.to_path_buf();
    filesystem_task(move || {
        let (path, _) = storage::verified_file(&directory, &attachment)?;
        Ok((attachment, path))
    })
    .await
}

async fn filesystem_task<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, AttachmentError> + Send + 'static,
) -> Result<T, AttachmentError> {
    spawn_blocking(task)
        .await
        .map_err(|_| AttachmentError::StorageUnavailable)?
}

fn local_data_directory(app: &AppHandle) -> Result<PathBuf, AttachmentError> {
    app_data_directory(app).map_err(|_| AttachmentError::StorageUnavailable)
}

async fn attachment_database(app: &AppHandle) -> Result<SqlitePool, AttachmentError> {
    database(app)
        .await
        .map_err(|_| AttachmentError::DatabaseUnavailable)
}

#[tauri::command]
pub async fn import_attachment(
    app: AppHandle,
    window: WebviewWindow,
    note_id: String,
) -> Result<Option<Attachment>, AttachmentError> {
    let selected = filesystem_task(move || {
        let dialog = window.app_handle().dialog().file();
        #[cfg(desktop)]
        let dialog = dialog.set_parent(&window);
        Ok(dialog
            .set_title("Import attachment")
            .add_filter("Supported attachments", storage::FILE_EXTENSIONS)
            .blocking_pick_file())
    })
    .await?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| AttachmentError::InvalidFile)?;
    let directory = local_data_directory(&app)?;
    let pool = attachment_database(&app).await?;
    let staged = filesystem_task(move || storage::stage(&directory, &path)).await?;
    save_attachment(&pool, &note_id, staged).await.map(Some)
}

#[tauri::command]
pub async fn resolve_attachment(
    app: AppHandle,
    note_id: String,
    attachment_id: String,
) -> Result<Attachment, AttachmentError> {
    let (attachment, _) = load_attachment(
        &attachment_database(&app).await?,
        &local_data_directory(&app)?,
        &note_id,
        &attachment_id,
    )
    .await?;
    Ok(attachment)
}

#[tauri::command]
pub async fn open_attachment(
    app: AppHandle,
    note_id: String,
    attachment_id: String,
) -> Result<(), AttachmentError> {
    let (_, path) = load_attachment(
        &attachment_database(&app).await?,
        &local_data_directory(&app)?,
        &note_id,
        &attachment_id,
    )
    .await?;
    filesystem_task(move || {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|_| AttachmentError::OpenFailed)
    })
    .await
}

fn upload_header(request: &Request<'_>, name: &str) -> Result<String, AttachmentError> {
    let value = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or(AttachmentError::InvalidFile)?;
    percent_decode_str(value)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| AttachmentError::InvalidFile)
}

#[tauri::command]
pub async fn import_attachment_bytes(
    app: AppHandle,
    request: Request<'_>,
) -> Result<Attachment, AttachmentError> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() as u64 <= storage::MAX_BYTES => bytes.clone(),
        // The webview's postMessage fallback serializes binary payloads as arrays.
        InvokeBody::Json(serde_json::Value::Array(bytes))
            if bytes.len() as u64 <= storage::MAX_BYTES =>
        {
            bytes
                .iter()
                .map(|byte| {
                    byte.as_u64()
                        .and_then(|value| u8::try_from(value).ok())
                        .ok_or(AttachmentError::InvalidFile)
                })
                .collect::<Result<Vec<_>, _>>()?
        }
        InvokeBody::Raw(_) | InvokeBody::Json(serde_json::Value::Array(_)) => {
            return Err(AttachmentError::FileTooLarge);
        }
        _ => return Err(AttachmentError::InvalidFile),
    };
    let note_id = upload_header(&request, "x-kanso-note-id")?;
    let filename = upload_header(&request, "x-kanso-filename")?;
    let directory = local_data_directory(&app)?;
    let pool = attachment_database(&app).await?;
    let staged =
        filesystem_task(move || storage::stage_bytes(&directory, &filename, &bytes)).await?;
    save_attachment(&pool, &note_id, staged).await
}

#[tauri::command]
pub async fn read_attachment_image(
    app: AppHandle,
    note_id: String,
    attachment_id: String,
) -> Result<Response, AttachmentError> {
    let attachment =
        find_attachment(&attachment_database(&app).await?, &note_id, &attachment_id).await?;
    if !attachment.mime_type.starts_with("image/") {
        return Err(AttachmentError::UnsupportedType);
    }
    let directory = local_data_directory(&app)?;
    filesystem_task(move || {
        let (_, bytes) = storage::verified_file(&directory, &attachment)?;
        Ok(Response::new(bytes))
    })
    .await
}

#[cfg(test)]
pub(super) async fn test_support_import_bytes(
    pool: &SqlitePool,
    directory: &Path,
    note_id: &str,
    filename: &str,
    bytes: &[u8],
) -> Result<Attachment, AttachmentError> {
    let staged = storage::stage_bytes(directory, filename, bytes)?;
    save_attachment(pool, note_id, staged).await
}
