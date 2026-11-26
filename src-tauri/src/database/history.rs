use super::{DatabaseError, WORKSPACE_ID, database};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::BTreeSet;
use tauri::AppHandle;
use uuid::Uuid;

pub const DEFAULT_SNAPSHOT_INTERVAL_MS: i64 = 300_000;
pub const DEFAULT_MAX_VERSIONS_PER_NOTE: i64 = 50;
const MS_PER_DAY: i64 = 86_400_000;
const DEFAULT_LIST_LIMIT: u32 = 100;
const MAX_LIST_LIMIT: u32 = 500;
const PREVIEW_CHAR_LIMIT: usize = 160;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryError {
    NoteNotFound,
    NoteTrashed,
    VersionNotFound,
    InvalidConfig,
    DatabaseUnavailable,
}

impl From<sqlx::Error> for HistoryError {
    fn from(_: sqlx::Error) -> Self {
        Self::DatabaseUnavailable
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryConfig {
    pub enabled: bool,
    pub snapshot_interval_ms: i64,
    pub max_versions_per_note: i64,
    pub max_age_days: Option<i64>,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            snapshot_interval_ms: DEFAULT_SNAPSHOT_INTERVAL_MS,
            max_versions_per_note: DEFAULT_MAX_VERSIONS_PER_NOTE,
            max_age_days: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersionSummary {
    pub id: String,
    pub note_id: String,
    pub created_at: i64,
    pub note_name: String,
    pub note_format: String,
    pub reason: String,
    pub content_bytes: usize,
    pub preview: String,
    pub has_properties: bool,
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteVersionDetail {
    pub id: String,
    pub note_id: String,
    pub created_at: i64,
    pub note_name: String,
    pub note_format: String,
    pub content: String,
    pub properties: Option<Value>,
    pub reason: String,
    pub content_digest: String,
    pub attachment_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPruneResult {
    pub deleted_versions: u64,
    pub released_attachment_refs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredNoteVersion {
    pub revision: i64,
    pub note_id: String,
    pub restored_version_id: String,
    pub checkpoint_version_id: Option<String>,
    pub note_name: String,
    pub note_format: String,
    pub content: String,
    pub properties: Option<Value>,
    pub tags: Vec<String>,
    pub attachment_ids: Vec<String>,
}

#[derive(Clone, Copy)]
enum SnapshotReason {
    Autosave,
    RestoreCheckpoint,
    Manual,
}

impl SnapshotReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Autosave => "autosave",
            Self::RestoreCheckpoint => "restore_checkpoint",
            Self::Manual => "manual",
        }
    }
}

#[derive(sqlx::FromRow)]
struct LatestVersion {
    created_at: i64,
    note_format: String,
    content: String,
    properties: Option<String>,
    content_digest: String,
}

pub(super) fn current_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub(super) fn validate_config(config: &HistoryConfig) -> Result<(), HistoryError> {
    if config.snapshot_interval_ms < 0 || config.max_versions_per_note < 1 {
        return Err(HistoryError::InvalidConfig);
    }
    if let Some(days) = config.max_age_days
        && (days < 1 || days.checked_mul(MS_PER_DAY).is_none())
    {
        return Err(HistoryError::InvalidConfig);
    }
    Ok(())
}

fn canonicalize_properties_value(value: Option<&Value>) -> Result<Option<String>, HistoryError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) if items.is_empty() => Ok(None),
        Some(other) => serde_json::to_string(other)
            .map(Some)
            .map_err(|_| HistoryError::DatabaseUnavailable),
    }
}

fn canonicalize_properties_str(raw: Option<&str>) -> Result<Option<String>, HistoryError> {
    match raw {
        None => Ok(None),
        Some(text) => {
            let parsed: Value =
                serde_json::from_str(text).map_err(|_| HistoryError::DatabaseUnavailable)?;
            canonicalize_properties_value(Some(&parsed))
        }
    }
}

