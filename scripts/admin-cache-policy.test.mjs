import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIRECTORY = path.join(REPOSITORY_ROOT, "apps/admin");
const html = fs.readFileSync(path.join(ADMIN_DIRECTORY, "index.html"), "utf8");

test("Cloudflare Pages always revalidates the atomic Admin document", () => {
  const headers = fs.readFileSync(path.join(ADMIN_DIRECTORY, "_headers"), "utf8");
  assert.match(headers, /^\/\*\s*\r?\n\s+Cache-Control:\s*no-cache,\s*max-age=0,\s*must-revalidate/im);
});

test("local nginx always revalidates the Admin and emits an ETag", () => {
  const nginx = fs.readFileSync(path.join(REPOSITORY_ROOT, "docker/admin/nginx.conf"), "utf8");
  assert.match(nginx, /etag\s+on;/);
  assert.match(nginx, /add_header\s+Cache-Control\s+"no-cache, max-age=0, must-revalidate"\s+always;/);
});

test("separate local assets cannot be introduced without a content fingerprint", () => {
  const assetTags = html.match(/<(?:script|link|img|source)\b[^>]*>/gi) || [];
  const localAssetReferences = [];

  for (const tag of assetTags) {
    const reference = tag.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!reference || /^(?:https?:|data:|#|\/\/)/i.test(reference)) {
      continue;
    }
    if (/\.(?:avif|css|gif|ico|jpe?g|js|json|mjs|png|svg|webmanifest|webp)(?:[?#]|$)/i.test(reference)) {
      localAssetReferences.push(reference);
    }
  }

  for (const reference of localAssetReferences) {
    assert.match(reference, /[?&]v=[a-f0-9]{10}(?:[&#]|$)/i, `${reference} needs a content hash`);
  }

  const documentHash = crypto.createHash("sha256").update(html).digest("hex");
  assert.match(documentHash, /^[a-f0-9]{64}$/);
});
