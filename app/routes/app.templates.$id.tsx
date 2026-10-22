import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  ImagePickerModal,
  thumbnailUrl,
  type ChoiceImage,
} from "../components/IllustrationChoice";
import { STARTER_TEMPLATES } from "../services/illustration-templates.server";
import { normalizeIllustrationShape } from "../services/types";

const MAX_NAME = 80;
const MAX_CATEGORY = 40;
const MAX_WHEN = 1500;
const MAX_INSTRUCTIONS = 6000;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const images: ChoiceImage[] = await prisma.illustrationImage.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, name: true, cdnUrl: true, language: true, kind: true },
  });
  if (params.id === "new") {
    return {
      template: null,
      images,
      categories: [...new Set(STARTER_TEMPLATES.map((t) => t.category))],
    };
  }
  const template = await prisma.illustrationTemplate.findFirst({
    where: { id: params.id, shop },
    include: { exampleImage: { select: { id: true, name: true, cdnUrl: true } } },
  });
  if (!template) throw new Response("Template not found", { status: 404 });
  const drawnCount = await prisma.illustrationImage.count({
    where: { shop, templateId: template.id },
  });
  const starter = STARTER_TEMPLATES.find((s) => s.seedKey === template.seedKey) ?? null;
  return {
    template: {
      id: template.id,
      name: template.name,
      category: template.category,
      whenToUse: template.whenToUse,
      instructions: template.instructions,
      shape: template.shape,
      archived: template.archived,
      starter: template.seedKey !== null,
      starterDiffers:
        starter !== null &&
        (starter.name !== template.name ||
          starter.category !== template.category ||
          starter.whenToUse !== template.whenToUse ||
          starter.instructions !== template.instructions ||
          starter.shape !== template.shape),
      exampleImage: template.exampleImage,
      drawnCount,
    },
    images,
    categories: [...new Set(STARTER_TEMPLATES.map((t) => t.category))],
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const isNew = params.id === "new";
  const existing = isNew
    ? null
    : await prisma.illustrationTemplate.findFirst({ where: { id: params.id, shop } });
  if (!isNew && !existing) throw new Response("Template not found", { status: 404 });

  if (intent === "save") {
    const name = String(formData.get("name") ?? "").trim().slice(0, MAX_NAME);
    const category = String(formData.get("category") ?? "").trim().slice(0, MAX_CATEGORY);
    const whenToUse = String(formData.get("whenToUse") ?? "").trim().slice(0, MAX_WHEN);
    const instructions = String(formData.get("instructions") ?? "").trim().slice(0, MAX_INSTRUCTIONS);
    const shape = normalizeIllustrationShape(String(formData.get("shape") ?? ""));
    const exampleImageIdRaw = String(formData.get("exampleImageId") ?? "").trim();
    if (!name) return { ok: false as const, intent, error: "The template needs a name." };
    if (!category) return { ok: false as const, intent, error: "Give the template a category (one or two words)." };
    if (!whenToUse) return { ok: false as const, intent, error: "Describe when to use this template: that is what the recommender reads." };
    if (!instructions) return { ok: false as const, intent, error: "The drawing instructions cannot be empty." };
    let exampleImageId: string | null = null;
    if (exampleImageIdRaw) {
      const image = await prisma.illustrationImage.findFirst({
        where: { id: exampleImageIdRaw, shop },
        select: { id: true },
      });
      exampleImageId = image?.id ?? null;
    }
    const data = { name, category, whenToUse, instructions, shape, exampleImageId };
    if (isNew) {
      const count = await prisma.illustrationTemplate.count({ where: { shop } });
      const created = await prisma.illustrationTemplate.create({
        data: { shop, ...data, sortOrder: count },
      });
      return redirect(`/app/templates/${created.id}`);
    }
    await prisma.illustrationTemplate.update({ where: { id: existing!.id }, data });
    return { ok: true as const, intent, error: null };
  }

  if (intent === "archive" || intent === "unarchive") {
    if (!existing) return { ok: false as const, intent, error: "Save the template first." };
    await prisma.illustrationTemplate.update({
      where: { id: existing.id },
      data: { archived: intent === "archive" },
    });
    return { ok: true as const, intent, error: null };
  }

  if (intent === "reset") {
    const starter = existing
      ? STARTER_TEMPLATES.find((s) => s.seedKey === existing.seedKey)
      : undefined;
    if (!existing || !starter) {
      return { ok: false as const, intent, error: "Only starter templates can be reset." };
    }
    await prisma.illustrationTemplate.update({
      where: { id: existing.id },
      data: {
        name: starter.name,
        category: starter.category,
        whenToUse: starter.whenToUse,
        instructions: starter.instructions,
        shape: starter.shape,
      },
    });
    return { ok: true as const, intent, error: null };
  }

  if (intent === "delete") {
    if (!existing) return { ok: false as const, intent, error: "Nothing to delete." };
    if (existing.seedKey !== null) {
      return { ok: false as const, intent, error: "Starter templates can be archived, not deleted." };
    }
    // Drawn images keep their prompt text; only the link to the template goes.
    await prisma.illustrationTemplate.delete({ where: { id: existing.id } });
    return redirect("/app/templates");
  }
  return { ok: false as const, intent, error: "Unknown action." };
};

