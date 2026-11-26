use super::{Attachment, AttachmentError, load_attachment, save_attachment, storage};
use crate::database::{migrations::WORKSPACE_MIGRATIONS, workspace};
use serde_json::json;
use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use std::{fs, path::Path, process::Command, time::Duration};
use tempfile::{TempDir, tempdir};

async fn connect(directory: &Path) -> SqlitePool {
    SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(directory.join("kanso.db"))
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5)),
    )
    .await
    .unwrap()
}

pub(super) async fn existing_workspace() -> (TempDir, SqlitePool) {
    let directory = tempdir().unwrap();
    let pool = connect(directory.path()).await;
    // Create a real pre-attachment database and write a workspace before upgrading it.
    let previous_migrations = Migrator {
        migrations: std::borrow::Cow::Borrowed(&WORKSPACE_MIGRATIONS.migrations[..2]),
        ..Migrator::DEFAULT
    };
    previous_migrations.run(&pool).await.unwrap();
    sqlx::query("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('local', 'Workspaces', 1, 1)")
        .execute(&pool).await.unwrap();
    workspace::write_nodes(&mut pool.acquire().await.unwrap(), &json!({
        "nodes": [
            {"id":"first", "name":"First.md", "parent":null, "kind":"file", "position":0, "format":"markdown", "content":"# Offline note"},
            {"id":"second", "name":"Second.md", "parent":null, "kind":"file", "position":1, "format":"markdown"},
            {"id":"trashed", "name":"Trashed.md", "parent":null, "kind":"file", "position":2, "format":"markdown", "status":"trashed"}
        ]
    }).to_string()).await.unwrap();
    sqlx::query("INSERT INTO editor_sessions (workspace_id, note_id, position, active) VALUES ('local', 'first', 0, 1)")
        .execute(&pool).await.unwrap();
    let before = workspace::load_before_tab_pins(&pool).await.unwrap();
    pool.close().await;

    let pool = connect(directory.path()).await;
    WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();
    assert_eq!(workspace::load(&pool).await.unwrap(), before);
    (directory, pool)
}

pub(super) async fn import(
    pool: &SqlitePool,
    directory: &Path,
    note_id: &str,
    source: &Path,
) -> Result<Attachment, AttachmentError> {
    save_attachment(pool, note_id, storage::stage(directory, source)?).await
}

const REOPEN_TEST_DIRECTORY: &str = "KANSO_ATTACHMENT_REOPEN_TEST_DIRECTORY";
const REOPEN_TEST_ID: &str = "KANSO_ATTACHMENT_REOPEN_TEST_ID";
const ORIGINAL_TEXT: &str = "An attachment with original text.";

#[test]
fn migrates_and_reopens_attachments_from_managed_storage() {
    tauri::async_runtime::block_on(async {
        if let Some(directory) = std::env::var_os(REOPEN_TEST_DIRECTORY) {
            let directory = Path::new(&directory);
            let id = std::env::var(REOPEN_TEST_ID).unwrap();
            let pool = connect(directory).await;
            WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();
            for note in ["first", "second"] {
                let (resolved, path) = load_attachment(&pool, directory, note, &id).await.unwrap();
                assert_eq!(resolved.id, id);
                assert_eq!(fs::read_to_string(path).unwrap(), ORIGINAL_TEXT);
            }
            return;
        }

        let (directory, pool) = existing_workspace().await;
        let directory = directory.path();
        let source = directory.join("Handwritten note.txt");
        fs::write(&source, ORIGINAL_TEXT).unwrap();
        let original = import(&pool, directory, "first", &source).await.unwrap();
        let second = import(&pool, directory, "second", &source).await.unwrap();
        assert_eq!(original.id, second.id);
        assert_eq!(original.original_filename, "Handwritten note.txt");
        assert_eq!(original.mime_type, "text/plain");
        assert_eq!(original.size_bytes, ORIGINAL_TEXT.len() as i64);

        let other_name = directory.join("Same contents.txt");
        fs::rename(&source, &other_name).unwrap();
        let renamed = import(&pool, directory, "first", &other_name)
            .await
            .unwrap();
        assert_ne!(original.id, renamed.id);
        assert_eq!(original.digest, renamed.digest);
        fs::remove_file(other_name).unwrap();

        fs::write(&source, "A different attachment with the same name.").unwrap();
        let unrelated = import(&pool, directory, "first", &source).await.unwrap();
        assert_ne!(original.id, unrelated.id);
        assert_ne!(original.digest, unrelated.digest);
        fs::remove_file(source).unwrap();
        assert_eq!(
            fs::read_dir(directory.join("attachments")).unwrap().count(),
            2
        );
        pool.close().await;

        // Start the same backend in a new process with only the stored ID and database path.
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "database::attachments::tests::migrates_and_reopens_attachments_from_managed_storage"])
            .env(REOPEN_TEST_DIRECTORY, directory)
            .env(REOPEN_TEST_ID, &original.id)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}"
        );

        let pool = connect(directory).await;
        assert_eq!(
            load_attachment(&pool, directory, "trashed", &original.id)
                .await
                .unwrap_err(),
            AttachmentError::AttachmentNotFound
        );
        assert_eq!(
            load_attachment(&pool, directory, "first", "../../kanso.db")
                .await
                .unwrap_err(),
            AttachmentError::AttachmentNotFound
        );
    });
}

