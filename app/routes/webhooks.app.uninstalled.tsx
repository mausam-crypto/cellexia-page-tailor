import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    // Remove ALL of the shop's data, not just sessions: variants, overrides
    // (cascade), experiment definitions, order-derived rows, view counters,
    // and settings. Nothing about the shop is retained after uninstall.
    await db.$transaction([
      db.session.deleteMany({ where: { shop } }),
      db.article.deleteMany({ where: { shop } }),
      db.experiment.deleteMany({ where: { shop } }),
      db.orderLine.deleteMany({ where: { shop } }),
      db.dailyStat.deleteMany({ where: { shop } }),
      db.shopSettings.deleteMany({ where: { shop } }),
    ]);
  }

  return new Response();
};
