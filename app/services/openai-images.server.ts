import type { IllustrationQuality, IllustrationShape } from "./types";

/**
 * OpenAI Images API client for drawing illustrations.
 *
 * Plain fetch on purpose: one endpoint, and the official SDK's current
 * release requires a newer Node than this app declares. GPT Image models
 * always return the image as base64; the bytes are then uploaded to the
 * store's Shopify Files, never served from here.
 */

const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const ENDPOINT = "https://api.openai.com/v1/images/generations";
// The docs allow up to ~2 minutes for a complex prompt.
const REQUEST_TIMEOUT_MS = 180_000;

/** Published per-million-token rates for the gpt-image-2.5 family (USD). */
export const COST_PER_MTOK = {
  textInput: 5,
  imageInput: 8,
  imageOutput: 30,
} as const;

export const SIZE_BY_SHAPE: Record<IllustrationShape, string> = {
  landscape: "1536x1024",
  square: "1024x1024",
  portrait: "1024x1536",
};

// Output tokens per image when the API returns no usage block (rare). Seeded
// from the GPT Image 1 public table; xhigh is a conservative doubling. The
// ledger marks such rows "estimated".
const FALLBACK_OUTPUT_TOKENS: Record<
  IllustrationQuality,
  Record<IllustrationShape, number>
> = {
  low: { square: 272, landscape: 408, portrait: 400 },
  medium: { square: 1056, landscape: 1584, portrait: 1568 },
  high: { square: 4160, landscape: 6240, portrait: 6208 },
  xhigh: { square: 8320, landscape: 12480, portrait: 12416 },
};

export type ImageModelErrorKind = "config" | "refused" | "transient" | "other";

export class ImageModelError extends Error {
  readonly kind: ImageModelErrorKind;
  constructor(kind: ImageModelErrorKind, message: string) {
    super(message);
    this.name = "ImageModelError";
    this.kind = kind;
  }
}

export interface DrawUsage {
  inputTokens: number;
  outputTokens: number;
  textTokens: number;
  imageTokens: number;
}

export interface DrawResult {
  bytes: Buffer;
  mimeType: "image/png";
  width: number;
  height: number;
  model: string;
  quality: IllustrationQuality;
  size: string;
  usage: DrawUsage | null;
  costUsd: number;
  estimated: boolean;
}

export function imageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
}

export function imageModelConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** Cost of one drawing from its usage figures (exact) or the fallback table. */
export function estimateCostUsd(
  usage: DrawUsage | null,
  quality: IllustrationQuality,
  shape: IllustrationShape,
): { costUsd: number; estimated: boolean } {
  if (usage) {
    const cost =
      (usage.imageTokens * COST_PER_MTOK.imageOutput +
        usage.textTokens * COST_PER_MTOK.textInput +
        (usage.inputTokens - usage.textTokens) * COST_PER_MTOK.imageInput) /
      1_000_000;
    return { costUsd: round4(Math.max(0, cost)), estimated: false };
  }
  const tokens = FALLBACK_OUTPUT_TOKENS[quality][shape];
  return {
    costUsd: round4((tokens * COST_PER_MTOK.imageOutput) / 1_000_000),
    estimated: true,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Rough per-image cost shown next to the quality picker in Settings. */
export function typicalCostUsd(
  quality: IllustrationQuality,
  shape: IllustrationShape = "landscape",
): number {
  return estimateCostUsd(null, quality, shape).costUsd;
}

function parseSize(size: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(size);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1024, height: 1024 };
}

type ApiError = { error?: { message?: string; type?: string; code?: string } };

function classify(status: number, body: ApiError): ImageModelError {
  const message = body.error?.message ?? `HTTP ${status}`;
  const code = (body.error?.code ?? "").toLowerCase();
  if (status === 401) {
    return new ImageModelError(
      "config",
      "OPENAI_API_KEY is missing or invalid. Check the key on the server, then try again.",
    );
  }
  if (status === 403 && /verif/i.test(message)) {
    return new ImageModelError(
      "config",
      "Your OpenAI organization must complete verification before it can use GPT Image models. Verify it on platform.openai.com, then try again.",
    );
  }
  if (
    status === 400 &&
    (code.includes("moderation") ||
      code.includes("content_policy") ||
      /safety|policy|moderation/i.test(message))
  ) {
    return new ImageModelError(
      "refused",
      "The image model declined this prompt. Reword the specific prompt (avoid medical treatment wording and real people) and draw again.",
    );
  }
  if (status === 429) {
    return new ImageModelError(
      "transient",
      "The image model is rate-limited right now. Try again in a minute.",
    );
  }
  if (status >= 500) {
    return new ImageModelError(
      "transient",
      `The image model returned an error (HTTP ${status}). Try again.`,
    );
  }
  return new ImageModelError("other", `Image model error: ${message}`);
}

async function requestOnce(
  prompt: string,
  size: string,
  quality: IllustrationQuality,
): Promise<{ b64: string; usage: DrawUsage | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: imageModel(),
          prompt,
          n: 1,
          size,
          quality,
          output_format: "png",
          background: "opaque",
          moderation: "auto",
        }),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new ImageModelError(
        "transient",
        aborted
          ? "The image model took longer than 3 minutes. Try again."
          : `Could not reach the image model: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw classify(response.status, (body ?? {}) as ApiError);
    }
    const data = body as {
      data?: Array<{ b64_json?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { text_tokens?: number; image_tokens?: number };
      };
    };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      throw new ImageModelError("other", "The image model returned no image.");
    }
    const u = data.usage;
    const usage: DrawUsage | null =
      u && typeof u.output_tokens === "number"
        ? {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens,
            textTokens: u.input_tokens_details?.text_tokens ?? u.input_tokens ?? 0,
            imageTokens: u.output_tokens,
          }
        : null;
    return { b64, usage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Draw one image. Transient failures (rate limit, 5xx, network, timeout)
 * are retried once after a short pause; refusals and configuration errors
 * are not.
 */
export async function drawImage(input: {
  prompt: string;
  shape: IllustrationShape;
  quality: IllustrationQuality;
}): Promise<DrawResult> {
  if (!imageModelConfigured()) {
    throw new ImageModelError(
      "config",
      "OPENAI_API_KEY is not set on the server. Add it to draw illustrations; the library and uploads work without it.",
    );
  }
  const prompt = input.prompt.trim().slice(0, 32_000);
  if (!prompt) throw new ImageModelError("other", "The drawing prompt is empty.");
  const size = SIZE_BY_SHAPE[input.shape];

  let result: { b64: string; usage: DrawUsage | null };
  try {
    result = await requestOnce(prompt, size, input.quality);
  } catch (error) {
    if (!(error instanceof ImageModelError) || error.kind !== "transient") {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    result = await requestOnce(prompt, size, input.quality);
  }

  const bytes = Buffer.from(result.b64, "base64");
  if (bytes.length < 100) {
    throw new ImageModelError("other", "The image model returned an empty image.");
  }
  const { width, height } = parseSize(size);
  const { costUsd, estimated } = estimateCostUsd(result.usage, input.quality, input.shape);
  return {
    bytes,
    mimeType: "image/png",
    width,
    height,
    model: imageModel(),
    quality: input.quality,
    size,
    usage: result.usage,
    costUsd,
    estimated,
  };
}
