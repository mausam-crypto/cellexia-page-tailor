import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getVariantPayload } from "../services/variant.server";

const HANDLE_RE = /^[a-z0-9]{4,16}$/;
// Product handles may contain non-ASCII characters (CJK etc.); only exclude
// path/query metacharacters and whitespace.
const PRODUCT_HANDLE_RE = /^[^/?#\s]{1,255}$/;
// 2-3 letter language code plus optional region/script subtag (fr, fil, pt-BR).
const LOCALE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

/**
 * Storefront endpoint behind the Shopify app proxy (/apps/cx/variant).
 * Shopify signs every request; authenticate.public.appProxy verifies the
 * signature and resolves the shop. The response is identical for every
 * requester of the same URL — no user-agent, referrer, or bot branching,
 * which is what keeps this personalization on the right side of Google's
 * cloaking rules.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const empty = (status = 200) =>
    new Response(JSON.stringify({ ops: [] }), {
      status,
      headers: {
        "content-type": "application/json",
        // Empty results aren't worth caching; only real payloads get a TTL.
        "cache-control": "no-store",
      },
    });

  let shop: string | undefined;
  try {
    const { session } = await authenticate.public.appProxy(request);
    shop = session?.shop;
  } catch {
    return empty(401);
  }
  if (!shop) return empty();

  const url = new URL(request.url);
  const productHandle = url.searchParams.get("product") ?? "";
  const variantHandle = url.searchParams.get("v") ?? "";
  const locale = url.searchParams.get("locale") ?? "";

  if (
    !HANDLE_RE.test(variantHandle) ||
    !PRODUCT_HANDLE_RE.test(productHandle) ||
    !LOCALE_RE.test(locale)
  ) {
    return empty();
  }

  const payload = await getVariantPayload(
    shop,
    productHandle,
    variantHandle,
    locale,
  );
  if (!payload) return empty();

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=120",
    },
  });
};
