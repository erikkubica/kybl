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
