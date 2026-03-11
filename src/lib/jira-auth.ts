/**
 * Shared Jira authentication and URL validation helpers.
 * Extracted to avoid circular imports between jira.ts and jira-schema.ts.
 */

const LOOPBACK_RE = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+)(?:[:/]|$)/i;
const CLASS_A_RE = /^https?:\/\/10\.\d+\.\d+\.\d+(?:[:/]|$)/i;
const CLASS_B_RE = /^https?:\/\/172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+(?:[:/]|$)/i;
const CLASS_C_RE = /^https?:\/\/192\.168\.\d+\.\d+(?:[:/]|$)/i;
export const PRIVATE_HOST_RE = {
  test: (url: string) => LOOPBACK_RE.test(url) || CLASS_A_RE.test(url) || CLASS_B_RE.test(url) || CLASS_C_RE.test(url),
};

export function validateSiteUrl(url: string): void {
  if (!url.startsWith("https://")) throw new Error(`siteUrl must start with https:// — got "${url}"`);
  if (PRIVATE_HOST_RE.test(url)) throw new Error(`siteUrl must not point to a private/internal address — got "${url}"`);
}

export function authHeaders(email: string, apiToken: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(email + ":" + apiToken).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
