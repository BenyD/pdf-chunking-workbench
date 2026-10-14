/**
 * Query-side embedding. Documents are embedded by the worker with
 * input_type "document"; queries must use input_type "query" so the model
 * applies the matching instruction prefix.
 *
 * Returns null when no key is configured or the provider keeps rate limiting
 * after a few retries; search then runs full-text only rather than failing.
 */
export async function embedQuery(text: string): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  let delay = 2000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        input: [text],
        model: process.env.EMBEDDING_MODEL ?? "voyage-4",
        input_type: "query",
        output_dimension: 1024,
      }),
      cache: "no-store",
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data[0].embedding;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Math.min(retryAfter > 0 ? retryAfter * 1000 : delay, 30000)));
      delay = Math.min(delay * 2, 30000);
      continue;
    }
    throw new Error(`voyage ${res.status}: ${await res.text()}`);
  }
  console.warn("voyage: rate limited after retries, falling back to full-text search");
  return null;
}
