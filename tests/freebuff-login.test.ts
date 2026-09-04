import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFreebuffLogin } from "../src/freebuff-login";

test("built-in Freebuff login uses the official device flow and writes compatible credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-login-"));
  const credentialsPath = join(root, "manicode", "credentials.json");
  mkdirSync(join(root, "manicode"), { recursive: true });
  writeFileSync(credentialsPath, JSON.stringify({ otherProfile: { keep: true } }), { mode: 0o600 });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    Response.json({
      loginUrl: "https://freebuff.test/login?code=abc",
      fingerprintHash: "server-fingerprint-hash",
      expiresAt: 4_070_908_800_000,
    }),
    Response.json({
      user: {
        id: "user-1",
        name: "Test user",
        email: "test@example.com",
        authToken: "official-session-token",
      },
    }),
  ];
  let openedUrl: string | undefined;
  try {
    const result = await runFreebuffLogin({
      baseUrl: "https://freebuff.test/",
      credentialsPath,
      fingerprintId: "enhanced-test-fingerprint",
      autoOpen: true,
      openUrl: url => { openedUrl = url; },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected extra request");
        return response;
      },
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      credentialsPath,
      loginUrl: "https://freebuff.test/login?code=abc",
      fingerprintId: "enhanced-test-fingerprint",
      attempts: 1,
      browserOpened: true,
      user: { name: "Test user", email: "test@example.com" },
    });
    expect(openedUrl).toBe("https://freebuff.test/login?code=abc");
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://freebuff.test/api/auth/cli/code");
    expect(requests[0].init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ fingerprintId: "enhanced-test-fingerprint" });

    const statusUrl = new URL(requests[1].url);
    expect(statusUrl.pathname).toBe("/api/auth/cli/status");
    expect(Object.fromEntries(statusUrl.searchParams)).toEqual({
      fingerprintId: "enhanced-test-fingerprint",
      fingerprintHash: "server-fingerprint-hash",
      expiresAt: "4070908800000",
    });

    expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject({
      otherProfile: { keep: true },
      default: {
        id: "user-1",
        name: "Test user",
        email: "test@example.com",
        authToken: "official-session-token",
        fingerprintId: "enhanced-test-fingerprint",
        fingerprintHash: "server-fingerprint-hash",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
