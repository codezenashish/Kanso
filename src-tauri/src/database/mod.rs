pub(super) mod attachments;
pub(super) mod history;
#[cfg(test)]
mod integration_tests;
mod migrations;
mod workspace;

use serde::Serialize;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

const WORKSPACE_ID: &str = "local";
const DATABASE: &str = "sqlite:kanso.db";

#[derive(Debug)]
pub enum DatabaseError {
    AppDataDirectory(tauri::Error),
    DirectoryCreate(std::io::Error),
    Sqlite(sqlx::Error),
    Migration(sqlx::migrate::MigrateError),
    InvalidSnapshot(&'static str),
}

impl fmt::Display for DatabaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AppDataDirectory(error) => {
                write!(f, "Failed to resolve local app data directory: {error}")
            }
            Self::DirectoryCreate(error) => {
                write!(f, "Failed to create workspace data directory: {error}")
            }
            Self::Sqlite(error) => write!(f, "Workspace database error: {error}"),
            Self::Migration(error) => write!(f, "Workspace migration error: {error}"),
            Self::InvalidSnapshot(reason) => write!(f, "Invalid workspace snapshot: {reason}"),
        }
    }
}

impl std::error::Error for DatabaseError {}

impl From<sqlx::Error> for DatabaseError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<sqlx::migrate::MigrateError> for DatabaseError {
    fn from(error: sqlx::migrate::MigrateError) -> Self {
        Self::Migration(error)
    }
}

impl Serialize for DatabaseError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

fn app_data_directory(app: &AppHandle) -> Result<PathBuf, DatabaseError> {
    app.path()
        .app_local_data_dir()
        .map_err(DatabaseError::AppDataDirectory)
}

async fn database(app: &AppHandle) -> Result<SqlitePool, DatabaseError> {
    let instances = app.state::<DbInstances>();
    // Hold the write lock until migrations finish so concurrent commands share one pool.
    let mut pools = instances.0.write().await;
    if let Some(DbPool::Sqlite(pool)) = pools.get(DATABASE) {
        return Ok(pool.clone());
    }

    // The plugin's relative SQLite URLs resolve under the app config directory.
    // Register the pool explicitly to use the local data directory and per-connection settings.
    let directory = app_data_directory(app)?;
    std::fs::create_dir_all(&directory).map_err(DatabaseError::DirectoryCreate)?;
    let options = SqliteConnectOptions::new()
        .filename(directory.join("kanso.db"))
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new().connect_with(options).await?;
    migrations::WORKSPACE_MIGRATIONS.run(&pool).await?;
    pools.insert(DATABASE.to_owned(), DbPool::Sqlite(pool.clone()));
    Ok(pool)
}

#[tauri::command]
pub async fn load_workspace(app: AppHandle) -> Result<Option<serde_json::Value>, DatabaseError> {
    workspace::load(&database(&app).await?).await
}

#[tauri::command]
pub async fn save_workspace(
    app: AppHandle,
    revision: Option<i64>,
    snapshot: serde_json::Value,
    legacy_digest: Option<String>,
    history: Option<history::HistoryConfig>,
) -> Result<Option<i64>, DatabaseError> {
    workspace::save_with_history(
        &database(&app).await?,
        revision,
        snapshot,
        legacy_digest,
        history,
    )
    .await
}
