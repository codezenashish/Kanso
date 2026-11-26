use super::{DatabaseError, WORKSPACE_ID};
use serde_json::Value;
use sqlx::{Row, SqliteConnection, SqlitePool};

pub(super) async fn load(pool: &SqlitePool) -> Result<Option<Value>, DatabaseError> {
    load_with_query(pool, include_str!("read_workspace.sql")).await
}

#[cfg(test)]
pub(super) async fn load_before_tab_pins(pool: &SqlitePool) -> Result<Option<Value>, DatabaseError> {
    let query = include_str!("read_workspace.sql")
        .replace("SELECT note_id, active, pinned FROM", "SELECT note_id, active, 0 AS pinned FROM")
        .replace("AND managed = 1 ORDER BY name", "AND 0 ORDER BY name");
    load_with_query(pool, &query).await
}

async fn load_with_query(pool: &SqlitePool, query: &str) -> Result<Option<Value>, DatabaseError> {
    let snapshot: Option<String> = sqlx::query_scalar(query)
        .bind(WORKSPACE_ID)
        .fetch_optional(pool)
        .await?;
    snapshot
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| sqlx::Error::Decode(Box::new(error)))
        })
        .transpose()
        .map_err(DatabaseError::from)
}

#[cfg(test)]
pub(super) async fn save(
    pool: &SqlitePool,
    revision: Option<i64>,
    snapshot: Value,
    legacy_digest: Option<String>,
) -> Result<Option<i64>, DatabaseError> {
    save_with_history_at(
        pool,
        revision,
        snapshot,
        legacy_digest,
        None,
        super::history::current_epoch_ms(),
    )
    .await
}

pub(super) async fn save_with_history(
    pool: &SqlitePool,
    revision: Option<i64>,
    snapshot: Value,
    legacy_digest: Option<String>,
    history: Option<super::history::HistoryConfig>,
) -> Result<Option<i64>, DatabaseError> {
    save_with_history_at(
        pool,
        revision,
        snapshot,
        legacy_digest,
        history,
        super::history::current_epoch_ms(),
    )
    .await
}

pub(super) async fn save_with_history_at(
    pool: &SqlitePool,
    revision: Option<i64>,
    snapshot: Value,
    legacy_digest: Option<String>,
    history: Option<super::history::HistoryConfig>,
    now_ms: i64,
) -> Result<Option<i64>, DatabaseError> {
    let expanded = snapshot
        .get("expanded")
        .filter(|value| value.is_array())
        .ok_or(DatabaseError::InvalidSnapshot(
            "`expanded` must be a JSON array",
        ))?;
    if !snapshot.get("nodes").is_some_and(Value::is_array) {
        return Err(DatabaseError::InvalidSnapshot(
            "`nodes` must be a JSON array",
        ));
    }
    if let Some(config) = history.as_ref() {
        super::history::validate_config(config)
            .map_err(|_| DatabaseError::InvalidSnapshot("invalid version history config"))?;
    }

    let mut transaction = pool.begin().await?;
    let next_revision = match revision {
        Some(revision) => sqlx::query(
            "UPDATE workspaces SET revision = revision + 1, updated_at = unixepoch('subsec') * 1000,
                expanded = ?3 WHERE id = ?1 AND revision = ?2 RETURNING revision",
        )
        .bind(WORKSPACE_ID)
        .bind(revision)
        .bind(expanded.to_string())
        .fetch_optional(&mut *transaction)
        .await?,
        None => sqlx::query(
            "INSERT INTO workspaces (id, name, created_at, updated_at, expanded, legacy_digest)
             VALUES (?1, 'Workspaces', unixepoch('subsec') * 1000, unixepoch('subsec') * 1000, ?2, ?3)
             ON CONFLICT(id) DO NOTHING RETURNING revision",
        )
        .bind(WORKSPACE_ID)
        .bind(expanded.to_string())
        .bind(legacy_digest)
        .fetch_optional(&mut *transaction)
        .await?,
    };
    let Some(row) = next_revision else {
        transaction.rollback().await?;
        return Ok(None);
    };

    let snapshot_json = snapshot.to_string();
    write_nodes(&mut transaction, &snapshot_json).await?;
    // Each statement runs on the same connection. A failed write rolls back the
    // revision, imported data, editor session, and version snapshots together.
    for statement in include_str!("write_workspace.sql")
        .split(";\n")
        .map(str::trim)
        .filter(|sql| !sql.is_empty())
    {
        let query = sqlx::query(statement).bind(WORKSPACE_ID);
        if statement.contains("?2") {
            query
                .bind(&snapshot_json)
                .execute(&mut *transaction)
                .await?;
        } else {
            query.execute(&mut *transaction).await?;
        }
    }
    super::attachments::lifecycle::reconcile(&mut transaction).await?;
    super::history::record_snapshots_for_save(
        &mut transaction,
        &snapshot,
        now_ms,
        history.as_ref(),
    )
    .await?;
    transaction.commit().await?;
    Ok(Some(row.get("revision")))
}

pub(super) async fn write_nodes(
    connection: &mut SqliteConnection,
    snapshot: &str,
) -> Result<(), sqlx::Error> {
    for statement in include_str!("write_nodes.sql")
        .split(";\n")
        .filter(|statement| !statement.trim().is_empty())
    {
        sqlx::query(statement)
            .bind(WORKSPACE_ID)
            .bind(snapshot)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