fn parse_properties_value(raw: Option<&str>) -> Result<Option<Value>, HistoryError> {
    match raw {
        None => Ok(None),
        Some(text) => {
            let parsed: Value =
                serde_json::from_str(text).map_err(|_| HistoryError::DatabaseUnavailable)?;
            match parsed {
                Value::Null => Ok(None),
                Value::Array(ref items) if items.is_empty() => Ok(None),
                other => Ok(Some(other)),
            }
        }
    }
}

pub(super) fn compute_content_digest(
    format: &str,
    content: &str,
    properties: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update((format.len() as u64).to_le_bytes());
    hasher.update(format.as_bytes());
    hasher.update((content.len() as u64).to_le_bytes());
    hasher.update(content.as_bytes());
    match properties {
        Some(props) => {
            hasher.update([1u8]);
            hasher.update((props.len() as u64).to_le_bytes());
            hasher.update(props.as_bytes());
        }
        None => hasher.update([0u8]),
    }
    format!("{:x}", hasher.finalize())
}

fn extract_attachment_ids(content: &str) -> BTreeSet<String> {
    if content.contains("attachment") || content.contains('&') {
        super::attachments::references::ids_in(content).collect()
    } else {
        BTreeSet::new()
    }
}

fn extract_tags(properties: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(entries)) = properties else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    let mut tags = Vec::new();
    for entry in entries {
        let Some(name) = entry.get("name").and_then(Value::as_str) else {
            continue;
        };
        if !name.eq_ignore_ascii_case("tags") {
            continue;
        }
        let Some(value) = entry.get("value").and_then(Value::as_str) else {
            continue;
        };
        for raw in value.split(',') {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = trimmed.to_lowercase();
            if seen.insert(normalized) {
                tags.push(trimmed.to_owned());
            }
        }
    }
    tags
}

fn build_preview(content: &str) -> String {
    let mut preview = String::new();
    let mut count = 0usize;
    let mut in_whitespace = true;
    for ch in content.chars() {
        if ch.is_whitespace() {
            if !in_whitespace && count < PREVIEW_CHAR_LIMIT {
                preview.push(' ');
                count += 1;
                in_whitespace = true;
            }
            continue;
        }
        if count >= PREVIEW_CHAR_LIMIT {
            break;
        }
        preview.push(ch);
        count += 1;
        in_whitespace = false;
    }
    preview.trim_end().to_owned()
}

pub(super) async fn load_config_in_tx(
    connection: &mut SqliteConnection,
) -> Result<HistoryConfig, sqlx::Error> {
    let row = sqlx::query(
        "SELECT enabled, snapshot_interval_ms, max_versions_per_note, max_age_days
         FROM version_history_config WHERE workspace_id = ?1",
    )
    .bind(WORKSPACE_ID)
    .fetch_optional(&mut *connection)
    .await?;

    Ok(match row {
        Some(row) => HistoryConfig {
            enabled: row.get::<i64, _>("enabled") != 0,
            snapshot_interval_ms: row.get("snapshot_interval_ms"),
            max_versions_per_note: row.get("max_versions_per_note"),
            max_age_days: row.get("max_age_days"),
        },
        None => HistoryConfig::default(),
    })
}

async fn save_config_in_tx(
    connection: &mut SqliteConnection,
    config: &HistoryConfig,
) -> Result<(), HistoryError> {
    validate_config(config)?;
    sqlx::query(
        "INSERT INTO version_history_config (
            workspace_id, enabled, snapshot_interval_ms, max_versions_per_note, max_age_days
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id) DO UPDATE SET
            enabled = excluded.enabled,
            snapshot_interval_ms = excluded.snapshot_interval_ms,
            max_versions_per_note = excluded.max_versions_per_note,
            max_age_days = excluded.max_age_days",
    )
    .bind(WORKSPACE_ID)
    .bind(i64::from(config.enabled))
    .bind(config.snapshot_interval_ms)
    .bind(config.max_versions_per_note)
    .bind(config.max_age_days)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

