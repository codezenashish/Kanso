mod versions;

use super::lifecycle::reconcile;
use super::references::rewrite_markdown;
use super::{
    Attachment, AttachmentError, attachment_database, filesystem_task, local_data_directory,
    storage,
};
use crate::database::{WORKSPACE_ID, workspace};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MANIFEST_NAME: &str = "workspace.json";
const MAX_MANIFEST_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    nodes: Vec<Value>,
    attachments: Vec<BackupAttachment>,
    #[serde(default)]
    history: Vec<versions::BackupVersion>,
}

#[derive(Clone, Deserialize, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct BackupAttachment {
    id: String,
    original_filename: String,
    mime_type: String,
    size_bytes: i64,
    digest: String,
}

impl From<&BackupAttachment> for Attachment {
    fn from(item: &BackupAttachment) -> Self {
        Self {
            id: item.id.clone(),
            original_filename: item.original_filename.clone(),
            mime_type: item.mime_type.clone(),
            size_bytes: item.size_bytes,
            digest: item.digest.clone(),
        }
    }
}

fn local_error(_: std::io::Error) -> AttachmentError {
    AttachmentError::StorageUnavailable
}

pub(in crate::database) async fn export(
    pool: &SqlitePool,
    directory: &Path,
    target: PathBuf,
) -> Result<PathBuf, AttachmentError> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    reconcile(&mut transaction).await?;
    let snapshot: String = sqlx::query_scalar(include_str!("../read_workspace.sql"))
        .bind(WORKSPACE_ID)
        .fetch_one(&mut *transaction)
        .await?;
    let snapshot: Value =
        serde_json::from_str(&snapshot).map_err(|_| AttachmentError::DatabaseUnavailable)?;
    let nodes = snapshot["nodes"]
        .as_array()
        .ok_or(AttachmentError::DatabaseUnavailable)?
        .to_vec();
    let attachments = sqlx::query_as::<_, BackupAttachment>(
        "SELECT a.id, a.original_filename, a.mime_type, a.size_bytes, a.digest FROM attachments AS a
         WHERE workspace_id = ? AND (
           EXISTS (SELECT 1 FROM note_attachments WHERE workspace_id = a.workspace_id AND attachment_id = a.id)
           OR EXISTS (SELECT 1 FROM retained_attachment_refs WHERE workspace_id = a.workspace_id AND attachment_id = a.id)
         ) ORDER BY a.id",
    ).bind(WORKSPACE_ID).fetch_all(&mut *transaction).await?;
    let history = versions::export_versions(&mut transaction).await?;
    let directory = directory.to_path_buf();
    let path = filesystem_task(move || {
        write_backup(
            &directory,
            &target,
            Manifest {
                version: 2,
                nodes,
                attachments,
                history,
            },
        )
    })
    .await?;
    transaction.commit().await?;
    Ok(path)
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), AttachmentError> {
    let mut file = File::create_new(path).map_err(local_error)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(local_error)
}

fn write_backup(
    directory: &Path,
    target: &Path,
    manifest: Manifest,
) -> Result<PathBuf, AttachmentError> {
    let target = target.canonicalize().map_err(local_error)?;
    let staged = tempfile::Builder::new()
        .prefix(".kanso-backup-")
        .tempdir_in(&target)
        .map_err(local_error)?;
    let assets = staged.path().join("attachments");
    let notes = staged.path().join("notes");
    fs::create_dir(&assets)
        .and_then(|_| fs::create_dir(&notes))
        .map_err(local_error)?;

    let mut paths = BTreeMap::new();
    let mut copied = BTreeSet::new();
    for item in &manifest.attachments {
        let name = storage::blob_name(&item.digest, &item.mime_type)?;
        if copied.insert(name.clone()) {
            let (_, bytes) = storage::verified_file(directory, &Attachment::from(item))?;
            write_synced(&assets.join(&name), &bytes)?;
        }
        paths.insert(item.id.clone(), name);
    }
    for (index, node) in manifest
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node["kind"] == "file")
    {
        let name = node["name"].as_str().unwrap_or("Note");
        let safe_name: String = name
            .chars()
            .take(48)
            .map(|ch| {
                if ch.is_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        let extension = match node["format"].as_str() {
            Some("yaml") => "yaml",
            Some("text") => "txt",
            _ => "md",
        };
        let stem = safe_name
            .strip_suffix(&format!(".{extension}"))
            .unwrap_or(&safe_name);
        let content = node["content"].as_str().unwrap_or_default();
        let content = if extension == "md" {
            portable_markdown(content, &paths)?
        } else {
            content.into()
        };
        write_synced(
            &notes.join(format!(
                "{:06}-{}.{extension}",
                index + 1,
                stem.trim_matches([' ', '.'])
            )),
            content.as_bytes(),
        )?;
    }
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|_| AttachmentError::InvalidBackup)?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(AttachmentError::BackupTooLarge);
    }
    write_synced(&staged.path().join(MANIFEST_NAME), &manifest_bytes)?;
    #[cfg(unix)]
    for path in [&assets, &notes, &staged.path().to_path_buf()] {
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(local_error)?;
    }

    let destination = target.join(format!("Kanso backup {}", Uuid::new_v4()));
    fs::rename(staged.path(), &destination).map_err(local_error)?;
    #[cfg(unix)]
    File::open(&target)
        .and_then(|file| file.sync_all())
        .map_err(local_error)?;
    Ok(destination)
}

