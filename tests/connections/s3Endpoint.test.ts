// S3 form: the endpoint follows the region only while it is the preset's own. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointAfterRegion, fieldsAfterProvider } from "../../src/connections/s3Endpoint.ts";

const aws = (r: string) => `https://s3.${r}.amazonaws.com`;
const custom = () => "";
const r2 = () => "https://<account-id>.r2.cloudflarestorage.com";

test("derived endpoint follows the region", () => {
  assert.equal(endpointAfterRegion(aws, "eu-central-1", "us-east-1", aws("eu-central-1")), aws("us-east-1"));
  assert.equal(endpointAfterRegion(aws, "eu-central-1", "us-east-1", ""), aws("us-east-1"));
});

test("hand-typed endpoint is kept", () => {
  assert.equal(endpointAfterRegion(custom, "us-east-1", "us-east-", "http://localhost:9000"), "http://localhost:9000");
  assert.equal(endpointAfterRegion(r2, "auto", "aut", "https://abc.r2.cloudflarestorage.com"), "https://abc.r2.cloudflarestorage.com");
  assert.equal(endpointAfterRegion(aws, "eu-central-1", "us-east-1", "https://vpce-1.s3.amazonaws.com"), "https://vpce-1.s3.amazonaws.com");
});

test("placeholder and empty custom stay as they are", () => {
  assert.equal(endpointAfterRegion(r2, "auto", "x", r2()), r2());
  assert.equal(endpointAfterRegion(custom, "a", "b", ""), "");
});

const hetzner = { endpoint: (r: string) => `https://${r}.your-objectstorage.com`, defaultRegion: "nbg1", pathStyle: false, regions: [{ value: "nbg1" }, { value: "fsn1" }] };
const awsP = { endpoint: aws, defaultRegion: "eu-central-1", pathStyle: false };
const other = { endpoint: custom, defaultRegion: "us-east-1", pathStyle: true };

test("same preset changes nothing", () => {
  const cur = { region: "fsn1", endpoint: hetzner.endpoint("fsn1"), pathStyle: false };
  assert.deepEqual(fieldsAfterProvider(hetzner, hetzner, cur), cur);
});

test("preset-filled values follow the new preset", () => {
  const cur = { region: "fsn1", endpoint: hetzner.endpoint("fsn1"), pathStyle: false };
  assert.deepEqual(fieldsAfterProvider(hetzner, awsP, cur), { region: "eu-central-1", endpoint: aws("eu-central-1"), pathStyle: false });
  assert.deepEqual(fieldsAfterProvider(awsP, other, { region: "eu-central-1", endpoint: aws("eu-central-1"), pathStyle: false }), { region: "us-east-1", endpoint: "", pathStyle: true });
});

test("typed values are kept", () => {
  const cur = { region: "us-east-1", endpoint: "https://minio.lan:9000", pathStyle: false };
  assert.deepEqual(fieldsAfterProvider(other, awsP, cur), { region: "eu-central-1", endpoint: "https://minio.lan:9000", pathStyle: false });
  // a typed region the new preset's list lacks falls back to its default
  assert.equal(fieldsAfterProvider(awsP, hetzner, { region: "us-west-2", endpoint: "", pathStyle: false }).region, "nbg1");
  assert.equal(fieldsAfterProvider(awsP, other, { region: "us-west-2", endpoint: "", pathStyle: false }).region, "us-west-2");
});

test("a region typed for one provider doesn't carry over to another", () => {
  const b2 = { endpoint: (r: string) => `https://s3.${r}.backblazeb2.com`, defaultRegion: "eu-central-003", pathStyle: false };
  const r2P = { endpoint: r2, defaultRegion: "auto", pathStyle: false };
  assert.deepEqual(fieldsAfterProvider(awsP, b2, { region: "eu-west-2", endpoint: aws("eu-west-2"), pathStyle: false }), {
    region: "eu-central-003",
    endpoint: b2.endpoint("eu-central-003"),
    pathStyle: false,
  });
  assert.equal(fieldsAfterProvider(awsP, r2P, { region: "eu-west-2", endpoint: aws("eu-west-2"), pathStyle: false }).region, "auto");
  // a generic server's typed region may well be meant for the provider picked next
  assert.equal(fieldsAfterProvider(other, b2, { region: "us-west-004", endpoint: "", pathStyle: true }).region, "us-west-004");
});
