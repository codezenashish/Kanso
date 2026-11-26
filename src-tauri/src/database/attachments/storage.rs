use super::{Attachment, AttachmentError};
use sha2::{Digest, Sha256};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;

pub(super) const FILE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt"];
pub(super) const MAX_BYTES: u64 = 25 * 1024 * 1024;

struct FileFormat {
    extension: &'static str,
    mime_type: &'static str,
    matches: fn(&[u8]) -> bool,
}

const FORMATS: &[FileFormat] = &[
    FileFormat {
        extension: "png",
        mime_type: "image/png",
        matches: |bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR"),
    },
    FileFormat {
        extension: "jpg",
        mime_type: "image/jpeg",
        matches: |bytes| bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9"),
    },
    FileFormat {
        extension: "gif",
        mime_type: "image/gif",
        matches: |bytes| {
            bytes.len() >= 14
                && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
                && bytes.ends_with(b";")
        },
    },
    FileFormat {
        extension: "webp",
        mime_type: "image/webp",
        matches: |bytes| {
            bytes.starts_with(b"RIFF")
                && matches!(
                    bytes.get(8..16),
                    Some(b"WEBPVP8 " | b"WEBPVP8L" | b"WEBPVP8X")
                )
        },
    },
    FileFormat {
        extension: "pdf",
        mime_type: "application/pdf",
        matches: |bytes| bytes.starts_with(b"%PDF-") && bytes.trim_ascii_end().ends_with(b"%%EOF"),
    },
    FileFormat {
        extension: "txt",
        mime_type: "text/plain",
        matches: |bytes| {
            std::str::from_utf8(bytes).is_ok_and(|text| {
                let start = text.trim_start_matches('\u{feff}').trim_start();
                !start.starts_with("#!")
                    && !start.starts_with('<')
                    && !start.starts_with("[Desktop Entry]")
                    && !start.starts_with("[InternetShortcut]")
                    && text
                        .chars()
                        .all(|ch| !ch.is_control() || matches!(ch, '\r' | '\n' | '\t'))
            })
        },
    },
];

pub(super) struct StagedAttachment {
    file: NamedTempFile,
    destination: PathBuf,
    pub(super) original_filename: String,
    pub(super) mime_type: &'static str,
    pub(super) size_bytes: i64,
    pub(super) digest: String,
}

impl StagedAttachment {
    pub(super) fn publish(self) -> Result<(), AttachmentError> {
        // Concurrent imports can share a blob. Never overwrite an existing managed file.
        match self.file.persist_noclobber(&self.destination) {
            Ok(_) => {}
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                verify_bytes(&self.destination, self.size_bytes, &self.digest)?;
            }
            Err(_) => return Err(AttachmentError::StorageUnavailable),
        }

        #[cfg(unix)]
        {
            // Sync both the new file entry and the attachment directory's own entry.
            let directory = self.destination.parent().unwrap();
            for entry in [directory, directory.parent().unwrap()] {
                File::open(entry)
                    .and_then(|dir| dir.sync_all())
                    .map_err(|_| AttachmentError::StorageUnavailable)?;
            }
        }
        Ok(())
    }
}

pub(super) fn stage(directory: &Path, source: &Path) -> Result<StagedAttachment, AttachmentError> {
    if !source.is_absolute() || source.components().any(|part| part == Component::ParentDir) {
        return Err(AttachmentError::InvalidFile);
    }
    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(AttachmentError::InvalidFile)?;
    let file = open_regular_file(source).map_err(|_| AttachmentError::InvalidFile)?;
    stage_bytes(directory, filename, &read_limited(file)?)
}

pub(super) fn stage_bytes(
    directory: &Path,
    filename: &str,
    bytes: &[u8],
) -> Result<StagedAttachment, AttachmentError> {
    if filename.is_empty()
        || filename
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':'))
    {
        return Err(AttachmentError::InvalidFile);
    }
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AttachmentError::FileTooLarge);
    }
    if bytes.is_empty() {
        return Err(AttachmentError::InvalidFile);
    }
    let original_filename = filename.to_owned();
    let extension = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or(AttachmentError::UnsupportedType)?
        .to_ascii_lowercase();
    let extension = if extension == "jpeg" {
        "jpg"
    } else {
        &extension
    };
    let format = FORMATS
        .iter()
        .find(|format| format.extension == extension)
        .ok_or(AttachmentError::UnsupportedType)?;

    if !(format.matches)(bytes) {
        return Err(AttachmentError::UnsupportedType);
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    let root = managed_root(directory, true)?;
    let destination = root.join(format!("{digest}.{}", format.extension));
    let mut file = tempfile::Builder::new()
        .prefix(".import-")
        .tempfile_in(root)
        .map_err(|_| AttachmentError::StorageUnavailable)?;
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| AttachmentError::StorageUnavailable)?;

    Ok(StagedAttachment {
        file,
        destination,
        original_filename,
        mime_type: format.mime_type,
        size_bytes: bytes.len() as i64,
        digest,
    })
}

