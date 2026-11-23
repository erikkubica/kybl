// S3 form: the endpoint follows the region only while it is the preset's own. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointAfterRegion } from "../../src/connections/s3Endpoint.ts";

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
