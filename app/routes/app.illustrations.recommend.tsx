import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { fetchArticle } from "../services/article.server";
import {
  ensureStarterTemplates,
  listTemplates,
} from "../services/illustration-templates.server";
import {
  figureSourceText,
  recommendIllustrations,
} from "../services/illustrations.server";
import { getSettings } from "../services/settings.server";

const MAX_SOURCE_CHARS = 60_000;

/**
 * "Recommend" endpoint (resource route, no page): five (template + specific
 * prompt) ideas for one section, from a brief or article the creation form
 * holds, a URL to read, or an existing variant (its source and current copy).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const surfaceKey = String(form.get("surfaceKey") ?? "").trim();
  if (!surfaceKey) return json({ error: "Missing section." }, { status: 400 });

  let locale = String(form.get("locale") ?? "").trim() || "en";
  let sourceKind: "brief" | "article" =
    String(form.get("sourceKind") ?? "") === "article" ? "article" : "brief";
  let sourceText = String(form.get("sourceText") ?? "").slice(0, MAX_SOURCE_CHARS);
  let productTitle = String(form.get("productTitle") ?? "").trim();
  let sectionCopy: string | null = null;
  const articleId = String(form.get("articleId") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();

  try {
    if (articleId) {
      const article = await prisma.article.findFirst({
        where: { id: articleId, shop },
        include: { overrides: { where: { surfaceKey } } },
      });
      if (!article) return json({ error: "Variant not found." }, { status: 404 });
      sourceKind = article.sourceKind === "brief" ? "brief" : "article";
      sourceText = figureSourceText(article);
      productTitle = article.productTitle;
      sectionCopy = article.overrides[0]?.adapted ?? null;
      locale = article.locale;
    } else if (url) {
      const extracted = await fetchArticle(url);
      sourceText = [extracted.title, extracted.text]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_SOURCE_CHARS);
      sourceKind = "article";
    }
    if (!sourceText.trim()) {
      return json(
        {
          error:
            sourceKind === "brief"
              ? "Write the brief first, then ask for recommendations."
              : "Add an article URL or paste the article first.",
        },
        { status: 400 },
      );
    }
    const settings = await getSettings(shop);
    const surface = settings.surfaces.find((s) => s.key === surfaceKey);
    if (!surface) return json({ error: "Unknown section." }, { status: 400 });
    await ensureStarterTemplates(shop);
    const templates = await listTemplates(shop);
    const suggestions = await recommendIllustrations({
      surfaceKey,
      surfaceLabel: surface.label,
      locale,
      productTitle: productTitle || "the product",
      sourceKind,
      sourceText,
      sectionCopy,
      templates,
    });
    return json({ suggestions });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};