#[test]
fn rejects_unsafe_inputs_and_missing_or_modified_managed_files() {
    tauri::async_runtime::block_on(async {
        let (directory, pool) = existing_workspace().await;
        let directory = directory.path();
        for (name, bytes, expected) in [
            (
                "launcher.exe",
                b"data".as_slice(),
                AttachmentError::UnsupportedType,
            ),
            (
                "renamed.png",
                b"MZ\x90\x00".as_slice(),
                AttachmentError::UnsupportedType,
            ),
            (
                "launcher.txt",
                b"#!/bin/sh\n".as_slice(),
                AttachmentError::UnsupportedType,
            ),
            (
                "desktop-entry.txt",
                b"[Desktop Entry]\nType=Application\n".as_slice(),
                AttachmentError::UnsupportedType,
            ),
            ("empty.txt", b"".as_slice(), AttachmentError::InvalidFile),
        ] {
            let path = directory.join(name);
            fs::write(&path, bytes).unwrap();
            assert_eq!(
                import(&pool, directory, "first", &path).await.unwrap_err(),
                expected
            );
        }
        let oversized = directory.join("large.txt");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(26 * 1024 * 1024)
            .unwrap();
        assert_eq!(
            import(&pool, directory, "first", &oversized)
                .await
                .unwrap_err(),
            AttachmentError::FileTooLarge
        );
        let subdirectory = directory.join("dir.txt");
        fs::create_dir(&subdirectory).unwrap();
        assert_eq!(
            import(&pool, directory, "first", &subdirectory)
                .await
                .unwrap_err(),
            AttachmentError::InvalidFile
        );

        let png = b"\
            \x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\
            \x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\
            \x02\x00\x00\x00\x0b\x49\x44\x41\x54\x78\xda\x63\xfc\xff\x1f\x00\
            \x03\x03\x02\x00\xef\x97\xd5\x99\x00\x00\x00\x00\x49\x45\x4e\x44\
            \xae\x42\x60\x82";
        let image = directory.join("Pixel.PNG");
        fs::write(&image, png).unwrap();
        let staged = storage::stage_bytes(directory, "Pixel.PNG", png).unwrap();
        let from_bytes = save_attachment(&pool, "first", staged).await.unwrap();
        let attachment = import(&pool, directory, "first", &image).await.unwrap();
        assert_eq!(attachment.id, from_bytes.id);
        assert!(matches!(
            storage::stage_bytes(directory, "../Pixel.PNG", png),
            Err(AttachmentError::InvalidFile)
        ));
        assert!(matches!(
            storage::stage_bytes(directory, "Not.png", b"MZ"),
            Err(AttachmentError::UnsupportedType)
        ));
        assert!(matches!(
            storage::stage_bytes(
                directory,
                "Too large.png",
                &vec![0; storage::MAX_BYTES as usize + 1]
            ),
            Err(AttachmentError::FileTooLarge)
        ));
        let (_, preview) = storage::verified_file(directory, &attachment).unwrap();
        assert_eq!(preview, png);
        assert_eq!(attachment.mime_type, "image/png");
        assert_eq!(attachment.original_filename, "Pixel.PNG");
        let (_, path) = load_attachment(&pool, directory, "first", &attachment.id)
            .await
            .unwrap();
        assert_eq!(fs::read(path).unwrap(), png);

        let source = directory.join("test.txt");
        fs::write(&source, "original").unwrap();
        let traversing = subdirectory.join("../test.txt");
        assert_eq!(
            import(&pool, directory, "first", &traversing)
                .await
                .unwrap_err(),
            AttachmentError::InvalidFile
        );
        #[cfg(unix)]
        {
            let link = directory.join("linked.txt");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert_eq!(
                import(&pool, directory, "first", &link).await.unwrap_err(),
                AttachmentError::InvalidFile
            );
        }
        assert_eq!(
            import(&pool, directory, "trashed", &source)
                .await
                .unwrap_err(),
            AttachmentError::NoteNotAvailable
        );

        let attachment = import(&pool, directory, "first", &source).await.unwrap();
        let (_, path) = load_attachment(&pool, directory, "first", &attachment.id)
            .await
            .unwrap();
        fs::write(&path, "modified").unwrap();
        assert_eq!(
            load_attachment(&pool, directory, "first", &attachment.id)
                .await
                .unwrap_err(),
            AttachmentError::ManagedFileInvalid
        );
        assert_eq!(
            import(&pool, directory, "first", &source)
                .await
                .unwrap_err(),
            AttachmentError::ManagedFileInvalid
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            load_attachment(&pool, directory, "first", &attachment.id)
                .await
                .unwrap_err(),
            AttachmentError::ManagedFileMissing
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, &path).unwrap();
            assert_eq!(
                load_attachment(&pool, directory, "first", &attachment.id)
                    .await
                    .unwrap_err(),
                AttachmentError::ManagedFileInvalid
            );
            fs::remove_file(path).unwrap();
        }
        assert_eq!(
            import(&pool, directory, "first", &source).await.unwrap().id,
            attachment.id
        );
    });
}

