//! One file at a time: names and headers, copies handed to other apps, editing in another app,
//! the in-app documents, the byte cache, links on this computer, thumbnails and placeholders.

// name checks, object headers and tags
pub mod objects;
pub mod open_copies;
// "Edit" in another app: a private copy, watched, uploaded back when saved
#[cfg(desktop)]
pub mod edit;
// WP-D: open and save documents for the in-app viewers and editor
pub mod doc;
// recently fetched file bytes, shared by the viewers, downloads and "Open"
pub mod filecache;
// links on this computer met inside a folder: never followed out, never written through
pub mod local_links;
pub mod thumbs;
pub mod placeholders;
