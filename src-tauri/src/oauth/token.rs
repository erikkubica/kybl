//! Access tokens for one connection. The refresh token lives in the vault (`{id}#oauth`); access
//! tokens only in memory. A refresh happens once however many requests need it at the same
//! moment (single flight), when less than two minutes are left, or after a 401. Microsoft hands
//! out a new refresh token with every refresh: it is saved straight away. A refresh token the
//! service no longer accepts (`invalid_grant`: revoked, expired, password changed) marks the
//! connection as needing Reconnect and tells the UI with the `connection-auth` event.

use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::http;
use crate::storage::{ConnKind, ErrKind, SResult, StorageError};

/// Refresh when less than this is left.
const EARLY: Duration = Duration::from_secs(120);

/// What the vault keeps for a sign-in connection, as JSON under `{id}#oauth`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Stored {
    pub refresh_token: String,
    /// the OAuth client that issued the token (refreshing must use the same one)
    pub client_id: String,
    /// the user's own client secret ("Use your own OAuth app"); built-in secrets are compiled in
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

/// Where the refresh token is kept: the vault in the app, memory in tests.
#[async_trait::async_trait]
pub trait TokenStore: Send + Sync {
    async fn load(&self) -> SResult<Option<Stored>>;
    /// Writes `s` in place of `prev`, the token this source used, only while the store still
    /// holds `prev`: after a deletion (nothing there) or a newer sign-in (another token) a
    /// renewed token of an old session is dropped, never written back (S3-2).
    async fn save(&self, prev: &Stored, s: &Stored) -> SResult<()>;
}

#[derive(Default)]
struct Inner {
    /// token, when it expires, how long it was good for
    access: Option<(String, Instant, Duration)>,
    stored: Option<Stored>,
    /// The token the vault still holds after a save of a renewed one failed. The next save names
    /// it as the one it replaces; named as the unsaved one in memory, the vault would not match
    /// and every later renewal would be dropped until restart.
    in_vault: Option<Stored>,
    needs_auth: bool,
}

pub struct TokenSource {
    pub profile_id: String,
    pub kind: ConnKind,
    token_url: String,
    /// the built-in client secret for `client_id`, if it is a built-in client that has one
    builtin_secret: fn(ConnKind, &str) -> Option<String>,
    store: Arc<dyn TokenStore>,
    on_needs_auth: Box<dyn Fn(&str) + Send + Sync>,
    http: reqwest::Client,
    inner: tokio::sync::Mutex<Inner>,
    /// refreshes sent (tests check single flight with it)
    pub refreshes: AtomicU32,
}

pub fn needs_auth_error(kind: ConnKind) -> StorageError {
    StorageError::new(ErrKind::NeedsAuth, format!("Kybl is no longer signed in to your {}. Reconnect to keep using it.", kind.label()))
}

#[derive(Deserialize)]
struct TokenAnswer {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

impl TokenSource {
    pub fn new(
        profile_id: impl Into<String>,
        kind: ConnKind,
        token_url: impl Into<String>,
        builtin_secret: fn(ConnKind, &str) -> Option<String>,
        store: Arc<dyn TokenStore>,
        on_needs_auth: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            kind,
            token_url: token_url.into(),
            builtin_secret,
            store,
            on_needs_auth,
            http: http::client(),
            inner: Default::default(),
            refreshes: AtomicU32::new(0),
        }
    }

    /// Starts with an access token in hand (tests).
    #[cfg(test)]
    pub async fn prime(&self, access: &str, expires_in: Duration) {
        let mut g = self.inner.lock().await;
        g.access = Some((access.to_string(), Instant::now() + expires_in, expires_in));
    }

    /// A token good for at least two more minutes (or half its life, for short-lived ones).
    pub async fn access_token(&self) -> SResult<String> {
        let mut g = self.inner.lock().await;
        if g.needs_auth {
            return Err(needs_auth_error(self.kind));
        }
        if let Some(t) = fresh(&g) {
            return Ok(t);
        }
        self.refresh(&mut g).await
    }

