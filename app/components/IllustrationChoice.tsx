import { useCallback, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Checkbox,
  ChoiceList,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import type {
  FigureSuggestion,
  FormChoiceMemory,
  SurfaceIllustrationChoice,
} from "../services/types";

/**
 * The per-section illustration choice used by the creation forms (and the
 * review page's "Draw" dialog): none / Auto / a library image / a template
 * with one or more prompts to draw, plus the one-click Recommend.
 */

export interface ChoiceTemplate {
  id: string;
  name: string;
  category: string;
  whenToUse: string;
  shape: string;
}

export interface ChoiceImage {
  id: string;
  name: string;
  cdnUrl: string;
  language: string | null;
  kind: string;
}

export interface SuggestionDraft extends FigureSuggestion {
  ticked: boolean;
}

export interface IllustrationChoiceDraft {
  mode: "none" | "auto" | "library" | "template";
  imageId: string | null;
  /** The merchant's own idea (template + prompt); drawn when the prompt is filled in. */
  templateId: string;
  prompt: string;
  suggestions: SuggestionDraft[];
  recommending: boolean;
  error: string | null;
}

export function emptyChoice(
  memory: FormChoiceMemory | undefined,
  templates: ChoiceTemplate[],
  images: ChoiceImage[],
): IllustrationChoiceDraft {
  const templateId =
    (memory?.templateId && templates.some((t) => t.id === memory.templateId)
      ? memory.templateId
      : templates[0]?.id) ?? "";
  const imageId =
    memory?.imageId && images.some((i) => i.id === memory.imageId)
      ? memory.imageId
      : null;
  const mode =
    memory?.mode === "library" && !imageId
      ? "none"
      : memory?.mode === "template" && !templateId
        ? "none"
        : (memory?.mode ?? "none");
  return {
    mode,
    imageId,
    templateId,
    prompt: "",
    suggestions: [],
    recommending: false,
    error: null,
  };
}

/** What the form posts for one section. */
export function choiceToSubmission(
  draft: IllustrationChoiceDraft,
): SurfaceIllustrationChoice {
  if (draft.mode === "auto") return { mode: "auto" };
  if (draft.mode === "library") {
    return draft.imageId ? { mode: "library", imageId: draft.imageId } : { mode: "none" };
  }
  if (draft.mode === "template") {
    const draws: FigureSuggestion[] = [];
    if (draft.prompt.trim() && draft.templateId) {
      draws.push({
        templateId: draft.templateId,
        specificPrompt: draft.prompt.trim(),
        rationale: "Your own prompt",
      });
    }
    for (const s of draft.suggestions) {
      if (s.ticked && s.specificPrompt.trim()) {
        draws.push({
          templateId: s.templateId,
          specificPrompt: s.specificPrompt.trim(),
          rationale: s.rationale,
        });
      }
    }
    return draws.length > 0 ? { mode: "template", draws } : { mode: "none" };
  }
  return { mode: "none" };
}

/** What the form remembers for next time (never the prompt itself). */
export function choiceToMemory(draft: IllustrationChoiceDraft): FormChoiceMemory {
  const memory: FormChoiceMemory = { mode: draft.mode };
  if (draft.mode === "template" && draft.templateId) memory.templateId = draft.templateId;
  if (draft.mode === "library" && draft.imageId) memory.imageId = draft.imageId;
  return memory;
}

/** Count of drawings a choice will trigger per language page. */
export function drawCount(draft: IllustrationChoiceDraft): number {
  if (draft.mode === "auto") return 1;
  if (draft.mode !== "template") return 0;
  const submission = choiceToSubmission(draft);
  return submission.mode === "template" ? submission.draws.length : 0;
}

/** Shopify CDN thumbnail: the size parameter keeps the admin light. */
export function thumbnailUrl(cdnUrl: string, width = 200): string {
  if (!/cdn\.shopify\.com|shopify\.com\/s\/files/i.test(cdnUrl)) return cdnUrl;
  return `${cdnUrl}${cdnUrl.includes("?") ? "&" : "?"}width=${width}`;
}

function money(n: number): string {
  return `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
}

export function ImagePickerModal(props: {
  open: boolean;
  images: ChoiceImage[];
  onPick: (image: ChoiceImage) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? props.images.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.language ?? "").toLowerCase().includes(q),
      )
    : props.images;
  return (
    <Modal open={props.open} onClose={props.onClose} title="Choose an image" size="large">
      <Modal.Section>
        <BlockStack gap="300">
          <TextField
            label="Search"
            labelHidden
            value={query}
            onChange={setQuery}
            autoComplete="off"
            placeholder="Search by name or language"
            clearButton
            onClearButtonClick={() => setQuery("")}
          />
          {shown.length === 0 ? (
            <Text as="p" tone="subdued">
              {props.images.length === 0
                ? "The image library is empty. Upload images on the Image library page or draw some first."
                : "No image matches."}
            </Text>
          ) : (
            <InlineGrid columns={{ xs: 2, sm: 3, md: 4 }} gap="300">
              {shown.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => props.onPick(image)}
                  style={{
                    background: "none",
                    border: "1px solid var(--p-color-border)",
                    borderRadius: 8,
                    padding: 8,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <BlockStack gap="150">
                    <img
                      src={thumbnailUrl(image.cdnUrl, 400)}
                      alt=""
                      style={{ width: "100%", height: "auto", borderRadius: 4, display: "block" }}
                    />
                    <Text as="span" variant="bodySm" truncate>
                      {image.name}
                    </Text>
                    <InlineStack gap="100">
                      {image.language && <Badge>{image.language}</Badge>}
                      <Badge tone={image.kind === "drawn" ? "info" : undefined}>
                        {image.kind === "drawn" ? "Drawn" : "Uploaded"}
                      </Badge>
                    </InlineStack>
                  </BlockStack>
                </button>
              ))}
            </InlineGrid>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export type ChoiceUpdater = (
  previous: IllustrationChoiceDraft,
) => IllustrationChoiceDraft;

export function IllustrationChoice(props: {
  surfaceKey: string;
  surfaceLabel: string;
  value: IllustrationChoiceDraft;
  /** Functional update: a slow Recommend must never clobber typing. */
  onChange: (update: ChoiceUpdater) => void;
  templates: ChoiceTemplate[];
  images: ChoiceImage[];
  /** Locales of the pages this choice applies to (mismatch warning). */
  locales: string[];
  /** Asks the server for 5 ideas; resolves with suggestions or throws. */
  recommend: (surfaceKey: string) => Promise<FigureSuggestion[]>;
  openaiConfigured: boolean;
  costPerImage: number;
  /** Hide the Auto option (review page: there is already copy to read). */
  hideAuto?: boolean;
}) {
  const { value, onChange, templates, images } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const patch = useCallback(
    (p: Partial<IllustrationChoiceDraft>) =>
      onChange((previous) => ({ ...previous, ...p })),
    [onChange],
  );
  const pickedImage = value.imageId ? images.find((i) => i.id === value.imageId) : undefined;
  const templateOptions = templates.map((t) => ({
    label: `${t.name} (${t.category})`,
    value: t.id,
  }));
  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? "Template";
  const mismatch =
    pickedImage?.language &&
    props.locales.some((l) => l.toLowerCase() !== pickedImage.language!.toLowerCase());

  const { recommend, surfaceKey } = props;
  const runRecommend = useCallback(async () => {
    onChange((previous) => ({ ...previous, recommending: true, error: null }));
    try {
      const suggestions = await recommend(surfaceKey);
      onChange((previous) => ({
        ...previous,
        recommending: false,
        error: null,
        suggestions: suggestions.map((s, i) => ({ ...s, ticked: i === 0 })),
      }));
    } catch (error) {
      onChange((previous) => ({
        ...previous,
        recommending: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [onChange, recommend, surfaceKey]);

  const draws = drawCount(value);
  const choices = [
    { label: "No illustration", value: "none" },
    ...(props.hideAuto
      ? []
      : [
          {
            label: "Auto: Claude picks a template, writes the prompt and draws the best idea",
            value: "auto",
          },
        ]),
    { label: "An image from the library", value: "library" },
    { label: "Draw from a template and a prompt", value: "template" },
  ];

  return (
    <Box borderColor="border" borderWidth="025" borderRadius="200" padding="300">
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          {props.surfaceLabel}
        </Text>
        <ChoiceList
          title="Illustration"
          titleHidden
          choices={choices}
          selected={[value.mode]}
          onChange={(selected) =>
            patch({
              mode:
                selected[0] === "auto" ||
                selected[0] === "library" ||
                selected[0] === "template"
                  ? selected[0]
                  : "none",
            })
          }
        />
        {value.mode === "auto" && (
          <Text as="p" variant="bodySm" tone="subdued">
            {props.openaiConfigured
              ? `When the page is generated, Claude proposes five ideas from your templates, the best one is drawn (about ${money(
                  props.costPerImage,
                )} per language page) and the other four are kept as suggestions on the review page.`
              : "OPENAI_API_KEY is not set on the server, so nothing can be drawn. Choose a library image instead, or ask your developer to add the key."}
          </Text>
        )}
        {value.mode === "library" && (
          <BlockStack gap="200">
            <InlineStack gap="300" blockAlign="center" wrap>
              {pickedImage ? (
                <Thumbnail
                  source={thumbnailUrl(pickedImage.cdnUrl)}
                  alt=""
                  size="large"
                />
              ) : null}
              <BlockStack gap="100">
                <Text as="span" variant="bodyMd">
                  {pickedImage ? pickedImage.name : "No image chosen yet"}
                </Text>
                {pickedImage?.language && (
                  <InlineStack gap="100">
                    <Badge>{`Labels in ${pickedImage.language}`}</Badge>
                  </InlineStack>
                )}
              </BlockStack>
              <Button onClick={() => setPickerOpen(true)}>
                {pickedImage ? "Change image" : "Choose image"}
              </Button>
            </InlineStack>
            {mismatch && (
              <Banner tone="warning">
                This image is tagged {pickedImage!.language}, but it will be used
                on every language you ticked ({props.locales.join(", ")}). You
                can swap it per language on each page's review screen.
              </Banner>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Claude places the image in the section and writes a caption in
              the page's language.
            </Text>
            <ImagePickerModal
              open={pickerOpen}
              images={images}
              onPick={(image) => {
                patch({ imageId: image.id });
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          </BlockStack>
        )}
        {value.mode === "template" && (
          <BlockStack gap="300">
            {!props.openaiConfigured && (
              <Banner tone="warning">
                OPENAI_API_KEY is not set on the server, so nothing can be drawn
                yet. You can still prepare the prompts.
              </Banner>
            )}
            {templates.length === 0 ? (
              <Banner tone="warning">
                There are no templates. Add one on the Templates page first.
              </Banner>
            ) : (
              <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                <Select
                  label="Template"
                  options={templateOptions}
                  value={value.templateId}
                  onChange={(id) => patch({ templateId: id })}
                  helpText={
                    templates.find((t) => t.id === value.templateId)?.whenToUse ??
                    undefined
                  }
                />
                <TextField
                  label="Your own prompt (optional)"
                  value={value.prompt}
                  onChange={(prompt) => patch({ prompt })}
                  multiline={3}
                  autoComplete="off"
                  placeholder='e.g. A skin barrier as a band with gaps; small molecules labelled "< 500 Da" passing through, larger ones labelled "> 500 Da" stopped above it.'
                  helpText="Drawn with the template above when filled in. Labels you want inside the image go in quotes, in the page's language."
                />
              </InlineGrid>
            )}
            <InlineStack gap="300" blockAlign="center" wrap>
              <Button
                onClick={runRecommend}
                loading={value.recommending}
                disabled={templates.length === 0}
              >
                Recommend 5 ideas
              </Button>
              <Text as="span" variant="bodySm" tone="subdued">
                Claude reads your text and proposes five template + prompt
                combinations. Tick the ones to draw; each costs about{" "}
                {money(props.costPerImage)} per language page.
              </Text>
            </InlineStack>
            {value.error && (
              <Banner tone="critical" onDismiss={() => patch({ error: null })}>
                {value.error}
              </Banner>
            )}
            {value.suggestions.length > 0 && (
              <BlockStack gap="200">
                {value.suggestions.map((s, index) => (
                  <Box
                    key={`${s.templateId}-${index}`}
                    background={s.ticked ? "bg-surface-secondary" : undefined}
                    borderColor="border"
                    borderWidth="025"
                    borderRadius="200"
                    padding="300"
                  >
                    <BlockStack gap="200">
                      <Checkbox
                        label={
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {templateName(s.templateId)}
                          </Text>
                        }
                        helpText={s.rationale}
                        checked={s.ticked}
                        onChange={(ticked) =>
                          patch({
                            suggestions: value.suggestions.map((x, i) =>
                              i === index ? { ...x, ticked } : x,
                            ),
                          })
                        }
                      />
                      <TextField
                        label="Prompt"
                        labelHidden
                        value={s.specificPrompt}
                        onChange={(specificPrompt) =>
                          patch({
                            suggestions: value.suggestions.map((x, i) =>
                              i === index ? { ...x, specificPrompt } : x,
                            ),
                          })
                        }
                        multiline={2}
                        autoComplete="off"
                      />
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              {draws === 0
                ? "Nothing will be drawn yet: write a prompt or tick an idea."
                : `${draws} image${draws === 1 ? "" : "s"} will be drawn per language page (about ${money(
                    draws * props.costPerImage,
                  )}); the first one goes live, the others are kept as alternatives.`}
            </Text>
          </BlockStack>
        )}
      </BlockStack>
    </Box>
  );
}

/** Ask the server for five ideas (the Recommend endpoint). Throws with a
 *  readable message on failure. */
export async function requestRecommendations(
  fields: Record<string, string>,
): Promise<FigureSuggestion[]> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await fetch("/app/illustrations/recommend", {
    method: "POST",
    body: form,
  });
  let body: { suggestions?: FigureSuggestion[]; error?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!response.ok || body.error || !Array.isArray(body.suggestions)) {
    throw new Error(body.error ?? "Could not get recommendations. Try again.");
  }
  return body.suggestions;
}
