import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

const PRODUCT_HANDLE_RE = /^[^/?#\s]{1,255}$/;
const LOCALE_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

/**
 * Anonymous page-view counter behind the app proxy (/apps/cx/hit).
 * Increments one daily aggregate row per (day, product, locale) — no user
 * identifiers, no cookies, nothing per-visitor is stored. The beacon fires
 * for every product page view regardless of visitor, so it never introduces
 * visitor-dependent behavior.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const done = () =>
    new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });

  let shop: string | undefined;
  try {
    const { session } = await authenticate.public.appProxy(request);
    shop = session?.shop;
  } catch {
    return done();
  }
  if (!shop) return done();

  const url = new URL(request.url);
  const productHandle = url.searchParams.get("product") ?? "";
  const locale = (url.searchParams.get("locale") ?? "").toLowerCase();
  const isVariantVisit = url.searchParams.get("v") === "1";

  if (!PRODUCT_HANDLE_RE.test(productHandle) || !LOCALE_RE.test(locale)) {
    return done();
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  try {
    const updated = await prisma.dailyStat.updateMany({
      where: { shop, dateKey, productHandle, locale },
      data: {
        views: { increment: 1 },
        ...(isVariantVisit ? { variantViews: { increment: 1 } } : {}),
      },
    });
    if (updated.count === 0) {
      // New (day, product, locale) row. Cap row creation per shop per day so
      // a client inventing product handles cannot grow the table unboundedly
      // — increments to existing rows above are always allowed.
      const rowsToday = await prisma.dailyStat.count({
        where: { shop, dateKey },
      });
      if (rowsToday < 2000) {
        await prisma.dailyStat.create({
          data: {
            shop,
            dateKey,
            productHandle,
            locale,
            views: 1,
            variantViews: isVariantVisit ? 1 : 0,
          },
        });
      }
    }
  } catch {
    // Counting must never fail a storefront request (includes the rare
    // create race on the unique constraint — the next view counts).
  }
  return done();
};
