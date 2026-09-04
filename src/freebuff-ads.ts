const FREEBUFF_ADS_PATH = "/api/v1/ads";
const FREEBUFF_IMPRESSION_PATH = "/api/v1/ads/impression";
const FREEBUFF_AD_TIMEOUT_MS = 3_000;
const FREEBUFF_AD_MESSAGE_LIMIT = 10_000;

/** Hidden transport marker used to keep displayed ads out of the next model prompt. */
export const FREEBUFF_AD_MARKER = "<!-- codex-freebuff-ad -->";

export interface FreebuffAd {
  title: string;
  adText: string;
  cta: string;
  url: string;
  clickUrl: string;
  impUrl?: string;
  placementId?: string;
  provider?: string;
}

export type FreebuffFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Official Freebuff copy used when the ad service returns no fill or is unreachable. */
export const FREEBUFF_HOUSE_AD: FreebuffAd = {
  title: "Free coding models",
  adText: "Freebuff is $0. Forever. Powerful coding models, funded by ads.",
  cta: "Explore Freebuff",
  url: "https://freebuff.com",
  clickUrl: "https://freebuff.com",
  provider: "first_party",
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, limit = 240): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").slice(0, limit)
    : "";
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && url.protocol !== "http:") || /[\s<>]/.test(url.href)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function parseAd(value: unknown): FreebuffAd | null {
  const raw = object(value);
  if (!raw) return null;
  const clickUrl = httpUrl(raw.clickUrl) ?? httpUrl(raw.url);
  const url = httpUrl(raw.url) ?? clickUrl;
  const title = text(raw.title);
  const adText = text(raw.adText, 500);
  if (!clickUrl || !url || !title || !adText) return null;
  return {
    title,
    adText,
    cta: text(raw.cta, 80) || "Learn more",
    url,
    clickUrl,
    ...(text(raw.impUrl, 2_000) ? { impUrl: text(raw.impUrl, 2_000) } : {}),
    ...(text(raw.placementId, 120) ? { placementId: text(raw.placementId, 120) } : {}),
    ...(text(raw.provider, 80) ? { provider: text(raw.provider, 80) } : {}),
  };
}

function adUserAgent(): string {
  const chrome = "151.0.0.0";
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function adOs(): "macos" | "windows" | "linux" {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_\[\]<>]/g, "\\$&");
}

export function isFreebuffAdText(value: string): boolean {
  return value.startsWith(FREEBUFF_AD_MARKER);
}

/** Render an ad as a separate, visibly disclosed Codex output block. */
export function renderFreebuffAd(ad: FreebuffAd): string {
  return `${FREEBUFF_AD_MARKER}\n\n---\n**Ad · Freebuff** — **${markdownText(ad.title)}**: ${markdownText(ad.adText)} [${markdownText(ad.cta)}](<${ad.clickUrl}>)\n`;
}

export interface FetchFreebuffAdOptions {
  baseUrl: string;
  authToken: string;
  userMessage: string;
  sessionId: string;
  signal?: AbortSignal;
  fetchImpl?: FreebuffFetch;
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "") || "https://www.codebuff.com";
}

export async function fetchFreebuffAd(options: FetchFreebuffAdOptions): Promise<FreebuffAd | null> {
  const token = options.authToken.trim();
  if (!token || options.signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal) options.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), FREEBUFF_AD_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${cleanBaseUrl(options.baseUrl)}${FREEBUFF_ADS_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": adUserAgent(),
      },
      body: JSON.stringify({
        provider: "gravity",
        messages: [{
          role: "user",
          // Only the current user request is sent for ad decisioning; system prompts,
          // repository history, tool results and the assistant answer stay local.
          content: (options.userMessage.trim() || "coding task").slice(0, FREEBUFF_AD_MESSAGE_LIMIT),
        }],
        sessionId: (options.sessionId.trim() || "codex-freebuff-web").slice(0, 100),
        device: {
          os: adOs(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
        },
        surface: "cli_chat",
        placementId: "CLI-Chat-Inline",
        userAgent: adUserAgent(),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => undefined);
    const ads = object(body)?.ads;
    return Array.isArray(ads) ? parseAd(ads[0]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function recordFreebuffAdImpression(options: {
  baseUrl: string;
  authToken: string;
  ad: FreebuffAd;
  fetchImpl?: FreebuffFetch;
}): Promise<void> {
  if (!options.authToken.trim() || !options.ad.impUrl) return;
  try {
    await (options.fetchImpl ?? fetch)(`${cleanBaseUrl(options.baseUrl)}${FREEBUFF_IMPRESSION_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${options.authToken.trim()}`,
        "user-agent": adUserAgent(),
      },
      body: JSON.stringify({
        impUrl: options.ad.impUrl,
        mode: "LITE",
        userAgent: adUserAgent(),
        os: adOs(),
      }),
      signal: AbortSignal.timeout(FREEBUFF_AD_TIMEOUT_MS),
    });
  } catch {
    // Ad measurement must never turn a successful coding turn into an error.
  }
}
