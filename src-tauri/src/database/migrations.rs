pub(super) static WORKSPACE_MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
