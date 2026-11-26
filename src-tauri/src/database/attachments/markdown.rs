use super::{
    Attachment, attachment_database, find_attachment, local_data_directory, references, storage,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tauri::{AppHandle, WebviewWindow, async_runtime::spawn_blocking};
use tauri_plugin_dialog::DialogExt;

const MAX_NOTE: usize = 4 * 1024 * 1024;
const MAX_ASSET: usize = 25 * 1024 * 1024;
const MAX_BATCH: usize = 48 * 1024 * 1024;
const MAX_EXPORT: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 2500;
const ASSETS: &str = "_kanso-assets";
const SIDECAR: &str = ".kanso-properties.json";
static ASSET_LINK: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"_kanso-assets/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|gif|webp|pdf|txt))\b").unwrap()
});

#[derive(Serialize)]
struct ImportedAsset {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportEntry {
    source: usize,
    path: Vec<String>,
    content: Option<String>,
    properties_json: Option<String>,
    assets: Vec<ImportedAsset>,
}

#[derive(Default, Serialize)]
pub struct ImportBatch {
    entries: Vec<ImportEntry>,
    issues: Vec<String>,
    #[serde(skip)]
    visited: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEntry {
    id: Option<String>,
    path: Vec<String>,
    content: Option<String>,
    properties_json: Option<String>,
}

#[derive(Serialize)]
pub struct ExportReport {
    directory: String,
    written: usize,
    issues: Vec<String>,
}

fn valid_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 220
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|ch| ch.is_control() || "/\\<>:\"|?*".contains(ch))
        && !matches!(
            name.split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}

fn markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|part| part.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}

fn read_limited(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    storage::open_regular_file(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(std::io::Error::other(
            "file or import batch exceeds the size limit",
        ));
    }
    Ok(bytes)
}

fn read_import(paths: Vec<PathBuf>) -> ImportBatch {
    let mut batch = ImportBatch::default();
    let mut remaining = MAX_BATCH;
    for (source, path) in paths.into_iter().enumerate() {
        match path.canonicalize() {
            Ok(boundary) => read_entry(&path, &boundary, source, &[], &mut remaining, &mut batch),
            Err(_) => batch
                .issues
                .push(format!("Could not access {}", path.display())),
        }
    }
    batch
}

fn read_entry(
    path: &Path,
    boundary: &Path,
    source: usize,
    prefix: &[String],
    remaining: &mut usize,
    batch: &mut ImportBatch,
) {
    if batch.visited >= MAX_ENTRIES || prefix.len() >= 48 {
        if !batch
            .issues
            .iter()
            .any(|issue| issue == "The import entry or depth limit was reached.")
        {
            batch
                .issues
                .push("The import entry or depth limit was reached.".into());
        }
        return;
    }
    batch.visited += 1;
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        batch
            .issues
            .push(format!("Unsupported filename: {}", path.display()));
        return;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        batch
            .issues
            .push(format!("Could not access {}", path.display()));
        return;
    };
    if metadata.file_type().is_symlink()
        || !path
            .canonicalize()
            .is_ok_and(|resolved| resolved.starts_with(boundary))
    {
        batch
            .issues
            .push(format!("Skipped symbolic link {}", path.display()));
        return;
    }
    let mut relative = prefix.to_vec();
    relative.push(name.into());
    if metadata.is_dir() {
        if name.eq_ignore_ascii_case(ASSETS) {
            return;
        }
        let Ok(children) = fs::read_dir(path) else {
            batch
                .issues
                .push(format!("Could not read folder {}", path.display()));
            return;
        };
        batch.entries.push(ImportEntry {
            source,
            path: relative.clone(),
            content: None,
            properties_json: None,
            assets: vec![],
        });
        let mut paths = Vec::new();
        for child in children.take(MAX_ENTRIES + 1) {
            match child {
                Ok(child) => paths.push(child.path()),
                Err(_) => batch
                    .issues
                    .push(format!("Could not read an entry in {}", path.display())),
            }
        }
        paths.sort();
        for child in paths {
            read_entry(&child, boundary, source, &relative, remaining, batch);
        }
        return;
    }
    if !metadata.is_file() || !markdown_file(path) {
        return;
    }
    let content = read_limited(path, MAX_NOTE.min(*remaining))
        .map_err(|err| err.to_string())
        .and_then(|bytes| String::from_utf8(bytes).map_err(|_| "expected UTF-8 Markdown".into()));
    let content = match content {
        Ok(content) => content,
        Err(error) => {
            batch.issues.push(format!("{name}: {error}"));
            return;
        }
    };
    *remaining -= content.len();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let sidecar = parent.join(format!("{name}{SIDECAR}"));
    let properties_json = if fs::symlink_metadata(&sidecar).is_ok() {
        match read_limited(&sidecar, MAX_NOTE.min(*remaining)).and_then(|bytes| {
            String::from_utf8(bytes).map_err(|_| std::io::Error::other("invalid UTF-8"))
        }) {
            Ok(properties) => {
                *remaining -= properties.len();
                Some(properties)
            }
            Err(_) => {
                batch
                    .issues
                    .push(format!("{name}: could not read the property sidecar"));
                None
            }
        }
    } else {
        None
    };
    let asset_directory = parent.join(ASSETS);
    let canonical_assets = parent.canonicalize().ok().map(|path| path.join(ASSETS));
    let mut assets = Vec::new();
    if fs::symlink_metadata(&asset_directory).is_ok_and(|metadata| metadata.is_dir())
        && canonical_assets.is_some()
        && asset_directory.canonicalize().ok() == canonical_assets
    {
        let names: BTreeSet<_> = ASSET_LINK
            .captures_iter(&content)
            .map(|capture| capture[1].to_owned())
            .collect();
        for asset in names {
            if let Ok(bytes) =
                read_limited(&asset_directory.join(&asset), MAX_ASSET.min(*remaining))
            {
                *remaining -= bytes.len();
                assets.push(ImportedAsset { name: asset, bytes });
            }
        }
    }
    batch.entries.push(ImportEntry {
        source,
        path: relative,
        content: Some(content),
        properties_json,
        assets,
    });
}

