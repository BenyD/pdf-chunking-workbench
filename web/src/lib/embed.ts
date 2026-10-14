/**
 * Query-side embedding. Documents are embedded by the worker with
 * input_type "document"; queries must use input_type "query" so the model
 * applies the matching instruction prefix.
 *
 * Returns null when no key is configured or the provider stays unreachable or
 * rate limited after a few retries; search then runs on keywords only rather
 * than failing.
 */
export async function embedQuery(text: string): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  let delay = 2000;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          input: [text],
          model: process.env.EMBEDDING_MODEL ?? "voyage-4",
          input_type: "query",
          output_dimension: 1024,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      // a connect timeout or a dropped socket: keyword search must still answer
      console.warn(`voyage: ${String(e)}; retrying`);
      await new Promise((r) => setTimeout(r, Math.min(delay, 8000)));
      delay = Math.min(delay * 2, 30000);
      continue;
    }
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
  console.warn("voyage: unavailable after retries, falling back to keyword search");
  return null;
}
