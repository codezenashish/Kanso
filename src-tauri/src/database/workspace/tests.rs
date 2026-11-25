use super::{load, save};
use crate::database::migrations::WORKSPACE_MIGRATIONS;
use serde_json::json;
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};

#[test]
fn persists_workspace_crud_and_session_across_restarts() {
    tauri::async_runtime::block_on(async {
        let directory =
            std::env::temp_dir().join(format!("kanso-sqlite-test-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let options = SqliteConnectOptions::new()
            .filename(directory.join("kanso.db"))
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePool::connect_with(options.clone()).await.unwrap();
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();
        assert!(load(&pool).await.unwrap().is_none());

        let mut snapshot = json!({
            "expanded": ["outer", "inner"],
            "nodes": [
                {"id":"outer", "name":"Outer", "parent":null, "kind":"folder", "position":0},
                {"id":"inner", "name":"Inner", "parent":"outer", "kind":"folder", "position":0},
                {"id":"note", "name":"Memo.txt", "parent":"inner", "kind":"file", "position":0,
                 "format":"text", "content":"It's a memo.", "starred":true, "template":true,
                 "properties":[{"name":"Tags","value":"local, work"}], "tags":["local","work"]},
                {"id":"yaml", "name":"Config.yaml", "parent":"outer", "kind":"file", "position":1,
                 "format":"yaml", "content":"offline: true\n"},
                {"id":"md", "name":"Notes.md", "parent":null, "kind":"file", "position":1,
                 "format":"markdown", "content":"# Offline\n[[Memo|Memo label]]"}
            ],
            "tabs": [{"id":"yaml","active":0}, {"id":"note","active":1}],
            "wikiChanges": [{
                "id": "md",
                "links": [{
                    "sourceId": "md", "start": 10, "end": 29, "targetId": "note",
                    "target": "Memo", "alias": "Memo label", "context": "[[Memo|Memo label]]"
                }]
            }]
        });

        // A failed first import must leave no receipt or partial workspace.
        let mut invalid = snapshot.clone();
        invalid["nodes"][2]["parent"] = json!("missing");
        assert!(
            save(&pool, None, invalid, Some("receipt".into()))
                .await
                .is_err()
        );
        assert!(load(&pool).await.unwrap().is_none());
        assert_eq!(
            save(&pool, None, snapshot.clone(), Some("receipt".into()))
                .await
                .unwrap(),
            Some(0)
        );
        pool.close().await;

        let pool = SqlitePool::connect_with(options).await.unwrap();
        WORKSPACE_MIGRATIONS.run(&pool).await.unwrap();
        let stored = load(&pool).await.unwrap().unwrap();
        assert_eq!(stored["legacyDigest"], "receipt");
        assert_eq!(stored["wikiLinks"][0]["targetId"], "note");
        assert_eq!(stored["wikiLinks"][0]["alias"], "Memo label");
        assert_eq!(stored["expanded"], snapshot["expanded"]);
        assert_eq!(stored["tabs"], snapshot["tabs"]);
        let nodes = stored["nodes"].as_array().unwrap();
        let note = nodes.iter().find(|node| node["id"] == "note").unwrap();
        assert_eq!(note["content"], "It's a memo.");
        assert_eq!(note["parent"], "inner");
        assert_eq!(note["starred"], 1);
        assert_eq!(note["template"], 1);
        let tags: Vec<String> =
            sqlx::query_scalar("SELECT tag_name FROM note_tags ORDER BY tag_name")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(tags, ["local", "work"]);

        snapshot["nodes"][2]["name"] = json!("Renamed.md");
        snapshot["nodes"][2]["format"] = json!("markdown");
        snapshot["nodes"][2]["parent"] = json!(null);
        snapshot["nodes"][2]["position"] = json!(2);
        snapshot["nodes"][2]["content"] = json!("# Autosaved");
        snapshot["nodes"][2]["status"] = json!("archived");
        snapshot["tabs"] = json!([{"id":"yaml","active":1}]);
        snapshot["nodes"][4]["content"] = json!("# Offline\n[[Renamed|Memo label]]");
        snapshot["wikiChanges"][0]["links"][0]["target"] = json!("Renamed");
        snapshot["wikiChanges"][0]["links"][0]["context"] = json!("[[Renamed|Memo label]]");
        snapshot["wikiChanges"][0]["links"][0]["end"] = json!(32);
        assert_eq!(
            save(&pool, Some(0), snapshot.clone(), None).await.unwrap(),
            Some(1)
        );
        let row: (String, Option<String>, String, String, i64) = sqlx::query_as(
            "SELECT name, parent_id, format, content, archived_at FROM notes WHERE id = ?",
        )
        .bind("note")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            (&*row.0, row.1, &*row.2, &*row.3),
            ("Renamed.md", None, "markdown", "# Autosaved")
        );
        assert!(row.4 > 0);
        assert_eq!(
            save(&pool, Some(0), snapshot.clone(), None).await.unwrap(),
            None
        );

        let linked = load(&pool).await.unwrap().unwrap();
        assert_eq!(linked["wikiLinks"][0]["target"], "Renamed");
        assert_eq!(linked["wikiLinks"][0]["targetId"], "note");

        snapshot["wikiChanges"] = json!([]);
        for (revision, status) in [
            (1, json!("trashed")),
            (2, json!(null)),
            (3, json!("trashed")),
        ] {
            snapshot["nodes"][2]["status"] = status.clone();
            assert_eq!(
                save(&pool, Some(revision), snapshot.clone(), None)
                    .await
                    .unwrap(),
                Some(revision + 1)
            );
            let stored = load(&pool).await.unwrap().unwrap();
            let note = stored["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["id"] == "note")
                .unwrap();
            assert_eq!(note["status"], status);
            assert_eq!(stored["wikiLinks"][0]["targetId"], "note");
        }

        snapshot["nodes"].as_array_mut().unwrap().remove(2);
        assert_eq!(save(&pool, Some(4), snapshot, None).await.unwrap(), Some(5));
        let counts: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM notes), (SELECT count(*) FROM note_tags), (SELECT count(*) FROM tags)",
        )
        .fetch_one(&pool).await.unwrap();
        assert_eq!(counts, (2, 0, 0));
        let deleted = load(&pool).await.unwrap().unwrap();
        assert_eq!(deleted["wikiLinks"][0]["targetId"], json!(null));
        assert_eq!(deleted["wikiLinks"][0]["target"], "Renamed");
        pool.close().await;
        std::fs::remove_dir_all(directory).unwrap();
    });
}