#[test]
fn failed_publication_and_commit_leave_no_broken_references() {
    tauri::async_runtime::block_on(async {
        let (directory, pool) = existing_workspace().await;
        let directory = directory.path();
        let source = directory.join("example.txt");
        fs::write(&source, "retryable data").unwrap();
        let staged = storage::stage(directory, &source).unwrap();
        let managed = directory
            .join("attachments")
            .join(format!("{}.txt", staged.digest));
        fs::create_dir(&managed).unwrap();
        assert!(save_attachment(&pool, "first", staged).await.is_err());
        fs::remove_dir(&managed).unwrap();
        assert_eq!(
            fs::read_dir(directory.join("attachments")).unwrap().count(),
            0
        );

        // A deferred constraint causes a failure at commit, after the blob is published.
        sqlx::raw_sql(
            "CREATE TABLE attachment_commit_failure (
                note_id TEXT REFERENCES notes_invalid(id) DEFERRABLE INITIALLY DEFERRED
             );
             CREATE TABLE notes_invalid (id TEXT PRIMARY KEY);
             CREATE TRIGGER fail_attachment_commit AFTER INSERT ON note_attachments
             BEGIN INSERT INTO attachment_commit_failure (note_id) VALUES ('missing'); END;",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            import(&pool, directory, "first", &source)
                .await
                .unwrap_err(),
            AttachmentError::DatabaseUnavailable
        );
        assert!(managed.is_file());
        for table in ["attachments", "note_attachments"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0);
        }
        sqlx::query("DROP TRIGGER fail_attachment_commit")
            .execute(&pool)
            .await
            .unwrap();
        let left = storage::stage(directory, &source).unwrap();
        let right = storage::stage(directory, &source).unwrap();
        let other_pool = pool.clone();
        let first = tauri::async_runtime::spawn(async move {
            save_attachment(&other_pool, "first", left).await
        });
        let second = save_attachment(&pool, "second", right).await.unwrap();
        assert_eq!(first.await.unwrap().unwrap().id, second.id);
        assert_eq!(
            fs::read_dir(directory.join("attachments")).unwrap().count(),
            1
        );
    });
}