pub(super) fn verified_file(
    directory: &Path,
    attachment: &Attachment,
) -> Result<(PathBuf, Vec<u8>), AttachmentError> {
    let name = blob_name(&attachment.digest, &attachment.mime_type)?;
    let path = managed_root(directory, false)?.join(name);
    let format = FORMATS
        .iter()
        .find(|format| format.mime_type == attachment.mime_type)
        .ok_or(AttachmentError::ManagedFileInvalid)?;
    let bytes = verify_bytes(&path, attachment.size_bytes, &attachment.digest)?;
    if !(format.matches)(&bytes) {
        return Err(AttachmentError::ManagedFileInvalid);
    }
    Ok((path, bytes))
}

pub(super) fn blob_name(digest: &str, mime_type: &str) -> Result<String, AttachmentError> {
    if !valid_digest(digest) {
        return Err(AttachmentError::ManagedFileInvalid);
    }
    let format = FORMATS
        .iter()
        .find(|format| format.mime_type == mime_type)
        .ok_or(AttachmentError::ManagedFileInvalid)?;
    Ok(format!("{digest}.{}", format.extension))
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn is_blob_name(name: &str) -> bool {
    name.split_once('.').is_some_and(|(digest, extension)| {
        valid_digest(digest) && FORMATS.iter().any(|format| format.extension == extension)
    })
}

pub(super) fn managed_root(directory: &Path, create: bool) -> Result<PathBuf, AttachmentError> {
    let base = directory
        .canonicalize()
        .map_err(|_| AttachmentError::StorageUnavailable)?;
    let root = base.join("attachments");
    if create {
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        if let Err(error) = builder.create(&root)
            && error.kind() != io::ErrorKind::AlreadyExists
        {
            return Err(AttachmentError::StorageUnavailable);
        }
    }
    let metadata = fs::symlink_metadata(&root).map_err(managed_read_error)?;
    if !metadata.is_dir() || root.canonicalize().map_err(managed_read_error)? != root {
        return Err(AttachmentError::ManagedFileInvalid);
    }
    Ok(root)
}

pub(super) fn open_regular_file(path: &Path) -> io::Result<File> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Expected a regular file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Expected a regular file",
        ));
    }
    Ok(file)
}

pub(super) fn read_limited(file: File) -> Result<Vec<u8>, AttachmentError> {
    let size = file
        .metadata()
        .map_err(|_| AttachmentError::InvalidFile)?
        .len();
    if size > MAX_BYTES {
        return Err(AttachmentError::FileTooLarge);
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AttachmentError::InvalidFile)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(AttachmentError::FileTooLarge);
    }
    if bytes.is_empty() {
        return Err(AttachmentError::InvalidFile);
    }
    Ok(bytes)
}

fn managed_read_error(error: io::Error) -> AttachmentError {
    match error.kind() {
        io::ErrorKind::NotFound => AttachmentError::ManagedFileMissing,
        io::ErrorKind::PermissionDenied => AttachmentError::StorageUnavailable,
        _ => AttachmentError::ManagedFileInvalid,
    }
}

fn verify_bytes(
    path: &Path,
    expected_size: i64,
    expected_digest: &str,
) -> Result<Vec<u8>, AttachmentError> {
    let file = open_regular_file(path).map_err(managed_read_error)?;
    let bytes = read_limited(file).map_err(|_| AttachmentError::ManagedFileInvalid)?;
    if bytes.len() as i64 != expected_size
        || format!("{:x}", Sha256::digest(&bytes)) != expected_digest
    {
        return Err(AttachmentError::ManagedFileInvalid);
    }
    Ok(bytes)
}
