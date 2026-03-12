/**
 * Shared Jira authentication and URL validation helpers.
 * Extracted to avoid circular imports between jira.ts and jira-schema.ts.
 */

/** Check whether a hostname (from `new URL().hostname`) is private/internal. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Loopback
  if (h === "localhost" || h === "::1") return true;

  // IPv6 loopback bracket-stripped by URL parser
  if (h === "[::1]") return true;

  // Dotted-quad IPv4 checks
  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number) as [number, number, number, number];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true; // 0.0.0.0/8
  }

  return false;
}

export const PRIVATE_HOST_RE = {
  test: (url: string) => {
    try {
      return isPrivateHost(new URL(url).hostname);
    } catch {
      return true; // malformed URLs are rejected
    }
  },
};

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