async fn cleanup_orphaned_version_retention_refs(
    connection: &mut SqliteConnection,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM retained_attachment_refs
         WHERE workspace_id = ?1
           AND retention_key LIKE 'version:%'
           AND NOT EXISTS (
               SELECT 1 FROM note_versions
               WHERE workspace_id = retained_attachment_refs.workspace_id
                 AND 'version:' || id = retained_attachment_refs.retention_key
           )",
    )
    .bind(WORKSPACE_ID)
    .execute(&mut *connection)
    .await?;
    Ok(())
}

struct SnapshotRequest<'a> {
    note_id: &'a str,
    note_name: &'a str,
    note_format: &'a str,
    content: &'a str,
    canonical_properties: Option<&'a str>,
    reason: SnapshotReason,
    now_ms: i64,
    config: &'a HistoryConfig,
    ignore_interval: bool,
}

async fn maybe_create_snapshot(
    connection: &mut SqliteConnection,
    request: SnapshotRequest<'_>,
) -> Result<Option<String>, HistoryError> {
    let SnapshotRequest {
        note_id,
        note_name,
        note_format,
        content,
        canonical_properties,
        reason,
        now_ms,
        config,
        ignore_interval,
    } = request;
    let is_blank = content.trim().is_empty() && canonical_properties.is_none();
    let latest = sqlx::query_as::<_, LatestVersion>(
        "SELECT created_at, note_format, content, properties, content_digest
         FROM note_versions
         WHERE workspace_id = ?1 AND note_id = ?2
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .fetch_optional(&mut *connection)
    .await?;

    let digest = compute_content_digest(note_format, content, canonical_properties);
    match latest {
        None => {
            if is_blank {
                return Ok(None);
            }
        }
        Some(prev) => {
            if prev.content_digest == digest {
                return Ok(None);
            }
            let prev_properties = canonicalize_properties_str(prev.properties.as_deref())?;
            if !matches!(reason, SnapshotReason::RestoreCheckpoint)
                && prev.note_format == note_format
                && prev.content.trim() == content.trim()
                && prev_properties.as_deref() == canonical_properties
            {
                return Ok(None);
            }
            if !ignore_interval
                && now_ms.saturating_sub(prev.created_at) < config.snapshot_interval_ms
            {
                return Ok(None);
            }
        }
    }

    let version_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO note_versions (
            workspace_id, id, note_id, created_at, note_name, note_format,
            content, properties, content_digest, reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(WORKSPACE_ID)
    .bind(&version_id)
    .bind(note_id)
    .bind(now_ms)
    .bind(note_name)
    .bind(note_format)
    .bind(content)
    .bind(canonical_properties)
    .bind(&digest)
    .bind(reason.as_str())
    .execute(&mut *connection)
    .await?;

    let attachment_ids = extract_attachment_ids(content);
    if !attachment_ids.is_empty() {
        let ids_json = serde_json::to_string(&attachment_ids)
            .map_err(|_| HistoryError::DatabaseUnavailable)?;
        let retention_key = format!("version:{version_id}");
        sqlx::query(
            "INSERT OR IGNORE INTO note_version_attachments (workspace_id, version_id, attachment_id)
             SELECT ?1, ?2, attachments.id
             FROM json_each(?3) AS refs
             JOIN attachments
               ON attachments.workspace_id = ?1
              AND attachments.id = refs.value",
        )
        .bind(WORKSPACE_ID)
        .bind(&version_id)
        .bind(&ids_json)
        .execute(&mut *connection)
        .await?;

        sqlx::query(
            "INSERT OR IGNORE INTO retained_attachment_refs (workspace_id, retention_key, attachment_id)
             SELECT ?1, ?2, attachments.id
             FROM json_each(?3) AS refs
             JOIN attachments
               ON attachments.workspace_id = ?1
              AND attachments.id = refs.value",
        )
        .bind(WORKSPACE_ID)
        .bind(&retention_key)
        .bind(&ids_json)
        .execute(&mut *connection)
        .await?;
    }

    Ok(Some(version_id))
}

async fn enforce_retention_in_tx(
    connection: &mut SqliteConnection,
    note_id: Option<&str>,
    max_versions_per_note: i64,
    max_age_days: Option<i64>,
    now_ms: i64,
) -> Result<RetentionPruneResult, sqlx::Error> {
    let before_refs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM retained_attachment_refs
         WHERE workspace_id = ?1 AND retention_key LIKE 'version:%'",
    )
    .bind(WORKSPACE_ID)
    .fetch_one(&mut *connection)
    .await?;

    let mut deleted_versions = 0u64;
    if let Some(days) = max_age_days {
        let cutoff = now_ms.saturating_sub(days.saturating_mul(MS_PER_DAY));
        let age_res = sqlx::query(
            "DELETE FROM note_versions
             WHERE workspace_id = ?1
               AND (?2 IS NULL OR note_id = ?2)
               AND created_at < ?3",
        )
        .bind(WORKSPACE_ID)
        .bind(note_id)
        .bind(cutoff)
        .execute(&mut *connection)
        .await?;
        deleted_versions += age_res.rows_affected();
    }

    let count_res = sqlx::query(
        "DELETE FROM note_versions
         WHERE workspace_id = ?1
           AND (?2 IS NULL OR note_id = ?2)
           AND id IN (
               SELECT id FROM (
                   SELECT id,
                          ROW_NUMBER() OVER (
                              PARTITION BY note_id
                              ORDER BY created_at DESC, rowid DESC
                          ) AS rn
                   FROM note_versions
                   WHERE workspace_id = ?1
                     AND (?2 IS NULL OR note_id = ?2)
               )
               WHERE rn > ?3
           )",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(max_versions_per_note)
    .execute(&mut *connection)
    .await?;
    deleted_versions += count_res.rows_affected();

    let after_refs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM retained_attachment_refs
         WHERE workspace_id = ?1 AND retention_key LIKE 'version:%'",
    )
    .bind(WORKSPACE_ID)
    .fetch_one(&mut *connection)
    .await?;

    Ok(RetentionPruneResult {
        deleted_versions,
        released_attachment_refs: before_refs.saturating_sub(after_refs) as u64,
    })
}

pub(super) async fn record_snapshots_for_save(
    connection: &mut SqliteConnection,
    snapshot: &Value,
    now_ms: i64,
    override_config: Option<&HistoryConfig>,
) -> Result<usize, DatabaseError> {
    cleanup_orphaned_version_retention_refs(connection).await?;

    let config = match override_config {
        Some(cfg) => {
            validate_config(cfg)
                .map_err(|_| DatabaseError::InvalidSnapshot("invalid history config"))?;
            cfg.clone()
        }
        None => load_config_in_tx(connection).await?,
    };

    if !config.enabled {
        return Ok(0);
    }

    let Some(nodes) = snapshot.get("nodes").and_then(Value::as_array) else {
        return Ok(0);
    };

    let mut created = 0usize;
    for node in nodes {
        if node.get("kind").and_then(Value::as_str) != Some("file") {
            continue;
        }
        // Archived and trashed notes preserve their existing history, but do not
        // accumulate new autosave snapshots while outside the active workspace.
        if node.get("status").and_then(Value::as_str).is_some() {
            continue;
        }
        let Some(note_id) = node.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(note_name) = node.get("name").and_then(Value::as_str) else {
            continue;
        };
        let note_format = node
            .get("format")
            .and_then(Value::as_str)
            .filter(|fmt| matches!(*fmt, "markdown" | "text" | "yaml"))
            .unwrap_or("markdown");
        let content = node.get("content").and_then(Value::as_str).unwrap_or("");
        let properties = canonicalize_properties_value(node.get("properties"))
            .map_err(|_| DatabaseError::InvalidSnapshot("invalid note properties"))?;

        let inserted = maybe_create_snapshot(
            connection,
            SnapshotRequest {
                note_id,
                note_name,
                note_format,
                content,
                canonical_properties: properties.as_deref(),
                reason: SnapshotReason::Autosave,
                now_ms,
                config: &config,
                ignore_interval: false,
            },
        )
        .await
        .map_err(|_| DatabaseError::InvalidSnapshot("failed to record note snapshot"))?;

        if inserted.is_some() {
            created += 1;
            enforce_retention_in_tx(
                connection,
                Some(note_id),
                config.max_versions_per_note,
                config.max_age_days,
                now_ms,
            )
            .await?;
        }
    }

    Ok(created)
}

async fn ensure_note_exists(pool: &SqlitePool, note_id: &str) -> Result<(), HistoryError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM notes WHERE workspace_id = ?1 AND id = ?2)",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .fetch_one(pool)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(HistoryError::NoteNotFound)
    }
}

