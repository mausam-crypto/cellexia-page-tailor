import type { IllustrationTemplate as TemplateRow } from "@prisma/client";
import prisma from "../db.server";
import { normalizeIllustrationShape, type IllustrationShape } from "./types";

/**
 * Prompt templates for AI illustrations.
 *
 * A template is a reusable drawing style: its category and "when to use"
 * text are what the recommender reads to pick one; its instructions are
 * prepended to the specific prompt of every drawing made with it. A
 * starter set is seeded once per shop (by stable seedKey) and is fully
 * editable; a starter the merchant deletes is never recreated.
 */

export interface StarterTemplate {
  seedKey: string;
  name: string;
  category: string;
  whenToUse: string;
  instructions: string;
  shape: IllustrationShape;
}

const CLINICAL_STYLE = `Style: clean, flat, professional clinical illustration, as in a medical textbook or a pharmaceutical leaflet. Muted palette of soft blues, teal and warm grey on a plain white background, with one accent colour for the element that matters most. Crisp vector-like shapes, consistent line weight, generous white space, no gradients or 3D effects, no texture, no shadows. Labels short and legible in a clean sans-serif typeface, placed with thin leader lines. No people's faces, no photographic skin, no brand names, logos or product packaging, no decorative clutter, no watermark, no frame.`;

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    seedKey: "mechanism-diagram",
    name: "Mechanism diagram",
    category: "Mechanism",
    whenToUse:
      "How something works on or in the skin as a chain of cause and effect: an ingredient enters, the barrier or a cell reacts, a visible result follows. Best when the section explains a principle or a process in two to five steps (for example how a molecule crosses the skin barrier, or how water is held in the upper skin layers).",
    instructions: `${CLINICAL_STYLE}
Composition: a left-to-right (or top-to-bottom) sequence of two to five stages joined by thin arrows, each stage a simple schematic with a short numbered label. Show the mechanism itself, not a product. Keep every element large enough to read on a phone.`,
    shape: "landscape",
  },
  {
    seedKey: "cross-section",
    name: "Skin cross-section",
    category: "Anatomy",
    whenToUse:
      "The layers of the skin (surface, epidermis, dermis) and where something acts or how deep it reaches. Best when the section talks about depth of penetration, the skin barrier's structure, or what happens in a specific layer.",
    instructions: `${CLINICAL_STYLE}
Composition: a schematic vertical cross-section of skin with the layers drawn as stacked bands, each band labelled on the side. Mark the zone of action with the accent colour. Proportions simplified and readable, not anatomically exhaustive.`,
    shape: "landscape",
  },
  {
    seedKey: "molecule-size-comparison",
    name: "Size comparison",
    category: "Comparison",
    whenToUse:
      "Contrasting sizes or scales: molecular weight, particle size, Daltons, what passes through a barrier and what is blocked. Best when the section explains a threshold or a rule (for example the 500 Dalton rule) or compares small and large molecules.",
    instructions: `${CLINICAL_STYLE}
Composition: a simplified barrier drawn as a horizontal band with regular gaps; small shapes passing through it on one side and larger shapes stopped on the other, sizes clearly different. Label the sizes or weights next to the shapes and the threshold value on the barrier. A small legend if there are more than two kinds of shape.`,
    shape: "landscape",
  },
  {
    seedKey: "step-by-step-process",
    name: "Step-by-step process",
    category: "Process",
    whenToUse:
      "A routine or an order of steps: how to apply, morning versus evening use, a sequence over days or weeks, before/during/after. Best when the section gives instructions or a timeline rather than a mechanism.",
    instructions: `${CLINICAL_STYLE}
Composition: three to five equal panels in a row, each with a simple icon-style drawing and a short numbered caption, joined by thin arrows. Time markers (minutes, days, weeks) as small labels when the subject gives them. Hands may appear schematically, never faces.`,
    shape: "landscape",
  },
  {
    seedKey: "bar-line-graph",
    name: "Scientific graph",
    category: "Data",
    whenToUse:
      "Numeric results over time or across groups shown as a bar chart or a line chart: hydration over hours, a measurement before and after, two conditions side by side. Use only when the section or the brief gives figures or a clear trend to plot; the specific prompt must state every number, unit and axis label.",
    instructions: `${CLINICAL_STYLE}
Composition: a single clean chart with two labelled axes, units on the axes, tick marks, a short title above and a legend only when there are two or more series. Bars or a line in the accent colour against light grey gridlines. Plot exactly the values given in the specific prompt, nothing more; no annotations other than the labels asked for.`,
    shape: "landscape",
  },
  {
    seedKey: "ingredient-infographic",
    name: "Ingredient infographic",
    category: "Ingredients",
    whenToUse:
      "A product's key ingredients or components and what each one does, at a glance. Best when the section lists ingredients, actives or a formulation and their roles.",
    instructions: `${CLINICAL_STYLE}
Composition: a grid or a ring of three to six simple icon-style drawings, each with the ingredient's name and a three-to-six-word role beneath it. Icons schematic (a droplet, a leaf, a molecule outline), evenly sized and spaced. No central product image.`,
    shape: "square",
  },
  {
    seedKey: "before-after",
    name: "Before and after",
    category: "Comparison",
    whenToUse:
      "Contrasting the state of the skin before and after use (surface texture, barrier integrity, hydration, evenness), shown schematically. Best when the section describes a visible or structural change. Never a real face or a photograph.",
    instructions: `${CLINICAL_STYLE}
Composition: two equal panels side by side, labelled "Before" and "After" in the image language, each a stylised cross-section or surface view of skin drawn the same way so the difference is the only change. The improved panel uses the accent colour. Keep the depiction symbolic and honest, not dramatic.`,
    shape: "landscape",
  },
  {
    seedKey: "labelled-anatomy",
    name: "Labelled diagram",
    category: "Anatomy",
    whenToUse:
      "A single structure with its named parts: a hair follicle, a pore, a cell membrane, a sweat gland. Best when the section names the parts of something and the reader benefits from seeing where they are.",
    instructions: `${CLINICAL_STYLE}
Composition: one centred schematic of the structure, four to eight short labels around it with thin leader lines, the part the section is about in the accent colour. Nothing else in the frame.`,
    shape: "square",
  },
];

