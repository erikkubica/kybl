/**
 * The FTP / SFTP "Server" field takes a name or address. People paste more than that
 * (`sftp://me@nas.lan:2222/srv`, `nas.lan:2222`, `me@nas.lan`): this splits it into the parts
 * the form has fields for. Pure, so tests can load it.
 */
export type ServerParts = { host: string; port?: number; user?: string };

const BAD_HOST = "Enter only the server's name or address, such as server.example.com.";

/** The parts of a typed or pasted server, or what is wrong with it. */
export function splitServer(text: string): ServerParts | string {
  let t = text.trim();
  if (!t) return "Enter the server's name or address.";
  // a URL: drop the scheme and any path
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = t.indexOf("/");
  if (slash >= 0) t = t.slice(0, slash);
  let user: string | undefined;
  const at = t.lastIndexOf("@");
  if (at >= 0) {
    // user:password@host: the password is not kept here
    user = t.slice(0, at).split(":")[0] || undefined;
    t = t.slice(at + 1);
  }
  let host = t;
  let portText: string | undefined;
  const bracket = /^\[([^\]]+)\](?::(.*))?$/.exec(t);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2];
  } else if (t.split(":").length === 2) {
    // one colon is host:port; more is a bare IPv6 address
    [host, portText] = t.split(":");
  }
  if (!host || /\s/.test(host)) return BAD_HOST;
  if (portText !== undefined && portText !== "") {
    const n = Number(portText);
    if (!/^\d+$/.test(portText) || n < 1 || n > 65535) return "Ports are numbers from 1 to 65535.";
    return { host, port: n, ...(user ? { user } : {}) };
  }
  return { host, ...(user ? { user } : {}) };
}

/** A WebDAV address with its user name and password taken out (`https://me:pw@host/dav/` → `https://host/dav/`). */
export type DavAddress = { href: string; user?: string; password?: string; error?: string };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Splits a pasted WebDAV address: Nextcloud and hosting panels hand out `https://user:app-password@host/…`.
 * The address must not keep the password (it would be saved in clear and shown in lists), so the
 * parts go to the fields that are kept safely. Nothing to split: the address as it is.
 * `typedUser` is the User name field: an address for another user is an error and gives nothing
 * to the vault, as the app's own split does. `error` also says when the address can't be read.
 */
export function splitDavUrl(text: string, typedUser = ""): DavAddress {
  const href = text.trim();
  // the authority ends at / ? # and, as in a browser's parser, at a backslash
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\\]*)(.*)$/is.exec(href);
  if (!m) return { href };
  const at = m[2].lastIndexOf("@");
  if (at < 0) {
    // "alice:my#pass@host": the password's own # or / cut the address short, so the host is not what it looks like
    if (m[3].includes("@") && /:(?!\d*$)/.test(m[2].replace(/^\[[^\]]*\]/, ""))) {
      return { href, error: "Put the password in the Password field, or write its # / ? as %23 %2F %3F in the address." };
    }
    return { href };
  }
  const info = m[2].slice(0, at);
  const colon = info.indexOf(":");
  const user = decode(colon < 0 ? info : info.slice(0, colon));
  const password = colon < 0 ? "" : decode(info.slice(colon + 1));
  const clean = m[1] + m[2].slice(at + 1) + m[3];
  const typed = typedUser.trim();
  if (typed && user && typed !== user) {
    return { href: clean, error: "The address has another user name than User name. Remove it from the address." };
  }
  return { href: clean, user: user || undefined, password: password || undefined };
}