pub(super) async fn list_versions(
    pool: &SqlitePool,
    note_id: &str,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<NoteVersionSummary>, HistoryError> {
    ensure_note_exists(pool, note_id).await?;
    let limit = i64::from(limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT));
    let offset = i64::from(offset.unwrap_or(0));

    let rows = sqlx::query(
        "SELECT v.id, v.note_id, v.created_at, v.note_name, v.note_format, v.reason,
                v.content, v.properties IS NOT NULL AS has_properties,
                (
                    SELECT COALESCE(json_group_array(attachment_id), '[]')
                    FROM (
                        SELECT attachment_id
                        FROM note_version_attachments
                        WHERE workspace_id = v.workspace_id AND version_id = v.id
                        ORDER BY attachment_id
                    )
                ) AS attachment_ids_json
         FROM note_versions AS v
         WHERE v.workspace_id = ?1 AND v.note_id = ?2
         ORDER BY v.created_at DESC, v.rowid DESC
         LIMIT ?3 OFFSET ?4",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let content: String = row.get("content");
            let attachment_json: String = row.get("attachment_ids_json");
            let attachment_ids: Vec<String> = serde_json::from_str(&attachment_json)
                .map_err(|_| HistoryError::DatabaseUnavailable)?;
            Ok(NoteVersionSummary {
                id: row.get("id"),
                note_id: row.get("note_id"),
                created_at: row.get("created_at"),
                note_name: row.get("note_name"),
                note_format: row.get("note_format"),
                reason: row.get("reason"),
                content_bytes: content.len(),
                preview: build_preview(&content),
                has_properties: row.get::<i64, _>("has_properties") != 0,
                attachment_ids,
            })
        })
        .collect()
}