/** Seed the starter set the first time a shop touches templates
 *  (idempotent: a shop that already has any template is left alone, so
 *  starters the merchant archived or rewrote are never recreated). Starters
 *  can be archived but not deleted, which keeps the seed check this simple. */
export async function ensureStarterTemplates(shop: string): Promise<void> {
  const count = await prisma.illustrationTemplate.count({ where: { shop } });
  if (count > 0) return;
  await prisma.$transaction(
    STARTER_TEMPLATES.map((t, i) =>
      prisma.illustrationTemplate.create({
        data: {
          shop,
          seedKey: t.seedKey,
          name: t.name,
          category: t.category,
          whenToUse: t.whenToUse,
          instructions: t.instructions,
          shape: t.shape,
          sortOrder: i,
        },
      }),
    ),
  );
}

export type TemplateSummary = Pick<
  TemplateRow,
  "id" | "name" | "category" | "whenToUse" | "shape" | "seedKey" | "archived"
>;

export async function listTemplates(
  shop: string,
  options: { includeArchived?: boolean } = {},
): Promise<TemplateRow[]> {
  return prisma.illustrationTemplate.findMany({
    where: { shop, ...(options.includeArchived ? {} : { archived: false }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** Human name of a locale in English, for the drawing prompt. */
export function languageNameFor(locale: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(locale);
    return name && name !== locale ? name : locale;
  } catch {
    return locale;
  }
}

/** The complete prompt sent to the image model. Stored verbatim on the
 *  drawn image so it can be drawn again. */
export function buildFinalPrompt(input: {
  houseStyle: string;
  template: { instructions: string; shape: string };
  specificPrompt: string;
  locale: string;
}): string {
  const languageName = languageNameFor(input.locale);
  const blocks = [
    input.houseStyle.trim(),
    input.template.instructions.trim(),
    `Subject of this illustration:\n${input.specificPrompt.trim()}`,
    `Language: every label, caption, axis title and number inside the image is written in ${languageName} (${input.locale}), spelled correctly and naturally. Do not add any text that is not needed to understand the figure.`,
  ].filter((b) => b !== "");
  return blocks.join("\n\n");
}

export function templateShape(template: { shape: string }): IllustrationShape {
  return normalizeIllustrationShape(template.shape);
}
