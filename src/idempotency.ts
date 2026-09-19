import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, recursively.
 *
 * A retry is supposed to carry the same body, but "same body" and "same bytes" are not
 * the same thing -- a client may serialise its fields in a different order on the retry,
 * and plain JSON.stringify would then produce a different string and a different hash.
 * We would reject a genuine retry as a key reuse.
 *
 * Sorting the keys makes the hash depend on the request's MEANING rather than on the
 * order the client happened to write the fields in.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Fingerprint of a request body, stored alongside the idempotency key.
 *
 * Global uniqueness of a key is a promise the CLIENT makes, and clients have bugs. The
 * same key can arrive carrying a different body -- the user edits the form and resubmits,
 * retry logic reuses a key object, or someone does it deliberately. Without this
 * fingerprint the server would return the stored response for the OLD body, showing the
 * user a confirmation for something they did not ask for.
 */
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}
