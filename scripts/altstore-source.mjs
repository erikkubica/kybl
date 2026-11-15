#!/usr/bin/env node
// Writes the AltStore / SideStore source for the iOS app: a JSON file people add once in
// AltStore or SideStore, which then offers every new release as an update.
//
//   node scripts/altstore-source.mjs <Kybl.ipa> <owner/repo> <out.json>
//
// The release workflow attaches the result to each release as `altstore-source.json`, so
// https://github.com/<owner/repo>/releases/latest/download/altstore-source.json always points
// at the newest published release.
import { readFileSync, statSync, writeFileSync } from "node:fs";

const [ipa, repo, out] = process.argv.slice(2);
if (!ipa || !repo || !out) {
  console.error("usage: altstore-source.mjs <Kybl.ipa> <owner/repo> <out.json>");
  process.exit(1);
}

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const ios = JSON.parse(readFileSync(new URL("../src-tauri/tauri.ios.conf.json", import.meta.url)));
const version = conf.version;
const raw = `https://raw.githubusercontent.com/${repo}/main`;
const icon = `${raw}/website/assets/icon-512.png`;

const source = {
  name: "Kybl",
  identifier: "app.kybl.source",
  subtitle: "S3 storage browser",
  description: "Kybl, the S3 storage browser, built from the open source repository.",
  iconURL: icon,
  website: "https://kybl.app",
  tintColor: "#D9381F",
  apps: [
    {
      name: "Kybl",
      bundleIdentifier: ios.identifier,
      developerName: "Kybl",
      subtitle: "Browse your S3 storage",
      localizedDescription:
        "Browse, upload and download files on any S3-compatible storage: AWS, Cloudflare R2, " +
        "Backblaze B2, MinIO, Wasabi or Kybl Storage. Secret keys stay in the iOS Keychain.",
      iconURL: icon,
      tintColor: "#D9381F",
      category: "utilities",
      screenshots: [],
      versions: [
        {
          version,
          buildVersion: version,
          date: new Date().toISOString().slice(0, 10),
          localizedDescription: `Kybl ${version}. See the release notes on GitHub.`,
          downloadURL: `https://github.com/${repo}/releases/download/v${version}/Kybl.ipa`,
          size: statSync(ipa).size,
          minOSVersion: "15.0",
        },
      ],
      appPermissions: { entitlements: [], privacy: {} },
    },
  ],
  news: [],
};

writeFileSync(out, JSON.stringify(source, null, 2) + "\n");
console.log(`wrote ${out} for Kybl ${version}`);
