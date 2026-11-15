/** "Connect Kybl Storage": the app signs in through the browser and gets its own access key. */
import { invoke } from "@tauri-apps/api/core";
import type { Profile } from "./types";

export const KYBL = "kybl";

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
/** Phones and tablets: the browser comes back to the app by itself (kybl://connect). */
export const ON_PHONE = /Android|iPhone|iPad|iPod/i.test(UA);
/** How the dialogs refer to the device that gets the key. */
export const THIS_DEVICE = ON_PHONE ? "this device" : "this computer";

export type DeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  /** QR code of `verificationUriComplete` as an SVG document */
  qrSvg: string;
};

const URL_KEY = "kybl.appUrl";

/** The account site set in Advanced, or null for the built-in default. */
export function savedAppUrl(): string | null {
  try {
    return localStorage.getItem(URL_KEY) || null;
  } catch {
    return null;
  }
}
export function saveAppUrl(url: string | null) {
  try {
    if (url) localStorage.setItem(URL_KEY, url);
    else localStorage.removeItem(URL_KEY);
  } catch {
    /* storage off: the default is used */
  }
}

export const kyblApi = {
  defaultAppUrl: () => invoke<string>("kybl_default_app_url"),
  connectBrowser: (flowId: string, replaceId?: string) =>
    invoke<Profile>("kybl_connect_browser", { flowId, appUrl: savedAppUrl(), replaceId: replaceId ?? null }),
  deviceStart: () => invoke<DeviceStart>("kybl_device_start", { appUrl: savedAppUrl() }),
  deviceWait: (flowId: string, d: DeviceStart, replaceId?: string) =>
    invoke<Profile>("kybl_device_wait", {
      flowId,
      appUrl: savedAppUrl(),
      deviceCode: d.deviceCode,
      interval: d.interval,
      expiresIn: d.expiresIn,
      replaceId: replaceId ?? null,
    }),
  cancel: (flowId: string) => invoke<void>("kybl_connect_cancel", { flowId }),
};

/** The storage no longer knows this key: revoked on the web, or the account was deleted. */
export function isRevokedKey(msg: string | null | undefined): boolean {
  return !!msg && /InvalidAccessKeyId/.test(msg);
}

/** What to say when a Kybl Storage key stopped working (the backend's text talks about editing keys). */
export const REVOKED_SAY = `${ON_PHONE ? "This device" : "This computer"}'s access key was revoked on the web, or the account was deleted. Connect again to get a new key.`;

/** Replaces the plain sentence of a storage error, keeping the technical details. */
export function kyblError(msg: string): string {
  const i = msg.indexOf("\n\n");
  return `${REVOKED_SAY}${i < 0 ? "" : msg.slice(i)}`;
}
