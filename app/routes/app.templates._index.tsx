import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link as RemixLink, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  ensureStarterTemplates,
  listTemplates,
} from "../services/illustration-templates.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await ensureStarterTemplates(session.shop);
  const templates = await listTemplates(session.shop, { includeArchived: true });
  return {
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      whenToUse: t.whenToUse,
      shape: t.shape,
      starter: t.seedKey !== null,
      archived: t.archived,
    })),
  };
};

export default function Templates() {
  const { templates } = useLoaderData<typeof loader>();
  const active = templates.filter((t) => !t.archived);
  const archived = templates.filter((t) => t.archived);
  return (
    <Page
      title="Illustration templates"
      backAction={{ url: "/app" }}
      primaryAction={{ content: "New template", url: "/app/templates/new" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd" tone="subdued">
                  A template is a reusable drawing style. Its category and
                  "when to use" note are what Claude reads to recommend one for
                  a section; its instructions are added in front of the
                  specific prompt of every image drawn with it. Edit the
                  starter set freely; archive what you never use.
                </Text>
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Active
                </Text>
                {active.length === 0 && (
                  <Text as="p" tone="subdued">
                    No active templates. Add one, or un-archive one below.
                  </Text>
                )}
                {active.map((t) => (
                  <TemplateRow key={t.id} template={t} />
                ))}
              </BlockStack>
            </Card>
            {archived.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Archived
                  </Text>
                  {archived.map((t) => (
                    <TemplateRow key={t.id} template={t} />
                  ))}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function TemplateRow({
  template,
}: {
  template: {
    id: string;
    name: string;
    category: string;
    whenToUse: string;
    shape: string;
    starter: boolean;
    archived: boolean;
  };
}) {
  return (
    <Box borderColor="border" borderWidth="025" borderRadius="200" padding="300">
      <BlockStack gap="150">
        <InlineStack gap="200" blockAlign="center" wrap>
          <RemixLink to={`/app/templates/${template.id}`}>
            <Text as="span" variant="headingSm">
              {template.name}
            </Text>
          </RemixLink>
          <Badge>{template.category}</Badge>
          <Badge>{template.shape}</Badge>
          {template.starter && <Badge tone="info">Starter</Badge>}
          {template.archived && <Badge tone="attention">Archived</Badge>}
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          {template.whenToUse}
        </Text>
      </BlockStack>
    </Box>
  );
}