pub(super) async fn get_version(
    pool: &SqlitePool,
    note_id: &str,
    version_id: &str,
) -> Result<NoteVersionDetail, HistoryError> {
    let row = sqlx::query(
        "SELECT v.id, v.note_id, v.created_at, v.note_name, v.note_format,
                v.content, v.properties, v.reason, v.content_digest,
                (
                    SELECT COALESCE(json_group_array(attachment_id), '[]')
                    FROM (
                        SELECT attachment_id
                        FROM note_version_attachments
                        WHERE workspace_id = v.workspace_id AND version_id = v.id
                        ORDER BY attachment_id
                    )
                ) AS attachment_ids_json
         FROM note_versions AS v
         WHERE v.workspace_id = ?1 AND v.note_id = ?2 AND v.id = ?3",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(version_id)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        ensure_note_exists(pool, note_id).await?;
        return Err(HistoryError::VersionNotFound);
    };

    let properties_raw: Option<String> = row.get("properties");
    let properties = parse_properties_value(properties_raw.as_deref())?;
    let attachment_json: String = row.get("attachment_ids_json");
    let attachment_ids: Vec<String> =
        serde_json::from_str(&attachment_json).map_err(|_| HistoryError::DatabaseUnavailable)?;

    Ok(NoteVersionDetail {
        id: row.get("id"),
        note_id: row.get("note_id"),
        created_at: row.get("created_at"),
        note_name: row.get("note_name"),
        note_format: row.get("note_format"),
        content: row.get("content"),
        properties,
        reason: row.get("reason"),
        content_digest: row.get("content_digest"),
        attachment_ids,
    })
}

