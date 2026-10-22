import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  Link as RemixLink,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { thumbnailUrl } from "../components/IllustrationChoice";
import { getShopLocalesCached } from "../services/shopify-data.server";
import { deleteShopifyFile } from "../services/shopify-files.server";
import { parseFigureAlternatives } from "../services/types";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const image = await prisma.illustrationImage.findFirst({
    where: { id: params.id, shop },
    include: { template: { select: { id: true, name: true } } },
  });
  if (!image) throw new Response("Image not found", { status: 404 });

  // Where it is used: as the live figure, as an alternative, as a template
  // example. Alternatives are JSON, so every override with alternatives is
  // scanned (cheap at this app's scale).
  const overrides = await prisma.override.findMany({
    where: {
      article: { shop },
      OR: [{ figureImageId: image.id }, { figureAlternatives: { not: null } }],
    },
    select: {
      label: true,
      figureImageId: true,
      figureAlternatives: true,
      article: {
        select: {
          id: true,
          productTitle: true,
          locale: true,
          briefName: true,
          sourceTitle: true,
          status: true,
        },
      },
    },
  });
  const usedIn = overrides
    .map((o) => {
      const isCurrent = o.figureImageId === image.id;
      const isAlternative = parseFigureAlternatives(o.figureAlternatives).images.includes(
        image.id,
      );
      if (!isCurrent && !isAlternative) return null;
      return {
        articleId: o.article.id,
        title: o.article.briefName ?? o.article.sourceTitle ?? o.article.productTitle,
        productTitle: o.article.productTitle,
        locale: o.article.locale,
        status: o.article.status,
        surfaceLabel: o.label,
        role: isCurrent ? ("current" as const) : ("alternative" as const),
      };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);
  const exampleOf = await prisma.illustrationTemplate.findMany({
    where: { shop, exampleImageId: image.id },
    select: { id: true, name: true },
  });
  let locales: Array<{ locale: string; name: string }> = [];
  try {
    locales = (await getShopLocalesCached(admin, shop))
      .filter((l) => l.published)
      .map((l) => ({ locale: l.locale, name: l.name }));
  } catch {
    locales = [];
  }
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(image.tags);
    tags = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    tags = [];
  }
  return {
    image: {
      id: image.id,
      kind: image.kind,
      name: image.name,
      description: image.description,
      tags,
      language: image.language ?? "",
      cdnUrl: image.cdnUrl,
      width: image.width,
      height: image.height,
      mimeType: image.mimeType,
      bytes: image.bytes,
      templateName: image.template?.name ?? null,
      templateId: image.template?.id ?? null,
      specificPrompt: image.specificPrompt,
      finalPrompt: image.finalPrompt,
      rationale: image.rationale,
      model: image.model,
      quality: image.quality,
      size: image.size,
      costUsd: image.costUsd,
      createdAt: image.createdAt.toISOString(),
    },
    usedIn,
    exampleOf,
    locales,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const image = await prisma.illustrationImage.findFirst({
    where: { id: params.id, shop },
  });
  if (!image) throw new Response("Image not found", { status: 404 });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save") {
    const name = String(formData.get("name") ?? "").trim().slice(0, 120);
    if (!name) return { ok: false as const, intent, error: "The image needs a name." };
    const tags = [
      ...new Set(
        String(formData.get("tags") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].slice(0, 20);
    await prisma.illustrationImage.update({
      where: { id: image.id },
      data: {
        name,
        description: String(formData.get("description") ?? "").trim().slice(0, 2000),
        tags: JSON.stringify(tags),
        language: String(formData.get("language") ?? "").trim() || null,
      },
    });
    return { ok: true as const, intent, error: null };
  }

  if (intent === "delete") {
    const inUse = await prisma.override.count({
      where: { article: { shop }, figureImageId: image.id },
    });
    const alternatives = await prisma.override.findMany({
      where: { article: { shop }, figureAlternatives: { contains: image.id } },
      select: { id: true },
    });
    const examples = await prisma.illustrationTemplate.count({
      where: { shop, exampleImageId: image.id },
    });
    if (inUse + alternatives.length + examples > 0) {
      return {
        ok: false as const,
        intent,
        error: "This image is in use on a page or as a template example. Remove it there first.",
      };
    }
    try {
      await deleteShopifyFile(admin, image.shopifyFileId);
    } catch (error) {
      return {
        ok: false as const,
        intent,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await prisma.illustrationImage.delete({ where: { id: image.id } });
    return redirect("/app/images");
  }
  return { ok: false as const, intent, error: "Unknown action." };
};

export default function ImageDetail() {
  const { image, usedIn, exampleOf, locales } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [name, setName] = useState(image.name);
  const [description, setDescription] = useState(image.description);
  const [tags, setTags] = useState(image.tags.join(", "));
  const [language, setLanguage] = useState(image.language);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isSubmitting = navigation.state === "submitting";
  const used = usedIn.length + exampleOf.length;

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "save") {
      shopify.toast.show("Image saved");
    }
  }, [actionData, shopify]);

  const handleSave = useCallback(() => {
    submit({ intent: "save", name, description, tags, language }, { method: "POST" });
  }, [name, description, tags, language, submit]);

  const error = actionData && !actionData.ok ? actionData.error : null;

  return (
    <Page
      title={image.name}
      backAction={{ url: "/app/images" }}
      primaryAction={{ content: "Save", onAction: handleSave, loading: isSubmitting }}
      secondaryActions={[
        {
          content: "Delete",
          destructive: true,
          disabled: used > 0,
          onAction: () => setConfirmDelete(true),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" title="Something went wrong">
                {error}
              </Banner>
            )}
            <Card>
              <BlockStack gap="400">
                <img
                  src={thumbnailUrl(image.cdnUrl, 1200)}
                  alt={image.description || image.name}
                  style={{ width: "100%", height: "auto", borderRadius: 8, display: "block" }}
                />
                <InlineStack gap="100" wrap>
                  <Badge tone={image.kind === "drawn" ? "info" : undefined}>
                    {image.kind === "drawn" ? "Drawn by the app" : "Uploaded"}
                  </Badge>
                  <Badge>{`${image.width} × ${image.height}`}</Badge>
                  <Badge>{image.mimeType.replace("image/", "").toUpperCase()}</Badge>
                  {image.costUsd !== null && <Badge>{`Cost $${image.costUsd.toFixed(3)}`}</Badge>}
                </InlineStack>
                <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                  <TextField label="Name" value={name} onChange={setName} autoComplete="off" maxLength={120} />
                  <Select
                    label="Language of the labels inside the image"
                    options={[
                      { label: "No text, or not specific to a language", value: "" },
                      ...locales.map((l) => ({ label: `${l.name} (${l.locale})`, value: l.locale })),
                    ]}
                    value={language}
                    onChange={setLanguage}
                  />
                </InlineGrid>
                <TextField
                  label="What it shows"
                  value={description}
                  onChange={setDescription}
                  multiline={3}
                  autoComplete="off"
                  maxLength={2000}
                  helpText="Read by Claude when it places the image and writes its caption."
                />
                <TextField
                  label="Tags (comma separated)"
                  value={tags}
                  onChange={setTags}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            {image.kind === "drawn" && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    How it was drawn
                  </Text>
                  <List>
                    <List.Item>
                      Template:{" "}
                      {image.templateId ? (
                        <RemixLink to={`/app/templates/${image.templateId}`}>
                          {image.templateName}
                        </RemixLink>
                      ) : (
                        image.templateName ?? "(deleted template)"
                      )}
                    </List.Item>
                    <List.Item>
                      Model: {image.model ?? "?"} · quality {image.quality ?? "?"} · size{" "}
                      {image.size ?? "?"}
                    </List.Item>
                    {image.rationale && <List.Item>Why: {image.rationale}</List.Item>}
                  </List>
                  <TextField
                    label="Specific prompt"
                    value={image.specificPrompt ?? ""}
                    multiline={3}
                    readOnly
                    autoComplete="off"
                  />
                  <TextField
                    label="Full prompt sent to the image model"
                    value={image.finalPrompt ?? ""}
                    multiline={6}
                    readOnly
                    autoComplete="off"
                  />
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Used in
                </Text>
                {used === 0 ? (
                  <Text as="p" tone="subdued">
                    Not used on any page. It can be deleted.
                  </Text>
                ) : (
                  <List>
                    {usedIn.map((u, i) => (
                      <List.Item key={`${u.articleId}-${i}`}>
                        <RemixLink to={`/app/articles/${u.articleId}`}>{u.title}</RemixLink>{" "}
                        ({u.productTitle}, {u.locale}) · {u.surfaceLabel} ·{" "}
                        {u.role === "current" ? "live figure" : "alternative"}
                        {u.status !== "approved" ? " · page offline" : ""}
                      </List.Item>
                    ))}
                    {exampleOf.map((t) => (
                      <List.Item key={t.id}>
                        Example image of the template{" "}
                        <RemixLink to={`/app/templates/${t.id}`}>{t.name}</RemixLink>
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this image?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: () => submit({ intent: "delete" }, { method: "POST" }),
          loading: isSubmitting,
        }}
        secondaryActions={[{ content: "Keep it", onAction: () => setConfirmDelete(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            The image will be removed from the library and from your store's
            Files. This cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
