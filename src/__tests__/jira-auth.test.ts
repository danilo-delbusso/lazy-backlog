import { describe, expect, it } from "vitest";
import { authHeaders, PRIVATE_HOST_RE, validateSiteUrl } from "../lib/jira-auth.js";

describe("validateSiteUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    expect(() => validateSiteUrl("https://mycompany.atlassian.net")).not.toThrow();
    expect(() => validateSiteUrl("https://example.com")).not.toThrow();
    expect(() => validateSiteUrl("https://jira.corp.io/path")).not.toThrow();
  });

  it("rejects non-HTTPS URLs", () => {
    expect(() => validateSiteUrl("http://mycompany.atlassian.net")).toThrow("must start with https://");
    expect(() => validateSiteUrl("ftp://example.com")).toThrow("must start with https://");
    expect(() => validateSiteUrl("file:///etc/passwd")).toThrow("must start with https://");
  });

  it("rejects malformed URLs", () => {
    expect(() => validateSiteUrl("https://")).toThrow();
    expect(() => validateSiteUrl("not-a-url")).toThrow();
  });
});

describe("PRIVATE_HOST_RE", () => {
  describe("loopback addresses", () => {
    it("blocks localhost", () => {
      expect(PRIVATE_HOST_RE.test("https://localhost")).toBe(true);
      expect(PRIVATE_HOST_RE.test("https://localhost:8080")).toBe(true);
    });

    it("blocks 127.0.0.1", () => {
      expect(PRIVATE_HOST_RE.test("https://127.0.0.1")).toBe(true);
      expect(PRIVATE_HOST_RE.test("https://127.0.0.1:443")).toBe(true);
    });

    it("blocks IPv6 loopback ::1", () => {
      expect(PRIVATE_HOST_RE.test("https://[::1]")).toBe(true);
      expect(PRIVATE_HOST_RE.test("https://[::1]:8443")).toBe(true);
    });
  });

  describe("private IP ranges", () => {
    it("blocks 10.x.x.x (10.0.0.0/8)", () => {
      expect(PRIVATE_HOST_RE.test("https://10.0.0.1")).toBe(true);
      expect(PRIVATE_HOST_RE.test("https://10.255.255.255")).toBe(true);
    });

    it("blocks 172.16-31.x.x (172.16.0.0/12)", () => {
      expect(PRIVATE_HOST_RE.test("https://172.16.0.1")).toBe(true);
      expect(PRIVATE_HOST_RE.test("https://172.31.255.255")).toBe(true);
    });

    it("allows 172 addresses outside the private range", () => {
      expect(PRIVATE_HOST_RE.test("https://172.15.0.1")).toBe(false);
      expect(PRIVATE_HOST_RE.test("https://172.32.0.1")).toBe(false);
    });

    it("blocks 192.168.x.x (192.168.0.0/16)", () => {
      expect(PRIVATE_HOST_RE.test("https://192.168.0.1")).toBe(true);
      expect(PRIVATE_HOST_RE.test("https://192.168.255.255")).toBe(true);
    });
  });

  describe("link-local and cloud metadata", () => {
    it("blocks 169.254.169.254 (cloud metadata endpoint)", () => {
      expect(PRIVATE_HOST_RE.test("https://169.254.169.254")).toBe(true);
    });

    it("blocks other 169.254.x.x link-local addresses", () => {
      expect(PRIVATE_HOST_RE.test("https://169.254.0.1")).toBe(true);
    });
  });

  describe("zero address", () => {
    it("blocks 0.0.0.0", () => {
      expect(PRIVATE_HOST_RE.test("https://0.0.0.0")).toBe(true);
    });
  });

  describe("userinfo bypass attempts", () => {
    it("blocks https://foo@127.0.0.1", () => {
      expect(PRIVATE_HOST_RE.test("https://foo@127.0.0.1")).toBe(true);
    });

    it("blocks https://user:pass@10.0.0.1", () => {
      expect(PRIVATE_HOST_RE.test("https://user:pass@10.0.0.1")).toBe(true);
    });

    it("blocks https://anything@localhost", () => {
      expect(PRIVATE_HOST_RE.test("https://anything@localhost")).toBe(true);
    });
  });

  describe("public IPs pass", () => {
    it("allows public IP addresses", () => {
      expect(PRIVATE_HOST_RE.test("https://8.8.8.8")).toBe(false);
      expect(PRIVATE_HOST_RE.test("https://1.1.1.1")).toBe(false);
      expect(PRIVATE_HOST_RE.test("https://203.0.113.1")).toBe(false);
    });

    it("allows public domain names", () => {
      expect(PRIVATE_HOST_RE.test("https://mycompany.atlassian.net")).toBe(false);
      expect(PRIVATE_HOST_RE.test("https://example.com")).toBe(false);
    });
  });

  describe("malformed URLs", () => {
    it("rejects malformed URLs as private (safe default)", () => {
      expect(PRIVATE_HOST_RE.test("not-a-url")).toBe(true);
      expect(PRIVATE_HOST_RE.test("://missing-scheme")).toBe(true);
      expect(PRIVATE_HOST_RE.test("")).toBe(true);
    });
  });
});

describe("authHeaders", () => {
  it("returns correct Basic auth format", () => {
    const headers = authHeaders("user@example.com", "my-api-token");
    const expected = Buffer.from("user@example.com:my-api-token").toString("base64");

    expect(headers.Authorization).toBe(`Basic ${expected}`);
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("encodes special characters correctly", () => {
    const headers = authHeaders("user+tag@example.com", "tok/with=special+chars");
    const expected = Buffer.from("user+tag@example.com:tok/with=special+chars").toString("base64");

    expect(headers.Authorization).toBe(`Basic ${expected}`);
  });
});