pub(super) async fn create_manual_snapshot_at(
    pool: &SqlitePool,
    note_id: &str,
    now_ms: i64,
) -> Result<Option<NoteVersionDetail>, HistoryError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let note = sqlx::query(
        "SELECT name, format, COALESCE(content, '') AS content, properties, deleted_at
         FROM notes WHERE workspace_id = ?1 AND id = ?2",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(note) = note else {
        return Err(HistoryError::NoteNotFound);
    };
    if note.get::<Option<i64>, _>("deleted_at").is_some() {
        return Err(HistoryError::NoteTrashed);
    }

    let config = load_config_in_tx(&mut tx).await?;
    let note_name: String = note.get("name");
    let note_format: String = note.get("format");
    let content: String = note.get("content");
    let properties_raw: Option<String> = note.get("properties");
    let canonical_properties = canonicalize_properties_str(properties_raw.as_deref())?;

    let version_id = maybe_create_snapshot(
        &mut tx,
        SnapshotRequest {
            note_id,
            note_name: &note_name,
            note_format: &note_format,
            content: &content,
            canonical_properties: canonical_properties.as_deref(),
            reason: SnapshotReason::Manual,
            now_ms,
            config: &config,
            ignore_interval: true,
        },
    )
    .await?;

    if version_id.is_some() {
        enforce_retention_in_tx(
            &mut tx,
            Some(note_id),
            config.max_versions_per_note,
            config.max_age_days,
            now_ms,
        )
        .await?;
    }
    tx.commit().await?;

    match version_id {
        Some(id) => get_version(pool, note_id, &id).await.map(Some),
        None => Ok(None),
    }
}

