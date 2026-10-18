import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { aiEnabled } from "@/lib/flags";
import { rateLimit } from "@/lib/ratelimit";

const SYSTEM = `You answer questions about a reader's documents using only the numbered passages given.
Write one to three plain sentences a business reader understands at a glance; no jargon, no preamble.
After each sentence, cite the passages it rests on like [2] or [1][3]. Only cite passages that support the sentence.
If the passages do not contain the answer, say in one sentence that the documents do not cover it, and do not guess.
State the facts directly, as the document would. Never write "the passages say", "the documents mention", "based on the sources" or anything about passages, chunks, search or yourself.`;

type Passage = { n: number; text: string; document_name: string; page: number };

/** A short answer written from the passages the search found, with citations. */
export async function POST(req: Request) {
  const limited = rateLimit(req, "answer", 20, 60_000);
  if (limited) return limited;
  // With generative AI switched off nothing here runs, whoever calls it.
  if (!aiEnabled) return NextResponse.json({ error: "Written answers are switched off." }, { status: 404 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "Answers are not configured." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { query?: string; passages?: Passage[] };
  const query = (body.query ?? "").trim().slice(0, 500);
  const passages = (body.passages ?? []).slice(0, 8).filter((p) => typeof p.text === "string" && p.text.trim());
  if (!query || !passages.length) return NextResponse.json({ error: "Nothing to answer from." }, { status: 400 });

  const user = `Question: ${query}\n\nPassages:\n\n` + passages
    .map((p) => `[${p.n}] (${p.document_name}, page ${p.page})\n${p.text.replace(/\s+/g, " ").trim().slice(0, 2000)}`)
    .join("\n\n");
  try {
    const client = new Anthropic();
    // Thinking is off: the model thinks by default and a few hundred tokens of it would use up this short budget, leaving no answer at all.
    const msg = await client.messages.create({ model: "claude-haiku-5-5", max_tokens: 400, thinking: { type: "disabled" }, system: SYSTEM, messages: [{ role: "user", content: user }] });
    const answer = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return NextResponse.json({ answer });
  } catch {
    return NextResponse.json({ error: "The answer could not be written right now." }, { status: 502 });
  }
}