fn portable_markdown(
    content: &str,
    paths: &BTreeMap<String, String>,
) -> Result<String, AttachmentError> {
    rewrite_markdown(content, |id, _| {
        let name = paths.get(id).ok_or(AttachmentError::ManagedFileMissing)?;
        Ok(Some(format!("../attachments/{name}")))
    })
}

fn read_manifest(path: &Path) -> Result<Manifest, AttachmentError> {
    if path.file_name().and_then(|name| name.to_str()) != Some(MANIFEST_NAME) {
        return Err(AttachmentError::InvalidBackup);
    }
    let file = storage::open_regular_file(path).map_err(|_| AttachmentError::InvalidBackup)?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(local_error)?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(AttachmentError::BackupTooLarge);
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| AttachmentError::InvalidBackup)?;
    if !matches!(manifest.version, 1 | 2) {
        return Err(AttachmentError::InvalidBackup);
    }
    Ok(manifest)
}

fn recovered_nodes(
    mut originals: Vec<Value>,
    root: &str,
    position: i64,
) -> Result<(Vec<Value>, BTreeMap<String, String>), AttachmentError> {
    let mut ids = BTreeMap::new();
    let mut folders = BTreeMap::new();
    for node in &originals {
        let id = node["id"].as_str().ok_or(AttachmentError::InvalidBackup)?;
        if id.is_empty()
            || node["name"].as_str().is_none()
            || !matches!(node["kind"].as_str(), Some("file" | "folder"))
            || ids
                .insert(id.to_owned(), Uuid::new_v4().to_string())
                .is_some()
        {
            return Err(AttachmentError::InvalidBackup);
        }
        if node["kind"] == "folder" {
            folders.insert(id.to_owned(), node["parent"].as_str().map(str::to_owned));
        }
    }

    let mut checked = BTreeSet::new();
    for id in folders.keys() {
        let mut branch = BTreeSet::new();
        let mut current = Some(id);
        while let Some(id) = current {
            if checked.contains(id) {
                break;
            }
            if !branch.insert(id.clone()) {
                return Err(AttachmentError::InvalidBackup);
            }
            current = folders
                .get(id)
                .ok_or(AttachmentError::InvalidBackup)?
                .as_ref();
        }
        checked.extend(branch);
    }

    for (index, node) in originals.iter_mut().enumerate() {
        let parent = match &node["parent"] {
            Value::Null => root,
            Value::String(id) if folders.contains_key(id) => &ids[id],
            _ => return Err(AttachmentError::InvalidBackup),
        };
        node["parent"] = json!(parent);
        node["id"] = json!(ids[node["id"].as_str().unwrap()]);
        node["position"] = json!(node["position"].as_i64().unwrap_or(index as i64));
        if node["kind"] == "file"
            && !matches!(node["format"].as_str(), Some("markdown" | "text" | "yaml"))
        {
            return Err(AttachmentError::InvalidBackup);
        }
    }
    originals.insert(
        0,
        json!({
            "id": root, "name": "Recovered workspace", "kind": "folder",
            "parent": null, "position": position,
        }),
    );
    Ok((originals, ids))
}

async fn restore_attachment(
    connection: &mut SqliteConnection,
    item: BackupAttachment,
    source: PathBuf,
    directory: PathBuf,
) -> Result<(String, String), AttachmentError> {
    let original_id = Uuid::parse_str(&item.id)
        .map_err(|_| AttachmentError::InvalidBackup)?
        .to_string();
    if original_id != item.id {
        return Err(AttachmentError::InvalidBackup);
    }
    let copy = item.clone();
    filesystem_task(move || {
        let (_, bytes) = storage::verified_file(&source, &Attachment::from(&copy))?;
        let staged = storage::stage_bytes(&directory, &copy.original_filename, &bytes)?;
        if staged.mime_type != copy.mime_type
            || staged.digest != copy.digest
            || staged.size_bytes != copy.size_bytes
        {
            return Err(AttachmentError::InvalidBackup);
        }
        staged.publish()
    })
    .await?;
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM attachments WHERE workspace_id = ? AND digest = ? AND original_filename = ?",
    ).bind(WORKSPACE_ID).bind(&item.digest).bind(&item.original_filename).fetch_optional(&mut *connection).await?;
    if let Some(id) = existing {
        return Ok((original_id, id));
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM attachments WHERE workspace_id = ? AND id = ?)",
    )
    .bind(WORKSPACE_ID)
    .bind(&original_id)
    .fetch_one(&mut *connection)
    .await?;
    let id = if taken {
        Uuid::new_v4().to_string()
    } else {
        original_id.clone()
    };
    sqlx::query("INSERT INTO attachments (workspace_id, id, digest, original_filename, mime_type, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)")
        .bind(WORKSPACE_ID).bind(&id).bind(item.digest).bind(item.original_filename).bind(item.mime_type).bind(item.size_bytes)
        .execute(connection).await?;
    Ok((original_id, id))
}