    /// After a 401 for `stale`: a new token. Whoever comes second finds it already replaced
    /// and gets the new one without another refresh.
    pub async fn force_refresh(&self, stale: &str) -> SResult<String> {
        let mut g = self.inner.lock().await;
        if g.needs_auth {
            return Err(needs_auth_error(self.kind));
        }
        if let Some(t) = fresh(&g).filter(|t| t != stale) {
            return Ok(t);
        }
        g.access = None;
        self.refresh(&mut g).await
    }

    /// The service refused a fresh token: access was revoked. Marks the connection and says so.
    pub async fn lost(&self, detail: Option<String>) -> StorageError {
        let mut g = self.inner.lock().await;
        self.mark(&mut g);
        let e = needs_auth_error(self.kind);
        match detail {
            Some(d) => e.with_detail(d),
            None => e,
        }
    }

    #[cfg(test)]
    pub async fn needs_auth(&self) -> bool {
        self.inner.lock().await.needs_auth
    }

    fn mark(&self, g: &mut Inner) {
        g.access = None;
        if !g.needs_auth {
            g.needs_auth = true;
            (self.on_needs_auth)(&self.profile_id);
        }
    }

    async fn refresh(&self, g: &mut Inner) -> SResult<String> {
        let stored = match g.stored.clone() {
            Some(s) => s,
            None => match self.store.load().await? {
                Some(s) if !s.refresh_token.is_empty() => s,
                _ => {
                    self.mark(g);
                    return Err(needs_auth_error(self.kind));
                }
            },
        };
        g.stored = Some(stored.clone());
        let secret = stored.client_secret.clone().or_else(|| (self.builtin_secret)(self.kind, &stored.client_id));
        let mut pairs = vec![("grant_type", "refresh_token"), ("refresh_token", stored.refresh_token.as_str()), ("client_id", stored.client_id.as_str())];
        if let Some(s) = secret.as_deref() {
            pairs.push(("client_secret", s));
        }
        self.refreshes.fetch_add(1, Ordering::Relaxed);
        let res = self
            .http
            .post(&self.token_url)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(http::form(&pairs))
            .send()
            .await
            .map_err(|e| http::net_error(self.kind, &e))?;
        let status = res.status().as_u16();
        let body = res.bytes().await.map_err(|e| http::net_error(self.kind, &e))?;
        if status != 200 {
            let (code, _) = http::provider_error(&body);
            // invalid_grant: the refresh token is dead; invalid_client: the app it belongs to is
            // gone or its secret changed. Either way only signing in again helps.
            if matches!(status, 400 | 401) && (code == "invalid_grant" || code == "invalid_client" || code == "unauthorized_client") {
                self.mark(g);
                let (c, m) = http::provider_error(&body);
                return Err(needs_auth_error(self.kind).with_detail(format!("HTTP {status}: {c}: {m}")));
            }
            return Err(http::error_of(self.kind, status, &body));
        }
        let ans: TokenAnswer = serde_json::from_slice(&body).map_err(|e| http::unexpected(self.kind, e))?;
        let life = Duration::from_secs(ans.expires_in.unwrap_or(3600));
        g.access = Some((ans.access_token.clone(), Instant::now() + life, life));
        if let Some(new) = ans.refresh_token.filter(|r| !r.is_empty() && *r != stored.refresh_token) {
            let next = Stored { refresh_token: new, ..stored.clone() };
            g.stored = Some(next.clone());
            // a failed save keeps this session going on the new token; Microsoft still takes the
            // previous one for a while, so the next launch can refresh again
            let replaces = g.in_vault.take().unwrap_or_else(|| stored.clone());
            match self.store.save(&replaces, &next).await {
                Ok(()) => {}
                Err(e) => {
                    g.in_vault = Some(replaces);
                    eprintln!("kybl: couldn't save the renewed sign-in for a connection: {}", e.message);
                }
            }
        }
        Ok(ans.access_token)
    }
}

fn fresh(g: &Inner) -> Option<String> {
    let (t, exp, life) = g.access.as_ref()?;
    let margin = EARLY.min(*life / 2);
    (exp.checked_duration_since(Instant::now())? > margin).then(|| t.clone())
}

/// Whether `now` (what the store holds) is still the session `prev` this source used.
pub fn same_session(now: Option<&Stored>, prev: &Stored) -> bool {
    now.is_some_and(|n| n.refresh_token == prev.refresh_token && n.client_id == prev.client_id)
}

