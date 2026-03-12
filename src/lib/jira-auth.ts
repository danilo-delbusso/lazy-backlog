/**
 * Shared Jira authentication and URL validation helpers.
 * Extracted to avoid circular imports between jira.ts and jira-schema.ts.
 */

/** Check whether a dotted-quad IPv4 address is in a private/reserved range. */
function isPrivateIPv4(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true; // loopback, class A private, zero
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  return false;
}

/** Check whether a hostname (from `new URL().hostname`) is private/internal. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  if (h === "localhost" || h === "::1" || h === "[::1]") return true;

  const parts = h.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number) as [number, number, number, number];
    return isPrivateIPv4(a, b);
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
  const credentials = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