pub(in crate::database) async fn restore(
    pool: &SqlitePool,
    directory: &Path,
    path: PathBuf,
) -> Result<usize, AttachmentError> {
    let source = path
        .parent()
        .ok_or(AttachmentError::InvalidBackup)?
        .to_path_buf();
    let manifest = filesystem_task(move || read_manifest(&path)).await?;
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let position: i64 = sqlx::query_scalar(
        "SELECT coalesce(max(position) + 1, 0) FROM (
            SELECT position FROM folders WHERE workspace_id = ?1 AND parent_id IS NULL
            UNION ALL SELECT position FROM notes WHERE workspace_id = ?1 AND parent_id IS NULL
        )",
    )
    .bind(WORKSPACE_ID)
    .fetch_one(&mut *transaction)
    .await?;
    let root = Uuid::new_v4().to_string();
    let (mut nodes, note_ids) = recovered_nodes(manifest.nodes, &root, position)?;
    let mut ids = BTreeMap::new();
    for item in manifest.attachments {
        let (old, new) = restore_attachment(
            &mut transaction,
            item,
            source.clone(),
            directory.to_path_buf(),
        )
        .await?;
        if ids.insert(old, new).is_some() {
            return Err(AttachmentError::InvalidBackup);
        }
    }
    for node in &mut nodes {
        if let Some(content) = node["content"].as_str() {
            if node["format"] != "markdown" {
                continue;
            }
            let rewritten = rewrite_markdown(content, |old, fragment| {
                let id = ids.get(old).ok_or(AttachmentError::InvalidBackup)?;
                Ok((id != old).then(|| format!("attachment:{id}{fragment}")))
            })?;
            if rewritten != content {
                node["content"] = json!(rewritten);
            }
        }
    }
    let count = nodes.iter().filter(|node| node["kind"] == "file").count();
    let snapshot = json!({ "nodes": nodes }).to_string();
    workspace::write_nodes(&mut transaction, &snapshot).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO tags (workspace_id, name)
         SELECT ?1, tag.value FROM json_each(?2, '$.nodes') AS node, json_each(node.value, '$.tags') AS tag"
    ).bind(WORKSPACE_ID).bind(&snapshot).execute(&mut *transaction).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO note_tags (workspace_id, note_id, tag_name)
         SELECT ?1, node.value->>'id', tag.value
         FROM json_each(?2, '$.nodes') AS node, json_each(node.value, '$.tags') AS tag",
    )
    .bind(WORKSPACE_ID)
    .bind(&snapshot)
    .execute(&mut *transaction)
    .await?;
    reconcile(&mut transaction).await?;
    versions::restore_versions(&mut transaction, manifest.history, &note_ids, &ids).await?;
    sqlx::query(
        "UPDATE workspaces SET revision = revision + 1, wiki_index_ready = 0,
         updated_at = unixepoch('subsec') * 1000,
         expanded = json_insert(expanded, '$[#]', ?2) WHERE id = ?1",
    )
    .bind(WORKSPACE_ID)
    .bind(root)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(count)
}

#[tauri::command]
pub async fn export_attachment_backup(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, AttachmentError> {
    #[cfg(desktop)]
    {
        let target = filesystem_task(move || {
            Ok(window
                .app_handle()
                .dialog()
                .file()
                .set_parent(&window)
                .set_title("Choose a folder for the Kanso backup")
                .blocking_pick_folder())
        })
        .await?;
        let Some(target) = target else {
            return Ok(None);
        };
        let target = target
            .into_path()
            .map_err(|_| AttachmentError::InvalidBackup)?;
        let result = export(
            &attachment_database(&app).await?,
            &local_data_directory(&app)?,
            target,
        )
        .await?;
        Ok(Some(result.display().to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, window);
        Err(AttachmentError::StorageUnavailable)
    }
}

#[tauri::command]
pub async fn restore_attachment_backup(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<usize>, AttachmentError> {
    let path = filesystem_task(move || {
        let picker = window.app_handle().dialog().file();
        #[cfg(desktop)]
        let picker = picker.set_parent(&window);
        Ok(picker
            .set_title("Select the backup’s workspace.json")
            .add_filter("Kanso workspace manifest", &["json"])
            .blocking_pick_file())
    })
    .await?;
    let Some(path) = path else { return Ok(None) };
    let path = path
        .into_path()
        .map_err(|_| AttachmentError::InvalidBackup)?;
    restore(
        &attachment_database(&app).await?,
        &local_data_directory(&app)?,
        path,
    )
    .await
    .map(Some)
}

#[cfg(test)]
mod tests;
