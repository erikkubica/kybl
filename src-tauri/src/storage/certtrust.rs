//! Trust on first use for servers with their own TLS certificate (FTPS, WebDAV over https), the
//! way FileZilla does it.
//!
//! A connection may remember one certificate: the SHA-256 of the server's leaf certificate,
//! `NetConfig::cert_fingerprint`, as "AB:CD:…". A server is accepted when its chain checks out
//! against the system's roots as usual, or when its leaf certificate is exactly the remembered
//! one (its issuer, name and dates don't matter then: the user chose to trust it).
//!
//! Anything else is refused with a [`Refusal`]: `ErrKind::UntrustedCert` when nothing was
//! trusted yet, `ErrKind::CertChanged` when another certificate was. Its detail starts with
//! `cert-untrusted <fp>` or `cert-changed <fp> expected <saved fp>`, followed by `key: value`
//! lines (reason, name, issuer, valid-from, valid-until), so the UI can show the certificate and
//! offer to trust it (see BACKENDS.md).

use std::{
    error::Error as StdError,
    fmt,
    sync::{Arc, Mutex, OnceLock},
};

use rustls::{
    client::{
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        WebPkiServerVerifier,
    },
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, DigitallySignedStruct, OtherError, SignatureScheme,
};

use super::{ErrKind, StorageError};

// ---------------------------------------------------------------- fingerprints

/// "AB:CD:…": the SHA-256 of a certificate's DER bytes, as FileZilla and browsers show it.
pub fn fingerprint(der: &[u8]) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, der);
    d.as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Fingerprints compare by their hex digits alone: case, colons, spaces and a "SHA256:" prefix
/// don't matter.
pub fn same(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.trim();
        let s = s.strip_prefix("SHA256:").or_else(|| s.strip_prefix("sha256:")).unwrap_or(s);
        s.chars().filter(char::is_ascii_hexdigit).map(|c| c.to_ascii_uppercase()).collect::<String>()
    };
    let (a, b) = (norm(a), norm(b));
    !a.is_empty() && a == b
}

// ---------------------------------------------------------------- what a certificate says

/// The parts of a certificate people check before trusting it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CertInfo {
    pub fingerprint: String,
    /// who it's made out to: the subject's common name, else its first alternative name
    pub name: String,
    /// who signed it: the issuer's common name, else its organisation
    pub issuer: String,
    /// "YYYY-MM-DD"
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    /// signed by itself (subject and issuer are the same)
    pub self_signed: bool,
    /// seconds since 1970, to compare with now
    not_before: Option<i64>,
    not_after: Option<i64>,
}

impl CertInfo {
    pub fn of(der: &[u8]) -> Self {
        let mut info = Self { fingerprint: fingerprint(der), ..Default::default() };
        if let Some(p) = der::parse(der) {
            info.name = p.subject.cn.clone().or_else(|| p.alt_names.first().cloned()).or(p.subject.o.clone()).unwrap_or_default();
            info.issuer = p.issuer.cn.clone().or(p.issuer.o.clone()).unwrap_or_default();
            info.not_before = p.not_before.as_ref().map(|t| t.1);
            info.not_after = p.not_after.as_ref().map(|t| t.1);
            info.valid_from = p.not_before.map(|t| t.0);
            info.valid_until = p.not_after.map(|t| t.0);
            info.self_signed = p.self_signed;
        }
        info
    }
}

// ---------------------------------------------------------------- refusals

/// Why a certificate wasn't trusted, as the UI names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    SelfSigned,
    UnknownIssuer,
    WrongName,
    Expired,
    NotYetValid,
    Other,
}

impl Reason {
    fn id(self) -> &'static str {
        match self {
            Reason::SelfSigned => "self-signed",
            Reason::UnknownIssuer => "unknown-issuer",
            Reason::WrongName => "wrong-name",
            Reason::Expired => "expired",
            Reason::NotYetValid => "not-yet-valid",
            Reason::Other => "other",
        }
    }
}

/// A certificate the verifier refused, with what the UI needs to offer trusting it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub info: CertInfo,
    pub reasons: Vec<Reason>,
    /// the name Kybl connected to
    pub host: String,
    /// the fingerprint trusted before, when there was one
    pub pinned: Option<String>,
    /// what rustls said
    pub tls: String,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "certificate refused ({}): {}", self.info.fingerprint, self.tls)
    }
}