/// Parses what the vault holds.
pub fn parse_stored(raw: &str) -> Option<Stored> {
    let v: Value = serde_json::from_str(raw).ok()?;
    serde_json::from_value(v).ok()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::oauth::mock::{Mock, Resp};
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemStore(pub Mutex<Option<Stored>>, pub AtomicU32);

    #[async_trait::async_trait]
    impl TokenStore for MemStore {
        async fn load(&self) -> SResult<Option<Stored>> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn save(&self, prev: &Stored, s: &Stored) -> SResult<()> {
            self.1.fetch_add(1, Ordering::Relaxed);
            let mut g = self.0.lock().unwrap();
            if super::same_session(g.as_ref(), prev) {
                *g = Some(s.clone());
            }
            Ok(())
        }
    }

    fn no_secret(_: ConnKind, _: &str) -> Option<String> {
        None
    }

    /// A token source with an access token that lasts an hour, for backend tests.
    pub fn fixed(token: &str) -> Arc<TokenSource> {
        let ts = TokenSource::new("p", ConnKind::Gdrive, "http://127.0.0.1:1/token", no_secret, Arc::new(MemStore::default()), Box::new(|_| {}));
        let ts = Arc::new(ts);
        futures_util::FutureExt::now_or_never(ts.prime(token, Duration::from_secs(3600))).expect("uncontended");
        ts
    }

    fn source(url: &str, store: Arc<MemStore>, flagged: Arc<AtomicU32>) -> Arc<TokenSource> {
        Arc::new(TokenSource::new(
            "conn-1",
            ConnKind::Onedrive,
            format!("{url}/token"),
            no_secret,
            store,
            Box::new(move |id| {
                assert_eq!(id, "conn-1");
                flagged.fetch_add(1, Ordering::Relaxed);
            }),
        ))
    }

    fn stored(rt: &str) -> Arc<MemStore> {
        Arc::new(MemStore(Mutex::new(Some(Stored { refresh_token: rt.into(), client_id: "cid".into(), client_secret: None })), AtomicU32::new(0)))
    }

    #[tokio::test]
    async fn one_refresh_for_many_callers_and_rotation_is_saved() {
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let mock = Mock::start(move |req| {
            assert_eq!(req.path, "/token");
            let body = String::from_utf8_lossy(&req.body).to_string();
            assert!(body.contains("grant_type=refresh_token"), "{body}");
            assert!(body.contains("client_id=cid"), "{body}");
            assert!(!body.contains("client_secret"), "public clients send no secret");
            let i = n2.fetch_add(1, Ordering::SeqCst) + 1;
            std::thread::sleep(Duration::from_millis(80));
            Resp::json(200, &serde_json::json!({"access_token": format!("at-{i}"), "expires_in": 3600, "refresh_token": format!("rt-{i}")}))
        })
        .await;
        let store = stored("rt-0");
        let ts = source(&mock.base, store.clone(), Arc::new(AtomicU32::new(0)));
        let calls = (0..10).map(|_| {
            let ts = ts.clone();
            tokio::spawn(async move { ts.access_token().await.unwrap() })
        });
        let got: Vec<String> = futures_util::future::join_all(calls).await.into_iter().map(Result::unwrap).collect();
        assert!(got.iter().all(|t| t == "at-1"), "{got:?}");
        assert_eq!(n.load(Ordering::SeqCst), 1, "single flight");
        assert_eq!(store.0.lock().unwrap().as_ref().unwrap().refresh_token, "rt-1", "rotated token saved");

        // several 401s for the same stale token: one refresh
        let calls = (0..5).map(|_| {
            let ts = ts.clone();
            tokio::spawn(async move { ts.force_refresh("at-1").await.unwrap() })
        });
        let got: Vec<String> = futures_util::future::join_all(calls).await.into_iter().map(Result::unwrap).collect();
        assert!(got.iter().all(|t| t == "at-2"), "{got:?}");
        assert_eq!(n.load(Ordering::SeqCst), 2);
        assert_eq!(store.1.load(Ordering::SeqCst), 2);
    }

    /// A refresh still running when the connection is reconnected or deleted doesn't write its
    /// renewed token over the new sign-in, or back after the deletion (S3-2, B3-7).
    #[tokio::test]
    async fn a_renewed_token_never_replaces_a_newer_sign_in_or_comes_back() {
        let store = stored("rt-0");
        let during = store.clone();
        let step = Arc::new(AtomicU32::new(0));
        let step2 = step.clone();
        let mock = Mock::start(move |_| {
            let i = step2.fetch_add(1, Ordering::SeqCst) + 1;
            // while the answer is on its way: reconnected (1st), deleted (2nd)
            *during.0.lock().unwrap() = (i == 1).then(|| Stored { refresh_token: "rt-new".into(), client_id: "cid2".into(), client_secret: None });
            Resp::json(200, &serde_json::json!({"access_token": format!("at-{i}"), "expires_in": 3600, "refresh_token": format!("rt-{i}")}))
        })
        .await;
        let ts = source(&mock.base, store.clone(), Arc::new(AtomicU32::new(0)));
        assert_eq!(ts.access_token().await.unwrap(), "at-1");
        assert_eq!(store.0.lock().unwrap().as_ref().unwrap().refresh_token, "rt-new", "the newer sign-in stays");
        assert_eq!(ts.force_refresh("at-1").await.unwrap(), "at-2");
        assert!(store.0.lock().unwrap().is_none(), "nothing written back after the deletion");
    }

    #[tokio::test]
    async fn short_lived_tokens_refresh_early() {
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let mock = Mock::start(move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
            // 100 s left is under the two-minute margin: refreshed again at half its life
            Resp::json(200, &serde_json::json!({"access_token": "short", "expires_in": 100}))
        })
        .await;
        let ts = source(&mock.base, stored("rt"), Arc::new(AtomicU32::new(0)));
        ts.access_token().await.unwrap();
        ts.access_token().await.unwrap();
        assert_eq!(n.load(Ordering::SeqCst), 1, "still more than half its life left");
    }

    #[tokio::test]
    async fn a_revoked_sign_in_needs_reconnect_once() {
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let mock = Mock::start(move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
            Resp::json(400, &serde_json::json!({"error": "invalid_grant", "error_description": "AADSTS70000: expired"}))
        })
        .await;
        let flagged = Arc::new(AtomicU32::new(0));
        let ts = source(&mock.base, stored("rt"), flagged.clone());
        let e = ts.access_token().await.unwrap_err();
        assert_eq!(e.kind, ErrKind::NeedsAuth);
        assert!(e.message.contains("Reconnect"));
        assert!(e.detail.unwrap().contains("invalid_grant"));
        assert_eq!(ts.access_token().await.unwrap_err().kind, ErrKind::NeedsAuth);
        assert_eq!(n.load(Ordering::SeqCst), 1, "no more refreshes once it's dead");
        assert_eq!(flagged.load(Ordering::SeqCst), 1, "the UI hears it once");

        // nothing in the vault at all: also Reconnect
        let empty = Arc::new(MemStore::default());
        let ts = source(&mock.base, empty, Arc::new(AtomicU32::new(0)));
        assert_eq!(ts.access_token().await.unwrap_err().kind, ErrKind::NeedsAuth);
    }

    #[tokio::test]
    async fn a_server_hiccup_is_not_a_lost_sign_in() {
        let mock = Mock::start(|_| Resp::json(503, &serde_json::json!({"error": "temporarily_unavailable"}))).await;
        let flagged = Arc::new(AtomicU32::new(0));
        let ts = source(&mock.base, stored("rt"), flagged.clone());
        let e = ts.access_token().await.unwrap_err();
        assert_ne!(e.kind, ErrKind::NeedsAuth);
        assert_eq!(flagged.load(Ordering::SeqCst), 0);
        assert!(!ts.needs_auth().await);
    }

    #[test]
    fn vault_json_round_trips() {
        let s = Stored { refresh_token: "r".into(), client_id: "c".into(), client_secret: Some("s".into()) };
        let raw = serde_json::to_string(&s).unwrap();
        assert_eq!(raw, r#"{"refreshToken":"r","clientId":"c","clientSecret":"s"}"#);
        assert_eq!(parse_stored(&raw), Some(s));
        assert_eq!(parse_stored("not json"), None);
    }
}
