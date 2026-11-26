use super::super::{AttachmentError, references::rewrite_markdown};
use crate::database::{WORKSPACE_ID, history::compute_content_digest};
use serde::{Deserialize, Serialize};
use sqlx::SqliteConnection;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Deserialize, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackupVersion {
    note_id: String,
    created_at: i64,
    note_name: String,
    note_format: String,
    content: String,
    properties: Option<String>,
    reason: String,
    #[sqlx(json)]
    attachment_ids: Vec<String>,
}

pub(super) async fn export_versions(
    connection: &mut SqliteConnection,
) -> Result<Vec<BackupVersion>, AttachmentError> {
    Ok(sqlx::query_as(
        "SELECT v.note_id, v.created_at, v.note_name, v.note_format, v.content, v.properties, v.reason,
            (SELECT json_group_array(attachment_id) FROM note_version_attachments
             WHERE workspace_id = v.workspace_id AND version_id = v.id) AS attachment_ids
         FROM note_versions v WHERE v.workspace_id = ? ORDER BY v.created_at, v.rowid",
    ).bind(WORKSPACE_ID).fetch_all(connection).await?)
}

pub(super) async fn restore_versions(
    connection: &mut SqliteConnection,
    versions: Vec<BackupVersion>,
    note_ids: &BTreeMap<String, String>,
    attachment_ids: &BTreeMap<String, String>,
) -> Result<(), AttachmentError> {
    for version in versions {
        if version.created_at < 0
            || version.created_at > 8_640_000_000_000_000
            || !matches!(version.note_format.as_str(), "markdown" | "text" | "yaml")
            || !matches!(
                version.reason.as_str(),
                "autosave" | "manual" | "restore_checkpoint"
            )
        {
            return Err(AttachmentError::InvalidBackup);
        }
        let note_id = note_ids
            .get(&version.note_id)
            .ok_or(AttachmentError::InvalidBackup)?;
        let content = if version.note_format == "markdown" {
            rewrite_markdown(&version.content, |old, fragment| {
                let id = attachment_ids
                    .get(old)
                    .ok_or(AttachmentError::InvalidBackup)?;
                Ok((id != old).then(|| format!("attachment:{id}{fragment}")))
            })?
        } else {
            version.content
        };
        let references = version
            .attachment_ids
            .iter()
            .map(|id| attachment_ids.get(id).ok_or(AttachmentError::InvalidBackup))
            .collect::<Result<BTreeSet<_>, _>>()?;
        let digest = compute_content_digest(
            &version.note_format,
            &content,
            version.properties.as_deref(),
        );
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO note_versions (workspace_id, id, note_id, created_at, note_name, note_format,
                content, properties, content_digest, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(WORKSPACE_ID).bind(&id).bind(note_id).bind(version.created_at).bind(version.note_name)
            .bind(version.note_format).bind(content).bind(version.properties).bind(digest).bind(version.reason)
            .execute(&mut *connection).await?;
        let refs =
            serde_json::to_string(&references).map_err(|_| AttachmentError::InvalidBackup)?;
        sqlx::query(
            "INSERT INTO note_version_attachments (workspace_id, version_id, attachment_id)
             SELECT ?1, ?2, value FROM json_each(?3)",
        )
        .bind(WORKSPACE_ID)
        .bind(&id)
        .bind(&refs)
        .execute(&mut *connection)
        .await?;
        sqlx::query(
            "INSERT INTO retained_attachment_refs (workspace_id, retention_key, attachment_id)
             SELECT ?1, ?2, value FROM json_each(?3)",
        )
        .bind(WORKSPACE_ID)
        .bind(format!("version:{id}"))
        .bind(&refs)
        .execute(&mut *connection)
        .await?;
    }
    Ok(())
}
