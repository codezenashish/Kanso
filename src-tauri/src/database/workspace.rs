use serde_json::Value;
use sqlx::{Row, SqlitePool};

const WORKSPACE_ID: &str = "local";

pub(super) async fn load(pool: &SqlitePool) -> Result<Option<Value>, sqlx::Error> {
    let snapshot: Option<String> = sqlx::query_scalar(include_str!("read_workspace.sql"))
        .bind(WORKSPACE_ID)
        .fetch_optional(pool)
        .await?;
    snapshot
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| sqlx::Error::Decode(Box::new(error)))
        })
        .transpose()
}

pub(super) async fn save(
    pool: &SqlitePool,
    revision: Option<i64>,
    snapshot: Value,
    legacy_digest: Option<String>,
) -> Result<Option<i64>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let next_revision = match revision {
        Some(revision) => sqlx::query(
            "UPDATE workspaces SET revision = revision + 1, updated_at = unixepoch('subsec') * 1000,
                expanded = ?3 WHERE id = ?1 AND revision = ?2 RETURNING revision",
        )
        .bind(WORKSPACE_ID)
        .bind(revision)
        .bind(snapshot["expanded"].to_string())
        .fetch_optional(&mut *transaction)
        .await?,
        None => sqlx::query(
            "INSERT INTO workspaces (id, name, created_at, updated_at, expanded, legacy_digest)
             VALUES (?1, 'Workspaces', unixepoch('subsec') * 1000, unixepoch('subsec') * 1000, ?2, ?3)
             ON CONFLICT(id) DO NOTHING RETURNING revision",
        )
        .bind(WORKSPACE_ID)
        .bind(snapshot["expanded"].to_string())
        .bind(legacy_digest)
        .fetch_optional(&mut *transaction)
        .await?,
    };
    let Some(row) = next_revision else {
        transaction.rollback().await?;
        return Ok(None);
    };

    let snapshot = snapshot.to_string();
    // Each statement runs on the same connection. A failed write rolls back the
    // revision, imported data, and editor session together.
    for statement in include_str!("write_workspace.sql")
        .split(";\n")
        .map(str::trim)
        .filter(|sql| !sql.is_empty())
    {
        let query = sqlx::query(statement).bind(WORKSPACE_ID);
        if statement.contains("?2") {
            query.bind(&snapshot).execute(&mut *transaction).await?;
        } else {
            query.execute(&mut *transaction).await?;
        }
    }
    transaction.commit().await?;
    Ok(Some(row.get("revision")))
}

#[cfg(test)]
mod tests;