impl StdError for Refusal {}

/// One line of text: names in certificates are the server's to choose.
fn line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

impl Refusal {
    fn new(info: CertInfo, err: &rustls::Error, host: &str, pinned: Option<&str>, now: i64) -> Self {
        let mut reasons = Vec::new();
        let cert_err = match err {
            rustls::Error::InvalidCertificate(e) => Some(e),
            _ => None,
        };
        let expired = info.not_after.is_some_and(|t| t < now);
        let early = info.not_before.is_some_and(|t| t > now);
        match cert_err {
            Some(CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. }) => reasons.push(Reason::WrongName),
            Some(CertificateError::UnknownIssuer) if !info.self_signed => reasons.push(Reason::UnknownIssuer),
            _ => {}
        }
        // webpki stops at the first problem; a self-signed certificate is the usual one, and dates
        // are easy to check here
        if info.self_signed {
            reasons.insert(0, Reason::SelfSigned);
        }
        if expired || matches!(cert_err, Some(CertificateError::Expired | CertificateError::ExpiredContext { .. })) {
            reasons.push(Reason::Expired);
        }
        if early || matches!(cert_err, Some(CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. })) {
            reasons.push(Reason::NotYetValid);
        }
        if reasons.is_empty() {
            reasons.push(Reason::Other);
        }
        Self { info, reasons, host: host.to_string(), pinned: pinned.map(str::to_string), tls: err.to_string() }
    }

    fn reason_text(&self) -> String {
        let date = |d: &Option<String>| d.clone().unwrap_or_else(|| "an earlier date".into());
        self.reasons
            .iter()
            .map(|r| match r {
                Reason::SelfSigned => "The server signed it itself.".to_string(),
                Reason::UnknownIssuer => "It isn't from an authority Kybl knows.".to_string(),
                Reason::WrongName if self.info.name.is_empty() => format!("It isn't made out to {}.", self.host),
                Reason::WrongName => format!("It's made out to {}, not {}.", line(&self.info.name), self.host),
                Reason::Expired => format!("It expired on {}.", date(&self.info.valid_until)),
                Reason::NotYetValid => format!("It isn't valid until {}.", date(&self.info.valid_from)),
                Reason::Other => "It didn't pass the usual checks.".to_string(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn into_error(self) -> StorageError {
        let mut detail = match &self.pinned {
            None => format!("cert-untrusted {}", self.info.fingerprint),
            Some(p) => format!("cert-changed {} expected {}", self.info.fingerprint, line(p)),
        };
        let reasons = self.reasons.iter().map(|r| r.id()).collect::<Vec<_>>().join(", ");
        detail.push_str(&format!("\nreason: {reasons}"));
        detail.push_str(&format!("\nhost: {}", line(&self.host)));
        if !self.info.name.is_empty() {
            detail.push_str(&format!("\nname: {}", line(&self.info.name)));
        }
        if !self.info.issuer.is_empty() {
            detail.push_str(&format!("\nissuer: {}", line(&self.info.issuer)));
        }
        if let Some(d) = &self.info.valid_from {
            detail.push_str(&format!("\nvalid-from: {d}"));
        }
        if let Some(d) = &self.info.valid_until {
            detail.push_str(&format!("\nvalid-until: {d}"));
        }
        detail.push_str(&format!("\ntls: {}", line(&self.tls)));
        match self.pinned {
            None => StorageError::new(
                ErrKind::UntrustedCert,
                format!("The server's security certificate isn't trusted. {} If you know this server, check its certificate and trust it to connect.", self.reason_text()),
            ),
            Some(_) => StorageError::new(
                ErrKind::CertChanged,
                "The server's certificate changed since you trusted it. Someone may be intercepting the connection, so Kybl didn't connect. If you know it was renewed or replaced, check the new one and trust it.",
            ),
        }
        .with_detail(detail)
    }
}

/// The refusal behind an error, wherever it sits in the chain: reqwest keeps the rustls error
/// inside an `io::Error`, whose `source()` skips it.
pub fn refusal_in(e: &(dyn StdError + 'static)) -> Option<Refusal> {
    let mut cur: Option<&(dyn StdError + 'static)> = Some(e);
    while let Some(err) = cur {
        if let Some(r) = err.downcast_ref::<Refusal>() {
            return Some(r.clone());
        }
        if let Some(rustls::Error::InvalidCertificate(CertificateError::Other(OtherError(inner)))) = err.downcast_ref::<rustls::Error>()
            && let Some(r) = inner.downcast_ref::<Refusal>()
        {
            return Some(r.clone());
        }
        if let Some(io) = err.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
            && let Some(r) = refusal_in(inner)
        {
            return Some(r);
        }
        cur = err.source();
    }
    None
}

// ---------------------------------------------------------------- the verifier

fn provider() -> Arc<CryptoProvider> {
    static P: OnceLock<Arc<CryptoProvider>> = OnceLock::new();
    P.get_or_init(|| Arc::new(rustls::crypto::ring::default_provider())).clone()
}

/// The usual chain check against the system's roots (shared; None when there are no roots).
fn webpki() -> Option<Arc<WebPkiServerVerifier>> {
    static V: OnceLock<Option<Arc<WebPkiServerVerifier>>> = OnceLock::new();
    V.get_or_init(|| WebPkiServerVerifier::builder_with_provider(super::net::roots(), provider()).build().ok()).clone()
}

/// Where a verifier leaves the certificate it refused, for errors that lose the rustls error
/// on the way (suppaftp keeps only its text).
pub type Seen = Arc<Mutex<Option<Refusal>>>;

/// Accepts a server whose chain checks out, or whose leaf certificate is the trusted one.
#[derive(Debug)]
pub struct PinVerifier {
    inner: Option<Arc<WebPkiServerVerifier>>,
    pinned: Option<String>,
    seen: Seen,
}

impl PinVerifier {
    pub fn new(pinned: Option<&str>) -> (Self, Seen) {
        let seen = Seen::default();
        let pinned = pinned.map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
        (Self { inner: webpki(), pinned, seen: seen.clone() }, seen)
    }

    /// The decision, apart from the TLS plumbing: the chain check runs only when the pin doesn't
    /// already settle it.
    fn decide(&self, leaf: &[u8], host: &str, now: UnixTime, chain: impl FnOnce() -> Result<(), rustls::Error>) -> Result<(), Refusal> {
        let fp = fingerprint(leaf);
        if self.pinned.as_deref().is_some_and(|p| same(p, &fp)) {
            return Ok(());
        }
        match chain() {
            Ok(()) => Ok(()),
            Err(e) => Err(Refusal::new(CertInfo::of(leaf), &e, host, self.pinned.as_deref(), now.as_secs() as i64)),
        }
    }
}

fn host_of(name: &ServerName<'_>) -> String {
    match name {
        ServerName::DnsName(d) => d.as_ref().to_string(),
        ServerName::IpAddress(ip) => std::net::IpAddr::from(*ip).to_string(),
        _ => String::new(),
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let mut other: Option<rustls::Error> = None;
        let chain = || match &self.inner {
            Some(v) => match v.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now) {
                Ok(_) => Ok(()),
                // only certificate problems can be trusted away
                Err(e @ rustls::Error::InvalidCertificate(_)) => Err(e),
                Err(e) => {
                    other = Some(e.clone());
                    Err(e)
                }
            },
            None => Err(CertificateError::UnknownIssuer.into()),
        };
        match self.decide(end_entity.as_ref(), &host_of(server_name), now, chain) {
            Ok(()) => Ok(ServerCertVerified::assertion()),
            Err(_) if other.is_some() => Err(other.unwrap()),
            Err(r) => {
                *self.seen.lock().unwrap() = Some(r.clone());
                Err(CertificateError::Other(OtherError(Arc::new(r))).into())
            }
        }
    }

    // The handshake signature proves the server holds the certificate's key, trusted or not.
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &provider().signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &provider().signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        provider().signature_verification_algorithms.supported_schemes()
    }
}

/// A TLS setup that trusts the system's roots or the pinned certificate, and where a refused
/// certificate is left.
pub fn client_config(pinned: Option<&str>) -> (Arc<rustls::ClientConfig>, Seen) {
    let (v, seen) = PinVerifier::new(pinned);
    let cfg = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(v))
        .with_no_client_auth();
    (Arc::new(cfg), seen)
}

// ---------------------------------------------------------------- reading certificates

/// Just enough DER to read a certificate's names and dates (no new dependency for it).
mod der {
    pub struct Name {
        pub cn: Option<String>,
        pub o: Option<String>,
    }

    pub struct Parsed {
        pub subject: Name,
        pub issuer: Name,
        pub alt_names: Vec<String>,
        /// ("YYYY-MM-DD", seconds since 1970)
        pub not_before: Option<(String, i64)>,
        pub not_after: Option<(String, i64)>,
        pub self_signed: bool,
    }

    /// (tag, contents, what follows)
    fn tlv(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
        let (&tag, b) = b.split_first()?;
        let (&l0, mut b) = b.split_first()?;
        let len = if l0 < 0x80 {
            l0 as usize
        } else {
            let n = (l0 & 0x7f) as usize;
            if n == 0 || n > 4 || b.len() < n {
                return None;
            }
            let l = b[..n].iter().fold(0usize, |l, &x| (l << 8) | x as usize);
            b = &b[n..];
            l
        };
        if b.len() < len {
            return None;
        }
        Some((tag, &b[..len], &b[len..]))
    }

    fn each(mut b: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
        std::iter::from_fn(move || {
            let (t, c, rest) = tlv(b)?;
            b = rest;
            Some((t, c))
        })
    }

    fn text(tag: u8, c: &[u8]) -> Option<String> {
        match tag {
            // UTF8String, PrintableString, T61String, IA5String
            0x0c | 0x13 | 0x14 | 0x16 => Some(String::from_utf8_lossy(c).into_owned()),
            // BMPString
            0x1e => Some(String::from_utf16_lossy(&c.chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])).collect::<Vec<_>>())),
            _ => None,
        }
    }

    const CN: &[u8] = &[0x55, 0x04, 0x03];
    const O: &[u8] = &[0x55, 0x04, 0x0a];
    const SAN: &[u8] = &[0x55, 0x1d, 0x11];

    fn name(b: &[u8]) -> Name {
        let mut n = Name { cn: None, o: None };
        for (_, set) in each(b) {
            for (_, attr) in each(set) {
                let mut it = each(attr);
                let (Some((0x06, oid)), Some((tag, val))) = (it.next(), it.next()) else { continue };
                let slot = if oid == CN { &mut n.cn } else if oid == O { &mut n.o } else { continue };
                if slot.is_none() {
                    *slot = text(tag, val).filter(|s| !s.trim().is_empty());
                }
            }
        }
        n
    }

    /// UTCTime or GeneralizedTime, as ("YYYY-MM-DD", seconds since 1970).
    fn time(tag: u8, c: &[u8]) -> Option<(String, i64)> {
        let s = std::str::from_utf8(c).ok()?;
        let (y, rest) = match tag {
            0x17 => {
                let yy: i64 = s.get(0..2)?.parse().ok()?;
                (if yy >= 50 { 1900 + yy } else { 2000 + yy }, s.get(2..)?)
            }
            0x18 => (s.get(0..4)?.parse().ok()?, s.get(4..)?),
            _ => return None,
        };
        let num = |r: std::ops::Range<usize>| rest.get(r).and_then(|x| x.parse::<i64>().ok());
        let (m, d) = (num(0..2)?, num(2..4)?);
        let (h, mi, sec) = (num(4..6).unwrap_or(0), num(6..8).unwrap_or(0), num(8..10).unwrap_or(0));
        let days = crate::storage::webdav::days_from_civil(y, m, d)?;
        Some((format!("{y:04}-{m:02}-{d:02}"), days * 86_400 + h * 3600 + mi * 60 + sec))
    }

    fn alt_names(exts: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        let Some((0x30, list, _)) = tlv(exts) else { return out };
        for (_, ext) in each(list) {
            let mut it = each(ext);
            let Some((0x06, oid)) = it.next() else { continue };
            if oid != SAN {
                continue;
            }
            let Some((_, value)) = it.find(|(t, _)| *t == 0x04) else { continue };
            let Some((0x30, names, _)) = tlv(value) else { continue };
            for (tag, v) in each(names) {
                match tag {
                    // dNSName
                    0x82 => out.push(String::from_utf8_lossy(v).into_owned()),
                    // iPAddress
                    0x87 if v.len() == 4 => out.push(std::net::Ipv4Addr::new(v[0], v[1], v[2], v[3]).to_string()),
                    0x87 if v.len() == 16 => out.push(std::net::Ipv6Addr::from(<[u8; 16]>::try_from(v).unwrap()).to_string()),
                    _ => {}
                }
            }
        }
        out
    }

    pub fn parse(der: &[u8]) -> Option<Parsed> {
        let (0x30, cert, _) = tlv(der)? else { return None };
        let (0x30, tbs, _) = tlv(cert)? else { return None };
        let mut r = tbs;
        let (t, _, rest) = tlv(r)?;
        // [0] version, absent on v1 certificates
        if t == 0xa0 {
            r = rest;
        }
        let (_, _, r) = tlv(r)?; // serial number
        let (_, _, r) = tlv(r)?; // signature algorithm
        let (_, issuer_raw, r) = tlv(r)?;
        let (_, validity, r) = tlv(r)?;
        let (_, subject_raw, r) = tlv(r)?;
        let (_, _, mut r) = tlv(r)?; // public key
        let mut exts: &[u8] = &[];
        while let Some((t, c, rest)) = tlv(r) {
            if t == 0xa3 {
                exts = c;
            }
            r = rest;
        }
        let mut v = each(validity);
        let not_before = v.next().and_then(|(t, c)| time(t, c));
        let not_after = v.next().and_then(|(t, c)| time(t, c));
        Some(Parsed {
            subject: name(subject_raw),
            issuer: name(issuer_raw),
            alt_names: alt_names(exts),
            not_before,
            not_after,
            self_signed: issuer_raw == subject_raw,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    /// A throwaway self-signed certificate: CN=ftp.example.test, O=Example Test, alternative
    /// names ftp.example.test and files.example.test, valid 2026-11-23 to 2036-11-20.
    const CERT: &str = "MIIByTCCAW+gAwIBAgIUWigG6zlhc3l6jtMxnGkGBzYvpJswCgYIKoZIzj0EAwIwMjEZMBcGA1UEAwwQZnRwLmV4YW1wbGUudGVzdDEVMBMGA1UECgwMRXhhbXBsZSBUZXN0MB4XDTI2MTEyMzA4MjY0OVoXDTM2MTEyMDA4MjY0OVowMjEZMBcGA1UEAwwQZnRwLmV4YW1wbGUudGVzdDEVMBMGA1UECgwMRXhhbXBsZSBUZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEx/xE4wXOzCExrU0wczbEq01mxnlCcR3DIV49BLsrCHevxfcHUJXvxwNH8du2gNsFOsvVT1jHjmYpuvxGfecnNKNjMGEwHQYDVR0OBBYEFPjMu3wkmGyfOA+k68z7tFeQc/hwMA8GA1UdEwEB/wQFMAMBAf8wLwYDVR0RBCgwJoIQZnRwLmV4YW1wbGUudGVzdIISZmlsZXMuZXhhbXBsZS50ZXN0MAoGCCqGSM49BAMCA0gAMEUCIQDuxuQfHqFUkaWJFpf/j6w6nYewZyThL3kVsNpgNxNy8QIgZzIIBSz/1ArRW0tf2oYSPg+k++jDF7xJFFvP0adKvxc=";
    const FP: &str = "94:55:1B:95:48:5F:AF:F2:72:2A:C5:BA:1C:1C:6E:2E:CA:AD:A1:C4:BC:20:2E:10:23:52:03:58:07:3B:46:FD";
    const OTHER_FP: &str = "00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF";

    fn cert() -> CertificateDer<'static> {
        CertificateDer::from(base64::engine::general_purpose::STANDARD.decode(CERT).unwrap())
    }

    /// 2027-06-01, inside the certificate's dates
    fn now() -> UnixTime {
        UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_811_808_000))
    }

    fn verify(pinned: Option<&str>, host: &str, at: UnixTime) -> (Result<ServerCertVerified, rustls::Error>, Option<Refusal>) {
        let (v, seen) = PinVerifier::new(pinned);
        let name = ServerName::try_from(host.to_string()).unwrap();
        let r = v.verify_server_cert(&cert(), &[], &name, &[], at);
        let s = seen.lock().unwrap().clone();
        (r, s)
    }

    #[test]
    fn certificates_read() {
        let info = CertInfo::of(cert().as_ref());
        assert_eq!(info.fingerprint, FP);
        assert_eq!(info.name, "ftp.example.test");
        assert_eq!(info.issuer, "ftp.example.test");
        assert_eq!(info.valid_from.as_deref(), Some("2026-11-23"));
        assert_eq!(info.valid_until.as_deref(), Some("2036-11-20"));
        assert!(info.self_signed);
        assert_eq!(der::parse(cert().as_ref()).unwrap().alt_names, ["ftp.example.test", "files.example.test"]);
        // nonsense doesn't panic
        assert_eq!(CertInfo::of(b"\x30\x82\xff").name, "");
    }

    #[test]
    fn fingerprints_compare_loosely() {
        assert!(same(FP, &FP.to_lowercase()));
        assert!(same(FP, &FP.replace(':', "")));
        assert!(same(&format!("SHA256:{FP}"), FP));
        assert!(!same(FP, OTHER_FP));
        assert!(!same("", ""));
    }

    #[test]
    fn the_trusted_certificate_is_accepted_whatever_it_says() {
        let (r, seen) = verify(Some(FP), "ftp.example.test", now());
        assert!(r.is_ok());
        assert!(seen.is_none());
        // another name and long after it expired: trusted is trusted
        let late = UnixTime::since_unix_epoch(std::time::Duration::from_secs(2_500_000_000));
        let (r, _) = verify(Some(&FP.to_lowercase()), "other.example.test", late);
        assert!(r.is_ok());
    }

    #[test]
    fn an_unknown_certificate_is_refused_with_what_to_check() {
        let (r, seen) = verify(None, "ftp.example.test", now());
        let err = r.unwrap_err();
        let refusal = seen.expect("the refusal is left for the caller");
        assert_eq!(refusal.info.fingerprint, FP);
        assert!(refusal.reasons.contains(&Reason::SelfSigned), "{:?}", refusal.reasons);
        // the rustls error carries it too, for reqwest's error chain
        let io = std::io::Error::new(std::io::ErrorKind::InvalidData, err);
        assert_eq!(refusal_in(&io).as_ref(), Some(&refusal));

        let e = refusal.into_error();
        assert_eq!(e.kind, ErrKind::UntrustedCert);
        assert!(e.message.starts_with("The server's security certificate isn't trusted. The server signed it itself."), "{}", e.message);
        let d = e.detail.unwrap();
        assert!(d.starts_with(&format!("cert-untrusted {FP}\nreason: self-signed")), "{d}");
        assert!(d.contains("\nname: ftp.example.test\n"));
        assert!(d.contains("\nissuer: ftp.example.test\n"));
        assert!(d.contains("\nvalid-until: 2036-11-20\n"));
    }

    #[test]
    fn another_certificate_than_the_trusted_one_is_a_louder_refusal() {
        let (r, seen) = verify(Some(OTHER_FP), "ftp.example.test", now());
        assert!(r.is_err());
        let e = seen.unwrap().into_error();
        assert_eq!(e.kind, ErrKind::CertChanged);
        assert!(e.message.starts_with("The server's certificate changed since you trusted it."));
        assert!(e.detail.unwrap().starts_with(&format!("cert-changed {FP} expected {OTHER_FP}\n")));
    }

    #[test]
    fn reasons_say_what_is_wrong() {
        let info = CertInfo::of(cert().as_ref());
        let late = 2_500_000_000;
        let r = Refusal::new(info.clone(), &CertificateError::UnknownIssuer.into(), "ftp.example.test", None, late);
        assert_eq!(r.reasons, [Reason::SelfSigned, Reason::Expired]);
        assert!(r.into_error().message.contains("It expired on 2036-11-20."));
        let r = Refusal::new(info, &CertificateError::NotValidForName.into(), "10.0.0.5", None, 1_811_808_000);
        assert_eq!(r.reasons, [Reason::SelfSigned, Reason::WrongName]);
        assert!(r.into_error().message.contains("It's made out to ftp.example.test, not 10.0.0.5."));
        let r = Refusal::new(CertInfo::default(), &CertificateError::UnknownIssuer.into(), "h", None, 0);
        assert_eq!(r.reasons, [Reason::UnknownIssuer]);
    }
}
