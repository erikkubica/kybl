//! Drive v3 as Kybl uses it: the file resource, the Google Docs export formats, and the calls
//! (list, look up by name, get, create a folder, update, trash, copy).

use serde::Deserialize;
use serde_json::{json, Value};

use super::paths::Node;
use crate::oauth::http::{enc, Api};
use crate::storage::{extras, Entry, ExportFormat, Hashes, NativeDoc, SResult};

pub const FOLDER: &str = "application/vnd.google-apps.folder";
pub const SHORTCUT: &str = "application/vnd.google-apps.shortcut";
const GOOGLE_APPS: &str = "application/vnd.google-apps.";

/// The fields Kybl reads of a file.
pub const FILE_FIELDS: &str = "id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,parents,version,thumbnailLink,shortcutDetails,webViewLink";

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Shortcut {
    pub target_id: String,
    pub target_mime_type: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    /// a decimal string; missing for folders and Google Docs
    pub size: Option<String>,
    pub modified_time: Option<String>,
    pub created_time: Option<String>,
    pub md5_checksum: Option<String>,
    pub parents: Vec<String>,
    pub version: Option<String>,
    pub thumbnail_link: Option<String>,
    pub shortcut_details: Option<Shortcut>,
    pub web_view_link: Option<String>,
}

impl DFile {
    /// What the file is once a shortcut is followed: (id, mime type).
    pub fn target(&self) -> (&str, &str) {
        match &self.shortcut_details {
            Some(s) if self.mime_type == SHORTCUT && !s.target_id.is_empty() => (&s.target_id, &s.target_mime_type),
            _ => (&self.id, &self.mime_type),
        }
    }
    pub fn is_folder(&self) -> bool {
        self.target().1 == FOLDER
    }
    pub fn node(&self) -> Node {
        let (id, mime) = self.target();
        Node { id: id.to_string(), own_id: self.id.clone(), folder: mime == FOLDER, mime: mime.to_string() }
    }
    /// A stand-in ETag: the MD5 for real files; the version for Google Docs, which have none.
    pub fn etag(&self) -> Option<String> {
        self.md5_checksum.clone().or_else(|| self.version.as_ref().map(|v| format!("v{v}")))
    }
    /// Where the file opens in the browser. A shortcut's own link would open the shortcut, so
    /// it gets the target's `open?id=` link, which works for every kind of Google file.
    pub fn web_url(&self) -> String {
        let (id, _) = self.target();
        match &self.web_view_link {
            Some(l) if id == self.id && !l.is_empty() => l.clone(),
            _ => format!("https://drive.google.com/open?id={}", enc(id)),
        }
    }
    pub fn entry(&self, key: String) -> Entry {
        let (_, mime) = self.target();
        let native = exports_of(mime).map(|ex| NativeDoc { exports: ex.iter().map(|e| e.format()).collect(), web_url: Some(self.web_url()) });
        Entry {
            key,
            size: self.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
            modified: self.modified_time.as_deref().and_then(extras::parse_rfc3339),
            etag: self.etag(),
            storage_class: None,
            id: Some(self.id.clone()),
            mime: Some(mime.to_string()),
            hashes: Hashes { md5: self.md5_checksum.clone(), ..Default::default() },
            native,
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------- Google Docs exports

#[derive(Debug, PartialEq, Eq)]
pub struct Export {
    pub mime: &'static str,
    pub ext: &'static str,
    pub label: &'static str,
}

impl Export {
    pub fn format(&self) -> ExportFormat {
        ExportFormat { mime: self.mime.into(), ext: self.ext.into(), label: self.label.into() }
    }
}

const DOCX: Export = Export { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", label: "Word document" };
const XLSX: Export = Export { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", label: "Excel workbook" };
const PPTX: Export = Export { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx", label: "PowerPoint presentation" };
const PDF: Export = Export { mime: "application/pdf", ext: "pdf", label: "PDF" };
const ODT: Export = Export { mime: "application/vnd.oasis.opendocument.text", ext: "odt", label: "OpenDocument text" };
const ODS: Export = Export { mime: "application/vnd.oasis.opendocument.spreadsheet", ext: "ods", label: "OpenDocument spreadsheet" };
const ODP: Export = Export { mime: "application/vnd.oasis.opendocument.presentation", ext: "odp", label: "OpenDocument presentation" };
const TXT: Export = Export { mime: "text/plain", ext: "txt", label: "Plain text" };
const MD: Export = Export { mime: "text/markdown", ext: "md", label: "Markdown" };
const CSV: Export = Export { mime: "text/csv", ext: "csv", label: "CSV (first sheet)" };
const PNG: Export = Export { mime: "image/png", ext: "png", label: "PNG image" };
const SVG: Export = Export { mime: "image/svg+xml", ext: "svg", label: "SVG image" };
const JPG: Export = Export { mime: "image/jpeg", ext: "jpg", label: "JPEG image" };
const APPS_SCRIPT: Export = Export { mime: "application/vnd.google-apps.script+json", ext: "json", label: "Apps Script project" };

/// The export formats of a Google Docs kind, the default (an Office format where there is one)
/// first. None for anything that isn't a Google Docs file; an empty list for Google kinds that
/// can't be downloaded at all (Forms, Sites, My Maps).
pub fn exports_of(mime: &str) -> Option<&'static [Export]> {
    if !mime.starts_with(GOOGLE_APPS) || mime == FOLDER || mime == SHORTCUT {
        return None;
    }
    Some(match &mime[GOOGLE_APPS.len()..] {
        "document" => &[DOCX, PDF, ODT, TXT, MD],
        "spreadsheet" => &[XLSX, PDF, ODS, CSV],
        "presentation" => &[PPTX, PDF, ODP, TXT],
        "drawing" => &[PNG, PDF, SVG, JPG],
        "script" => &[APPS_SCRIPT],
        _ => &[],
    })
}

// ---------------------------------------------------------------- calls

/// Where a listing looks: My Drive (and what is shared with the user), one shared drive, or
/// everywhere (folders shared from someone else's shared drive).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Corpus<'a> {
    User,
    Drive(&'a str),
    All,
}

impl Corpus<'_> {
    pub fn query(&self) -> String {
        match self {
            Corpus::User => "&corpora=user".into(),
            Corpus::Drive(d) => format!("&corpora=drive&driveId={}", enc(d)),
            Corpus::All => "&corpora=allDrives".into(),
        }
    }
}

/// A value inside a Drive query: `'it\'s'`.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FileList {
    pub files: Vec<DFile>,
    pub next_page_token: Option<String>,
}

pub struct Drive<'a> {
    pub api: &'a Api,
    pub base: &'a str,
}

impl Drive<'_> {
    pub fn files_url(&self) -> String {
        format!("{}/drive/v3/files", self.base)
    }

    /// One page of files matching `q`, ordered by name then age (the duplicate-name rule
    /// depends on that order).
    pub async fn list(&self, q: &str, corpus: Corpus<'_>, order: &str, token: Option<&str>, page_size: u32) -> SResult<FileList> {
        let mut url = format!(
            "{}?q={}&fields={}&pageSize={page_size}&orderBy={}&supportsAllDrives=true&includeItemsFromAllDrives=true{}",
            self.files_url(),
            enc(q),
            enc(&format!("nextPageToken,files({FILE_FIELDS})")),
            enc(order),
            corpus.query()
        );
        if let Some(t) = token {
            url.push_str(&format!("&pageToken={}", enc(t)));
        }
        self.api.json(|c| c.get(&url)).await
    }

    pub async fn get(&self, id: &str, fields: &str) -> SResult<DFile> {
        let url = format!("{}/{}?fields={}&supportsAllDrives=true", self.files_url(), enc(id), enc(fields));
        self.api.json(|c| c.get(&url)).await
    }

    pub async fn create_folder(&self, parent: &str, name: &str) -> SResult<DFile> {
        let url = format!("{}?fields={}&supportsAllDrives=true", self.files_url(), enc(FILE_FIELDS));
        let body = json!({ "name": name, "mimeType": FOLDER, "parents": [parent] }).to_string();
        self.api.json(|c| c.post(&url).header("content-type", "application/json").body(body.clone())).await
    }

    /// Changes a file's metadata; `add` / `remove` move it between folders.
    pub async fn update(&self, id: &str, meta: &Value, add: Option<&str>, remove: Option<&str>) -> SResult<DFile> {
        let mut url = format!("{}/{}?fields={}&supportsAllDrives=true", self.files_url(), enc(id), enc(FILE_FIELDS));
        if let Some(a) = add {
            url.push_str(&format!("&addParents={}", enc(a)));
        }
        if let Some(r) = remove {
            url.push_str(&format!("&removeParents={}", enc(r)));
        }
        let body = meta.to_string();
        self.api.json(|c| c.patch(&url).header("content-type", "application/json").body(body.clone())).await
    }

    /// Moves a file or folder (with everything inside) to the trash.
    pub async fn trash(&self, id: &str) -> SResult<()> {
        self.update(id, &json!({ "trashed": true }), None, None).await.map(|_| ())
    }

    pub async fn copy(&self, id: &str, parent: &str, name: &str) -> SResult<DFile> {
        let url = format!("{}/{}/copy?fields={}&supportsAllDrives=true", self.files_url(), enc(id), enc(FILE_FIELDS));
        let body = json!({ "name": name, "parents": [parent] }).to_string();
        self.api.json(|c| c.post(&url).header("content-type", "application/json").body(body.clone())).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_docs_export_to_office_first() {
        assert_eq!(exports_of("application/vnd.google-apps.document").unwrap()[0].ext, "docx");
        assert_eq!(exports_of("application/vnd.google-apps.spreadsheet").unwrap()[0].ext, "xlsx");
        assert_eq!(exports_of("application/vnd.google-apps.presentation").unwrap()[0].ext, "pptx");
        assert!(exports_of("application/vnd.google-apps.form").unwrap().is_empty());
        assert_eq!(exports_of(FOLDER), None);
        assert_eq!(exports_of("image/jpeg"), None);
    }

    #[test]
    fn files_become_entries() {
        let f: DFile = serde_json::from_value(json!({
            "id": "f1", "name": "a.jpg", "mimeType": "image/jpeg", "size": "1234",
            "modifiedTime": "2024-01-02T03:04:05.000Z", "md5Checksum": "abc", "parents": ["p"]
        }))
        .unwrap();
        let e = f.entry("x/a.jpg".into());
        assert_eq!((e.size, e.etag.as_deref(), e.hashes.md5.as_deref(), e.id.as_deref()), (1234, Some("abc"), Some("abc"), Some("f1")));
        assert_eq!(e.modified, extras::parse_rfc3339("2024-01-02T03:04:05Z"));
        assert!(e.native.is_none());

        let d: DFile = serde_json::from_value(json!({"id": "d1", "name": "Plan", "mimeType": "application/vnd.google-apps.document", "version": "7"})).unwrap();
        let e = d.entry("Plan".into());
        assert_eq!(e.etag.as_deref(), Some("v7"));
        assert_eq!(e.native.unwrap().exports[0].ext, "docx");

        let s: DFile = serde_json::from_value(json!({"id": "s1", "name": "Link", "mimeType": SHORTCUT, "shortcutDetails": {"targetId": "t1", "targetMimeType": FOLDER}})).unwrap();
        let n = s.node();
        assert_eq!((n.id.as_str(), n.own_id.as_str(), n.folder), ("t1", "s1", true));
    }

    #[test]
    fn query_values_are_quoted() {
        assert_eq!(quote("it's a\\b"), r"'it\'s a\\b'");
    }
}