pub(super) async fn prune_versions_at(
    pool: &SqlitePool,
    note_id: Option<&str>,
    max_versions_per_note: Option<i64>,
    max_age_days: Option<i64>,
    now_ms: i64,
) -> Result<RetentionPruneResult, HistoryError> {
    if let Some(id) = note_id {
        ensure_note_exists(pool, id).await?;
    }

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let stored = load_config_in_tx(&mut tx).await?;
    let effective = HistoryConfig {
        enabled: stored.enabled,
        snapshot_interval_ms: stored.snapshot_interval_ms,
        max_versions_per_note: max_versions_per_note.unwrap_or(stored.max_versions_per_note),
        max_age_days: max_age_days.or(stored.max_age_days),
    };
    validate_config(&effective)?;

    let result = enforce_retention_in_tx(
        &mut tx,
        note_id,
        effective.max_versions_per_note,
        effective.max_age_days,
        now_ms,
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}

pub(super) async fn get_config(pool: &SqlitePool) -> Result<HistoryConfig, HistoryError> {
    let mut conn = pool.acquire().await?;
    Ok(load_config_in_tx(&mut conn).await?)
}

pub(super) async fn update_config_at(
    pool: &SqlitePool,
    config: HistoryConfig,
    apply_retention: bool,
    now_ms: i64,
) -> Result<HistoryConfig, HistoryError> {
    validate_config(&config)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    save_config_in_tx(&mut tx, &config).await?;
    if apply_retention {
        enforce_retention_in_tx(
            &mut tx,
            None,
            config.max_versions_per_note,
            config.max_age_days,
            now_ms,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(config)
}

pub(super) async fn restore_version_at(
    pool: &SqlitePool,
    note_id: &str,
    version_id: &str,
    expected_revision: i64,
    preserve_current: bool,
    now_ms: i64,
) -> Result<Option<RestoredNoteVersion>, HistoryError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let next_revision: Option<i64> = sqlx::query_scalar(
        "UPDATE workspaces
         SET revision = revision + 1, wiki_index_ready = 0, updated_at = ?3
         WHERE id = ?1 AND revision = ?2
         RETURNING revision",
    )
    .bind(WORKSPACE_ID)
    .bind(expected_revision)
    .bind(now_ms)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(revision) = next_revision else {
        tx.rollback().await?;
        return Ok(None);
    };

    let current_note = sqlx::query(
        "SELECT name, format, COALESCE(content, '') AS content, properties, deleted_at
         FROM notes WHERE workspace_id = ?1 AND id = ?2",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(current_note) = current_note else {
        return Err(HistoryError::NoteNotFound);
    };
    if current_note.get::<Option<i64>, _>("deleted_at").is_some() {
        return Err(HistoryError::NoteTrashed);
    }

    let target_version = sqlx::query(
        "SELECT note_name, note_format, content, properties
         FROM note_versions
         WHERE workspace_id = ?1 AND note_id = ?2 AND id = ?3",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(version_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(target_version) = target_version else {
        return Err(HistoryError::VersionNotFound);
    };

    let config = load_config_in_tx(&mut tx).await?;
    let checkpoint_version_id = if preserve_current {
        let cur_name: String = current_note.get("name");
        let cur_format: String = current_note.get("format");
        let cur_content: String = current_note.get("content");
        let cur_props_raw: Option<String> = current_note.get("properties");
        let cur_props = canonicalize_properties_str(cur_props_raw.as_deref())?;
        maybe_create_snapshot(
            &mut tx,
            SnapshotRequest {
                note_id,
                note_name: &cur_name,
                note_format: &cur_format,
                content: &cur_content,
                canonical_properties: cur_props.as_deref(),
                reason: SnapshotReason::RestoreCheckpoint,
                now_ms,
                config: &config,
                ignore_interval: true,
            },
        )
        .await?
    } else {
        None
    };

    let restored_name: String = target_version.get("note_name");
    let restored_format: String = target_version.get("note_format");
    let restored_content: String = target_version.get("content");
    let restored_props_raw: Option<String> = target_version.get("properties");
    let canonical_restored_props = canonicalize_properties_str(restored_props_raw.as_deref())?;
    let restored_props_value = parse_properties_value(canonical_restored_props.as_deref())?;

    sqlx::query(
        "UPDATE notes
         SET format = ?3,
             content = ?4,
             properties = ?5,
             updated_at = ?6
         WHERE workspace_id = ?1 AND id = ?2",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .bind(&restored_format)
    .bind(&restored_content)
    .bind(&canonical_restored_props)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;

    let tags = extract_tags(restored_props_value.as_ref());
    sqlx::query("DELETE FROM note_tags WHERE workspace_id = ?1 AND note_id = ?2")
        .bind(WORKSPACE_ID)
        .bind(note_id)
        .execute(&mut *tx)
        .await?;

    if !tags.is_empty() {
        let tags_json =
            serde_json::to_string(&tags).map_err(|_| HistoryError::DatabaseUnavailable)?;
        sqlx::query(
            "INSERT OR IGNORE INTO tags (workspace_id, name)
             SELECT ?1, value FROM json_each(?2)",
        )
        .bind(WORKSPACE_ID)
        .bind(&tags_json)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT OR IGNORE INTO note_tags (workspace_id, note_id, tag_name)
             SELECT ?1, ?2, value FROM json_each(?3)",
        )
        .bind(WORKSPACE_ID)
        .bind(note_id)
        .bind(&tags_json)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "DELETE FROM tags
         WHERE workspace_id = ?1 AND managed = 0
           AND NOT EXISTS (
               SELECT 1 FROM note_tags WHERE workspace_id = ?1 AND tag_name = tags.name
           )",
    )
    .bind(WORKSPACE_ID)
    .execute(&mut *tx)
    .await?;

    super::attachments::lifecycle::reconcile(&mut tx).await?;

    if checkpoint_version_id.is_some() {
        enforce_retention_in_tx(
            &mut tx,
            Some(note_id),
            config.max_versions_per_note,
            config.max_age_days,
            now_ms,
        )
        .await?;
    }

    let attachment_ids: Vec<String> = sqlx::query_scalar(
        "SELECT attachment_id FROM note_attachments
         WHERE workspace_id = ?1 AND note_id = ?2
         ORDER BY attachment_id",
    )
    .bind(WORKSPACE_ID)
    .bind(note_id)
    .fetch_all(&mut *tx)
    .await?;

    tx.commit().await?;

    let current_note_name: String = current_note.get("name");
    let _ = restored_name;

    Ok(Some(RestoredNoteVersion {
        revision,
        note_id: note_id.to_owned(),
        restored_version_id: version_id.to_owned(),
        checkpoint_version_id,
        note_name: current_note_name,
        note_format: restored_format,
        content: restored_content,
        properties: restored_props_value,
        tags,
        attachment_ids,
    }))
}

async fn history_database(app: &AppHandle) -> Result<SqlitePool, HistoryError> {
    database(app)
        .await
        .map_err(|_| HistoryError::DatabaseUnavailable)
}

#[tauri::command]
pub async fn list_note_versions(
    app: AppHandle,
    note_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<NoteVersionSummary>, HistoryError> {
    list_versions(&history_database(&app).await?, &note_id, limit, offset).await
}

#[tauri::command]
pub async fn get_note_version(
    app: AppHandle,
    note_id: String,
    version_id: String,
) -> Result<NoteVersionDetail, HistoryError> {
    get_version(&history_database(&app).await?, &note_id, &version_id).await
}

#[tauri::command]
pub async fn create_note_version(
    app: AppHandle,
    note_id: String,
) -> Result<Option<NoteVersionDetail>, HistoryError> {
    create_manual_snapshot_at(&history_database(&app).await?, &note_id, current_epoch_ms()).await
}

#[tauri::command]
pub async fn prune_note_versions(
    app: AppHandle,
    note_id: Option<String>,
    max_versions_per_note: Option<i64>,
    max_age_days: Option<i64>,
) -> Result<RetentionPruneResult, HistoryError> {
    prune_versions_at(
        &history_database(&app).await?,
        note_id.as_deref(),
        max_versions_per_note,
        max_age_days,
        current_epoch_ms(),
    )
    .await
}

#[tauri::command]
pub async fn get_version_history_config(app: AppHandle) -> Result<HistoryConfig, HistoryError> {
    get_config(&history_database(&app).await?).await
}

#[tauri::command]
pub async fn update_version_history_config(
    app: AppHandle,
    config: HistoryConfig,
    apply_retention: Option<bool>,
) -> Result<HistoryConfig, HistoryError> {
    update_config_at(
        &history_database(&app).await?,
        config,
        apply_retention.unwrap_or(false),
        current_epoch_ms(),
    )
    .await
}

#[tauri::command]
pub async fn restore_note_version(
    app: AppHandle,
    note_id: String,
    version_id: String,
    expected_revision: i64,
    preserve_current: Option<bool>,
) -> Result<Option<RestoredNoteVersion>, HistoryError> {
    restore_version_at(
        &history_database(&app).await?,
        &note_id,
        &version_id,
        expected_revision,
        preserve_current.unwrap_or(true),
        current_epoch_ms(),
    )
    .await
}

#[cfg(test)]
mod tests;