export default function TemplateEdit() {
  const { template, images, categories } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState(template?.category ?? categories[0] ?? "Mechanism");
  const [whenToUse, setWhenToUse] = useState(template?.whenToUse ?? "");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [shape, setShape] = useState(template?.shape ?? "landscape");
  const [exampleImage, setExampleImage] = useState<{ id: string; name: string; cdnUrl: string } | null>(
    template?.exampleImage ?? null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (!actionData?.ok) return;
    if (actionData.intent === "save") shopify.toast.show("Template saved");
    if (actionData.intent === "archive") shopify.toast.show("Template archived");
    if (actionData.intent === "unarchive") shopify.toast.show("Template restored");
    if (actionData.intent === "reset") shopify.toast.show("Starter text restored");
  }, [actionData, shopify]);

  // A reset rewrites the stored text; mirror it into the form.
  useEffect(() => {
    if (template) {
      setName(template.name);
      setCategory(template.category);
      setWhenToUse(template.whenToUse);
      setInstructions(template.instructions);
      setShape(template.shape);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.name, template?.category, template?.whenToUse, template?.instructions, template?.shape]);

  const handleSave = useCallback(() => {
    submit(
      {
        intent: "save",
        name,
        category,
        whenToUse,
        instructions,
        shape,
        exampleImageId: exampleImage?.id ?? "",
      },
      { method: "POST" },
    );
  }, [name, category, whenToUse, instructions, shape, exampleImage, submit]);

  const error = actionData && !actionData.ok ? actionData.error : null;
  const secondaryActions = template
    ? [
        template.archived
          ? { content: "Un-archive", onAction: () => submit({ intent: "unarchive" }, { method: "POST" }) }
          : { content: "Archive", onAction: () => submit({ intent: "archive" }, { method: "POST" }) },
        ...(template.starter
          ? [
              {
                content: "Reset to starter text",
                disabled: !template.starterDiffers,
                onAction: () => submit({ intent: "reset" }, { method: "POST" }),
              },
            ]
          : [{ content: "Delete", destructive: true, onAction: () => setConfirmDelete(true) }]),
      ]
    : [];

  return (
    <Page
      title={template ? template.name : "New template"}
      backAction={{ url: "/app/templates" }}
      primaryAction={{ content: "Save", onAction: handleSave, loading: isSubmitting }}
      secondaryActions={secondaryActions}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {error && (
              <Banner tone="critical" title="Not saved">
                {error}
              </Banner>
            )}
            {template && (
              <InlineStack gap="100">
                {template.starter && <Badge tone="info">Starter template</Badge>}
                {template.archived && <Badge tone="attention">Archived</Badge>}
                <Badge>{`${template.drawnCount} image${template.drawnCount === 1 ? "" : "s"} drawn with it`}</Badge>
              </InlineStack>
            )}
            <Card>
              <BlockStack gap="400">
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                  <TextField label="Name" value={name} onChange={setName} autoComplete="off" maxLength={MAX_NAME} />
                  <TextField
                    label="Category"
                    value={category}
                    onChange={setCategory}
                    autoComplete="off"
                    maxLength={MAX_CATEGORY}
                    helpText={`Existing: ${categories.join(", ")}`}
                  />
                  <Select
                    label="Shape"
                    options={[
                      { label: "Landscape (3:2)", value: "landscape" },
                      { label: "Square", value: "square" },
                      { label: "Portrait (2:3)", value: "portrait" },
                    ]}
                    value={shape}
                    onChange={setShape}
                  />
                </InlineGrid>
                <TextField
                  label="When to use"
                  value={whenToUse}
                  onChange={setWhenToUse}
                  multiline={3}
                  autoComplete="off"
                  maxLength={MAX_WHEN}
                  helpText="This is what Claude reads when it recommends a template for a section. Say what kind of content the template suits and give an example or two."
                />
                <TextField
                  label="Drawing instructions"
                  value={instructions}
                  onChange={setInstructions}
                  multiline={8}
                  autoComplete="off"
                  maxLength={MAX_INSTRUCTIONS}
                  helpText="Sent to the image model before the specific prompt: style, palette, composition, what to exclude. The language of the labels is added automatically per page."
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Example image (optional)
                </Text>
                <InlineStack gap="300" blockAlign="center" wrap>
                  {exampleImage && (
                    <Thumbnail source={thumbnailUrl(exampleImage.cdnUrl)} alt="" size="large" />
                  )}
                  <Text as="span" tone={exampleImage ? undefined : "subdued"}>
                    {exampleImage ? exampleImage.name : "None chosen"}
                  </Text>
                  <Button onClick={() => setPickerOpen(true)}>
                    {exampleImage ? "Change" : "Choose from the library"}
                  </Button>
                  {exampleImage && (
                    <Button variant="plain" onClick={() => setExampleImage(null)}>
                      Remove
                    </Button>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Shown to your team as a reference for the style; not sent to
                  the image model.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
      <ImagePickerModal
        open={pickerOpen}
        images={images}
        onPick={(image) => {
          setExampleImage({ id: image.id, name: image.name, cdnUrl: image.cdnUrl });
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this template?"
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
            Images already drawn with it keep their prompts. Pages that chose
            this template at creation time but have not generated yet will
            draw nothing.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
