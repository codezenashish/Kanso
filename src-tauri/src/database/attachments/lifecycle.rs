use super::references::ids_in;
use super::{
    Attachment, AttachmentError, attachment_database, filesystem_task, local_data_directory,
    storage,
};
use crate::database::WORKSPACE_ID;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use tauri::AppHandle;

pub(in crate::database) async fn reconcile(
    connection: &mut SqliteConnection,
) -> Result<(), sqlx::Error> {
    let notes: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content FROM notes WHERE workspace_id = ? AND (content LIKE '%attachment%' OR content LIKE '%&%')",
    ).bind(WORKSPACE_ID).fetch_all(&mut *connection).await?;
    let references = notes
        .iter()
        .flat_map(|(id, content)| {
            ids_in(content)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(move |attachment| (id, attachment))
        })
        .collect::<Vec<_>>();
    let references =
        serde_json::to_string(&references).map_err(|error| sqlx::Error::Encode(Box::new(error)))?;
    sqlx::query(
        "INSERT OR IGNORE INTO note_attachments (workspace_id, note_id, attachment_id)
         SELECT ?1, refs.value->>0, attachments.id
         FROM json_each(?2) AS refs JOIN attachments
              ON attachments.workspace_id = ?1 AND attachments.id = refs.value->>1",
    )
    .bind(WORKSPACE_ID)
    .bind(&references)
    .execute(&mut *connection)
    .await?;
    // Open tabs keep provisional imports and undoable references until the tab closes.
    sqlx::query(
        "DELETE FROM note_attachments AS link
         WHERE workspace_id = ?1
           AND NOT EXISTS (SELECT 1 FROM editor_sessions WHERE workspace_id = ?1 AND note_id = link.note_id)
           AND (link.note_id, link.attachment_id) NOT IN (
               SELECT refs.value->>0, refs.value->>1 FROM json_each(?2) AS refs
           )",
    ).bind(WORKSPACE_ID).bind(references).execute(&mut *connection).await?;
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(in crate::database) struct ManagedAttachment {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub(in crate::database) attachment: Attachment,
    pub(in crate::database) note_count: i64,
    pub(in crate::database) retained_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStorage {
    location: String,
    max_file_bytes: u64,
    file_count: usize,
    total_bytes: u64,
    pub(in crate::database) unused_file_count: usize,
    pub(in crate::database) unused_record_count: usize,
    unused_bytes: u64,
    pub(in crate::database) cleanup_token: String,
    pub(in crate::database) attachments: Vec<ManagedAttachment>,
}

struct CleanupPlan {
    ids: Vec<String>,
    files: BTreeSet<String>,
    registered: BTreeSet<String>,
    summary: AttachmentStorage,
}

async fn plan(
    connection: &mut SqliteConnection,
    directory: &Path,
) -> Result<CleanupPlan, AttachmentError> {
    let attachments = sqlx::query_as::<_, ManagedAttachment>(
        "SELECT a.id, a.original_filename, a.mime_type, a.size_bytes, a.digest,
            (SELECT count(*) FROM note_attachments WHERE workspace_id = a.workspace_id AND attachment_id = a.id) AS note_count,
            (SELECT count(*) FROM retained_attachment_refs WHERE workspace_id = a.workspace_id AND attachment_id = a.id) AS retained_count
         FROM attachments AS a WHERE workspace_id = ? ORDER BY original_filename COLLATE NOCASE, id",
    ).bind(WORKSPACE_ID).fetch_all(connection).await?;
    let mut protected = BTreeSet::new();
    let mut registered = BTreeSet::new();
    let mut ids = Vec::new();
    for item in &attachments {
        let name = storage::blob_name(&item.attachment.digest, &item.attachment.mime_type)?;
        registered.insert(name.clone());
        if item.note_count == 0 && item.retained_count == 0 {
            ids.push(item.attachment.id.clone());
        } else {
            protected.insert(name);
        }
    }
    let base = directory.to_path_buf();
    let sizes = filesystem_task(move || scan_blobs(&base)).await?;
    let files: BTreeSet<_> = sizes
        .keys()
        .filter(|name| !protected.contains(*name))
        .cloned()
        .collect();
    let mut hasher = Sha256::new();
    for id in &ids {
        hasher.update(id.as_bytes());
    }
    for name in &files {
        hasher.update(name.as_bytes());
        hasher.update(sizes[name].to_le_bytes());
    }
    let summary = AttachmentStorage {
        location: directory.join("attachments").display().to_string(),
        max_file_bytes: storage::MAX_BYTES,
        file_count: sizes.len(),
        total_bytes: sizes.values().sum(),
        unused_file_count: files.len(),
        unused_record_count: ids.len(),
        unused_bytes: files.iter().map(|name| sizes[name]).sum(),
        cleanup_token: format!("{:x}", hasher.finalize()),
        attachments,
    };
    Ok(CleanupPlan {
        ids,
        files,
        registered,
        summary,
    })
}

fn scan_blobs(directory: &Path) -> Result<BTreeMap<String, u64>, AttachmentError> {
    let root = match storage::managed_root(directory, false) {
        Ok(root) => root,
        Err(AttachmentError::ManagedFileMissing) => return Ok(BTreeMap::new()),
        Err(error) => return Err(error),
    };
    let mut sizes = BTreeMap::new();
    for entry in fs::read_dir(root).map_err(|_| AttachmentError::StorageUnavailable)? {
        let entry = entry.map_err(|_| AttachmentError::StorageUnavailable)?;
        let name = entry.file_name();
        let Some(name) = name.to_str().filter(|name| storage::is_blob_name(name)) else {
            continue;
        };
        let metadata = entry
            .metadata()
            .map_err(|_| AttachmentError::StorageUnavailable)?;
        if metadata.is_file() {
            sizes.insert(name.to_owned(), metadata.len());
        }
    }
    Ok(sizes)
}

pub(in crate::database) async fn inspect(
    pool: &SqlitePool,
    directory: &Path,
) -> Result<AttachmentStorage, AttachmentError> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    reconcile(&mut transaction).await?;
    let summary = plan(&mut transaction, directory).await?.summary;
    transaction.commit().await?;
    Ok(summary)
}