#[tauri::command]
pub async fn pick_markdown_import(
    window: WebviewWindow,
    folders: bool,
) -> Result<Option<ImportBatch>, String> {
    #[cfg(desktop)]
    {
        spawn_blocking(move || {
            let picker = window.dialog().file().set_parent(&window);
            let paths = if folders {
                picker
                    .set_title("Choose Markdown folders")
                    .blocking_pick_folders()
            } else {
                picker
                    .set_title("Choose Markdown files")
                    .add_filter("Markdown", &["md", "markdown"])
                    .blocking_pick_files()
            };
            Ok(paths.map(|paths| {
                read_import(
                    paths
                        .into_iter()
                        .filter_map(|path| path.into_path().ok())
                        .collect(),
                )
            }))
        })
        .await
        .map_err(|_| "Could not read the selected Markdown files.".to_owned())?
    }
    #[cfg(not(desktop))]
    {
        let _ = (window, folders);
        Err("Markdown import requires a desktop file picker.".into())
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("missing export parent"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(path).map_err(|error| error.error)?;
    Ok(())
}

fn attachment_fragment(fragment: &str) -> String {
    const ESCAPE: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'(')
        .add(b')')
        .add(b'<')
        .add(b'>');
    let Some(hash) = fragment.strip_prefix('#') else {
        return String::new();
    };
    format!("#{}", percent_encoding::utf8_percent_encode(hash, ESCAPE))
}

fn write_export(
    target: &Path,
    entries: Vec<ExportEntry>,
    storage_directory: &Path,
    managed: BTreeMap<(String, String), (String, Attachment)>,
) -> Result<ExportReport, String> {
    let target = target.canonicalize().map_err(|err| err.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix("Kanso Markdown ")
        .tempdir_in(target)
        .map_err(|err| err.to_string())?;
    let root = staging.path();
    let mut issues = Vec::new();
    let mut written = 0;
    let mut copied = BTreeSet::new();
    for entry in entries {
        let label = entry.path.join("/");
        // The only reserved path is generated by this writer, never supplied by a caller.
        if entry.path.is_empty()
            || entry.path.len() > 48
            || entry
                .path
                .iter()
                .any(|part| !valid_component(part) || part.eq_ignore_ascii_case(ASSETS))
        {
            issues.push(format!("{label}: skipped an unsafe export path"));
            continue;
        }
        let destination = entry
            .path
            .iter()
            .fold(root.to_path_buf(), |path, part| path.join(part));
        let Some(content) = entry.content else {
            if let Err(error) = fs::create_dir_all(&destination) {
                issues.push(format!("{label}: {error}"));
            }
            continue;
        };
        let parent = destination.parent().unwrap_or(root);
        if let Err(error) = fs::create_dir_all(parent) {
            issues.push(format!("{label}: {error}"));
            continue;
        }
        let id = entry.id.unwrap_or_default();
        let mut urls = BTreeMap::new();
        let reference_ids = if markdown_file(&destination) {
            references::ids_in(&content).collect::<BTreeSet<_>>()
        } else {
            BTreeSet::new()
        };
        for reference in reference_ids {
            if let Some((name, attachment)) = managed.get(&(id.clone(), reference.clone())) {
                let assets = parent.join(ASSETS);
                let file = assets.join(name);
                if !copied.contains(&file) {
                    let result = storage::verified_file(storage_directory, attachment)
                        .map_err(|_| {
                            std::io::Error::other("managed attachment could not be verified")
                        })
                        .and_then(|(_, bytes)| {
                            fs::create_dir_all(&assets)?;
                            write_new(&file, &bytes)
                        });
                    if let Err(error) = result {
                        issues.push(format!(
                            "{label}: asset {reference} was not copied ({error})"
                        ));
                        continue;
                    }
                    copied.insert(file);
                }
                urls.insert(reference, format!("{ASSETS}/{name}"));
            } else {
                issues.push(format!("{label}: unresolved attachment {reference}"));
            }
        }
        let rewritten = if urls.is_empty() {
            content
        } else {
            references::rewrite_markdown(&content, |id, fragment| {
                Ok(urls
                    .get(id)
                    .map(|url| format!("{url}{}", attachment_fragment(fragment))))
            })
            .unwrap_or_else(|_| {
                issues.push(format!(
                    "{label}: a link could not be rewritten, so the original Markdown was kept"
                ));
                content
            })
        };
        if let Err(error) = write_new(&destination, rewritten.as_bytes()) {
            issues.push(format!("{label}: {error}"));
            continue;
        }
        written += 1;
        if let Some(properties) = entry.properties_json {
            let sidecar = parent.join(format!("{}{SIDECAR}", entry.path.last().unwrap()));
            if let Err(error) = write_new(&sidecar, properties.as_bytes()) {
                issues.push(format!(
                    "{label}: could not write sidebar properties ({error})"
                ));
            }
        }
    }
    let directory = staging.keep().display().to_string();
    Ok(ExportReport {
        directory,
        written,
        issues,
    })
}

#[tauri::command]
pub async fn export_markdown_files(
    app: AppHandle,
    window: WebviewWindow,
    entries: Vec<ExportEntry>,
) -> Result<Option<ExportReport>, String> {
    #[cfg(desktop)]
    {
        if entries
            .iter()
            .try_fold(0usize, |size, entry| {
                size.checked_add(entry.content.as_ref().map_or(0, String::len))?
                    .checked_add(entry.properties_json.as_ref().map_or(0, String::len))
            })
            .is_none_or(|size| size > MAX_EXPORT)
        {
            return Err(
                "The Markdown export exceeds the batch limit. Export smaller folders separately."
                    .into(),
            );
        }
        let target = spawn_blocking(move || {
            window
                .dialog()
                .file()
                .set_parent(&window)
                .set_title("Choose a destination for the Markdown export")
                .blocking_pick_folder()
        })
        .await
        .map_err(|_| "Could not open the export picker.".to_owned())?;
        let Some(target) = target else {
            return Ok(None);
        };
        let target = target
            .into_path()
            .map_err(|_| "Expected a local export folder.".to_owned())?;
        let pool = attachment_database(&app)
            .await
            .map_err(|_| "Could not open the workspace.".to_owned())?;
        let directory = local_data_directory(&app)
            .map_err(|_| "Could not open attachment storage.".to_owned())?;
        let mut managed = BTreeMap::new();
        for entry in &entries {
            let (Some(note), Some(content)) = (&entry.id, &entry.content) else {
                continue;
            };
            if !entry
                .path
                .last()
                .is_some_and(|file| markdown_file(Path::new(file)))
            {
                continue;
            }
            for reference in references::ids_in(content).collect::<BTreeSet<_>>() {
                if let Ok(attachment) = find_attachment(&pool, note, &reference).await
                    && let Ok(blob) = storage::blob_name(&attachment.digest, &attachment.mime_type)
                    && let Some((_, extension)) = blob.rsplit_once('.')
                {
                    let filename = format!("{}.{}", attachment.id, extension);
                    managed.insert((note.clone(), reference), (filename, attachment));
                }
            }
        }
        spawn_blocking(move || write_export(&target, entries, &directory, managed))
            .await
            .map_err(|_| "Could not write the Markdown export.".to_owned())?
            .map(Some)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, window, entries);
        Err("Markdown export requires a desktop file picker.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abc00000-0000-4000-8000-000000000001";
    const MISSING: &str = "abc00000-0000-4000-8000-000000000002";
    const ASSET: &[u8] = b"portable attachment\n";

    #[test]
    fn written_bundle_round_trips_nested_utf8_markdown_and_assets_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let managed_directory = directory.path().join("managed");
        fs::create_dir(&managed_directory).unwrap();
        let staged = storage::stage_bytes(&managed_directory, "sample.txt", ASSET).unwrap();
        let attachment = Attachment {
            id: ID.into(),
            original_filename: staged.original_filename.clone(),
            mime_type: staged.mime_type.into(),
            size_bytes: staged.size_bytes,
            digest: staged.digest.clone(),
        };
        staged.publish().unwrap();
        let target = directory.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("Notes.md"), "untouched").unwrap();

        let body = format!(
            "\u{feff}---\r\ntitle: उदाहरण\r\n---\r\n\r\n# Café 🐈\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n```rs\r\nlet link = \"attachment:{ID}\";\r\n```\r\n\r\n$e=mc^2$\r\n\r\n```mermaid\r\ngraph TD\r\n A --> B\r\n```\r\n\r\n[[Other|Alias]]\r\n\r\n[Download](attachment:{ID}#page=1)\r\n\r\n[Missing](attachment:{MISSING})\r\n"
        );
        let properties = r#"[{"name":"Tags","value":"work, हिंदी"}]"#;
        let note_path = vec!["研究".into(), "Deep".into(), "Notes.md".into()];
        let entries = vec![
            ExportEntry {
                id: None,
                path: vec!["研究".into()],
                content: None,
                properties_json: None,
            },
            ExportEntry {
                id: Some("note".into()),
                path: note_path.clone(),
                content: Some(body.clone()),
                properties_json: Some(properties.into()),
            },
            ExportEntry {
                id: Some("duplicate".into()),
                path: note_path,
                content: Some("must never replace".into()),
                properties_json: None,
            },
            ExportEntry {
                id: None,
                path: vec!["..".into(), "escape.md".into()],
                content: Some("invalid path".into()),
                properties_json: None,
            },
        ];
        let managed = BTreeMap::from([(
            ("note".into(), ID.into()),
            (format!("{ID}.txt"), attachment),
        )]);
        let report = write_export(&target, entries, &managed_directory, managed).unwrap();
        assert_eq!(report.written, 1);
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.contains("unresolved attachment"))
        );
        assert!(
            report
                .issues
                .iter()
                .any(|issue| issue.contains("unsafe export path"))
        );
        assert_eq!(
            fs::read_to_string(target.join("Notes.md")).unwrap(),
            "untouched"
        );
        assert!(!target.join("escape.md").exists());
        let root = PathBuf::from(report.directory);
        let imported = read_import(vec![root.join("研究")]);
        assert!(imported.issues.is_empty(), "{:?}", imported.issues);
        assert!(
            imported
                .entries
                .iter()
                .any(|entry| entry.path == ["研究", "Deep"] && entry.content.is_none())
        );
        let note = imported
            .entries
            .iter()
            .find(|entry| entry.content.is_some())
            .unwrap();
        assert_eq!(note.path, ["研究", "Deep", "Notes.md"]);
        let expected = body.replace(
            &format!("[Download](attachment:{ID}"),
            &format!("[Download]({ASSETS}/{ID}.txt"),
        );
        assert_eq!(note.content.as_deref(), Some(expected.as_str()));
        assert_eq!(note.properties_json.as_deref(), Some(properties));
        assert_eq!(note.assets.len(), 1);
        assert_eq!(note.assets[0].bytes, ASSET);
    }

    #[cfg(unix)]
    #[test]
    fn folder_import_skips_symbolic_links_and_invalid_utf8() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("folder");
        fs::create_dir(&folder).unwrap();
        fs::write(root.path().join("outside.md"), "outside selection").unwrap();
        std::os::unix::fs::symlink(root.path().join("outside.md"), folder.join("link.md")).unwrap();
        fs::write(folder.join("invalid.md"), [0xff]).unwrap();
        fs::write(folder.join("safe.markdown"), "ordinary").unwrap();
        let imported = read_import(vec![folder]);
        assert_eq!(imported.entries.len(), 2);
        assert_eq!(imported.entries[1].content.as_deref(), Some("ordinary"));
        assert!(
            imported
                .issues
                .iter()
                .any(|issue| issue.contains("symbolic link"))
        );
        assert!(imported.issues.iter().any(|issue| issue.contains("UTF-8")));
    }
}
