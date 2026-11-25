mod migrations;
mod workspace;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

const DATABASE: &str = "sqlite:kanso.db";

async fn database(app: &AppHandle) -> Result<SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    // Hold the write lock until migrations finish so concurrent commands share one pool.
    let mut pools = instances.0.write().await;
    if let Some(DbPool::Sqlite(pool)) = pools.get(DATABASE) {
        return Ok(pool.clone());
    }

    // The plugin's relative SQLite URLs resolve under the app config directory.
    // Register the pool explicitly to use the local data directory and per-connection settings.
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let options = SqliteConnectOptions::new()
        .filename(directory.join("kanso.db"))
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .map_err(|error| error.to_string())?;
    migrations::WORKSPACE_MIGRATIONS
        .run(&pool)
        .await
        .map_err(|error| error.to_string())?;
    pools.insert(DATABASE.to_owned(), DbPool::Sqlite(pool.clone()));
    Ok(pool)
}

#[tauri::command]
pub async fn load_workspace(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    workspace::load(&database(&app).await?)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_workspace(
    app: AppHandle,
    revision: Option<i64>,
    snapshot: serde_json::Value,
    legacy_digest: Option<String>,
) -> Result<Option<i64>, String> {
    workspace::save(&database(&app).await?, revision, snapshot, legacy_digest)
        .await
        .map_err(|error| error.to_string())
}
