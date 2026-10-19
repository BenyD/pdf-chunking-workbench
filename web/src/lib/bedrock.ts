import "server-only";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";

/** One passage from the Bedrock knowledge base: a 1,500-token parent of the 300-token child that matched. */
export type BedrockHit = { doc: string; text: string; page: number | null; score: number };

let client: BedrockAgentRuntimeClient | null = null;

export function bedrockConfigured(): boolean {
  return !!(process.env.AWS_BEDROCK_KB_ID && process.env.AWS_BEDROCK_ACCESS_KEY_ID && process.env.AWS_BEDROCK_SECRET_ACCESS_KEY);
}

/** Ask the knowledge base, inside one document (by file name) or across all. */
export async function bedrockRetrieve(query: string, doc: string | null, k: number): Promise<BedrockHit[]> {
  client ??= new BedrockAgentRuntimeClient({
    region: process.env.AWS_BEDROCK_REGION ?? "ap-south-1",
    credentials: { accessKeyId: process.env.AWS_BEDROCK_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_BEDROCK_SECRET_ACCESS_KEY! },
  });
  const r = await client.send(new RetrieveCommand({
    knowledgeBaseId: process.env.AWS_BEDROCK_KB_ID!,
    retrievalQuery: { text: query },
    retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: k, ...(doc ? { filter: { equals: { key: "doc", value: doc } } } : {}) } },
  }));
  return (r.retrievalResults ?? []).map((h) => {
    const md = (h.metadata ?? {}) as Record<string, unknown>;
    // the PDFs went in as 8-page parts (scripts/bedrock_kb.py): Bedrock's page is within the part, first_page places it
    const page = md["x-amz-bedrock-kb-document-page-number"];
    const first = Number(md.first_page ?? 1);
    return { doc: String(md.doc ?? ""), text: h.content?.text ?? "", page: page == null ? null : first - 1 + Number(page), score: h.score ?? 0 };
  });
}
