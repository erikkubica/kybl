//! Uploading to S3 from a stream that isn't a local file (copying between connections), in
//! parts, resumable through `WriteOpts::resume` / `on_part`.
//!
//! A stub for now: the migration package (WP-B1) fills it in. Streams of up to
//! `multipart::SINGLE_PUT_LIMIT` with a known length never get here (`S3Backend::write` sends
//! them in one request).

use std::sync::{atomic::AtomicBool, Arc};

use super::{s3::S3Backend, ByteStream, Progress, Reopen, SResult, StorageError, WriteOpts, WriteOutcome};

#[allow(clippy::too_many_arguments)]
pub async fn upload_stream(
    _s3: &S3Backend,
    _bucket: &str,
    _key: &str,
    _len: Option<u64>,
    _body: ByteStream,
    _reopen: Option<Reopen>,
    _opts: WriteOpts<'_>,
    _progress: Progress<'_>,
    _cancel: &Arc<AtomicBool>,
) -> SResult<WriteOutcome> {
    Err(StorageError::new(
        super::ErrKind::Unsupported,
        "Copying big files into S3 from another connection isn't supported yet.",
    ))
}