pub(in crate::database) async fn cleanup(
    pool: &SqlitePool,
    directory: &Path,
    token: String,
) -> Result<AttachmentStorage, AttachmentError> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    reconcile(&mut transaction).await?;
    let reviewed = plan(&mut transaction, directory).await?;
    if reviewed.summary.cleanup_token != token {
        return Err(AttachmentError::CleanupChanged);
    }
    let ids =
        serde_json::to_string(&reviewed.ids).map_err(|_| AttachmentError::DatabaseUnavailable)?;
    sqlx::query("DELETE FROM attachments WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?2))")
        .bind(WORKSPACE_ID).bind(ids).execute(&mut *transaction).await?;
    transaction.commit().await?;

    // Commit metadata first. An interruption can leave copies that a later cleanup can reclaim.
    // A concurrent import between these transactions can reclaim a copy, so check again under the writer lock.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    reconcile(&mut transaction).await?;
    let remaining = plan(&mut transaction, directory).await?;
    let files: Vec<_> = reviewed
        .files
        .intersection(&remaining.files)
        .filter(|name| !remaining.registered.contains(*name))
        .cloned()
        .collect();
    if !files.is_empty() {
        let directory = directory.to_owned();
        filesystem_task(move || {
            let root = storage::managed_root(&directory, false)?;
            for name in files {
                fs::remove_file(root.join(name))
                    .map_err(|_| AttachmentError::StorageUnavailable)?;
            }
            Ok(())
        })
        .await?;
    }
    let summary = plan(&mut transaction, directory).await?.summary;
    transaction.commit().await?;
    Ok(summary)
}

#[tauri::command]
pub async fn attachment_storage(app: AppHandle) -> Result<AttachmentStorage, AttachmentError> {
    inspect(
        &attachment_database(&app).await?,
        &local_data_directory(&app)?,
    )
    .await
}

#[tauri::command]
pub async fn cleanup_attachments(
    app: AppHandle,
    token: String,
) -> Result<AttachmentStorage, AttachmentError> {
    cleanup(
        &attachment_database(&app).await?,
        &local_data_directory(&app)?,
        token,
    )
    .await
}

#[cfg(test)]
mod tests;
