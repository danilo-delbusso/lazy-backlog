/**
 * Shared Jira authentication and URL validation helpers.
 * Extracted to avoid circular imports between jira.ts and jira-schema.ts.
 */

export const PRIVATE_HOST_RE =
  /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?:[:/]|$)/i;

export function validateSiteUrl(url: string): void {
  if (!url.startsWith("https://")) throw new Error(`siteUrl must start with https:// — got "${url}"`);
  if (PRIVATE_HOST_RE.test(url)) throw new Error(`siteUrl must not point to a private/internal address — got "${url}"`);
}

export function authHeaders(email: string, apiToken: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
