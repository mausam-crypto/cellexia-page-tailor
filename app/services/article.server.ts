import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { load } from "cheerio";

export interface ExtractedArticle {
  title: string;
  text: string;
}

const MAX_ARTICLE_CHARS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;
// Articles are text pages; anything bigger than this is not one. Bounding
// the download protects the server from accidental huge responses.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

// Private/reserved ranges the fetcher must never reach. URLs come from
// trusted admin users, so this guards against mistakes and pasted junk more
// than determined attackers (DNS-rebinding between lookup and connect is
// accepted residual risk at this trust level).
function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    return (
      v6 === "::1" ||
      v6 === "::" ||
      v6.startsWith("fc") ||
      v6.startsWith("fd") ||
      v6.startsWith("fe8") ||
      v6.startsWith("fe9") ||
      v6.startsWith("fea") ||
      v6.startsWith("feb") ||
      v6.startsWith("::ffff:")
    );
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function assertPublicHost(parsed: URL): Promise<void> {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) article URLs are supported.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Article URL must be a public address.");
  }
  const literal = isIP(host);
  if (literal) {
    if (isPrivateIp(host)) {
      throw new Error("Article URL must be a public address.");
    }
    return;
  }
  let resolved: { address: string };
  try {
    resolved = await lookup(host);
  } catch {
    throw new Error(`Could not resolve article host: ${host}`);
  }
  if (isPrivateIp(resolved.address)) {
    throw new Error("Article URL must be a public address.");
  }
}

/**
 * Fetch a marketing article and extract its readable text for analysis.
 * Redirects are followed manually so every hop is validated against the
 * private-address guard. Anything unexpected throws with a message the
 * admin UI surfaces on the article row.
 */
export async function fetchArticle(url: string): Promise<ExtractedArticle> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHost(current);
      response = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; PageTailor/1.0; +https://shopify.dev/apps)",
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Redirect without location (HTTP ${response.status})`);
        }
        current = new URL(location, current);
        response = null;
        continue;
      }
      break;
    }
    if (!response) {
      throw new Error("Too many redirects while fetching the article.");
    }
    if (!response.ok) {
      throw new Error(`Article fetch failed with HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) {
      throw new Error(`Article URL returned non-HTML content (${contentType})`);
    }
    html = await readBodyCapped(response, contentType);
  } finally {
    clearTimeout(timer);
  }

  return extractArticle(html);
}

/**
 * Read at most MAX_BODY_BYTES of the response and decode with the declared
 * charset (header first, then a <meta charset> sniff), falling back to
 * UTF-8. Legacy-charset article pages (ISO-8859-1, windows-1252) would
 * otherwise come through with corrupted accented characters.
 */
async function readBodyCapped(
  response: Response,
  contentType: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    // Sniff the head of the document; charset declarations must appear early.
    const head = new TextDecoder("latin1").decode(buffer.slice(0, 2048));
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(buffer);
  } catch {
    // Unknown label: fall back to UTF-8 rather than failing the fetch.
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

export function extractArticle(html: string): ExtractedArticle {
  const $ = load(html);
  $("script, style, noscript, iframe, svg, nav, header, footer, form").remove();

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "";

  // Prefer semantic main-content containers; fall back to body.
  const candidates = ["article", "main", '[role="main"]', "#content", "body"];
  let text = "";
  for (const selector of candidates) {
    const el = $(selector).first();
    if (el.length) {
      text = collapseWhitespace(el.text());
      if (text.length > 400) break;
    }
  }
  if (!text) text = collapseWhitespace($("body").text());

  if (text.length < 200) {
    throw new Error(
      "Could not extract meaningful article text from that URL. Paste the article content instead.",
    );
  }

  return { title, text: text.slice(0, MAX_ARTICLE_CHARS) };
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
