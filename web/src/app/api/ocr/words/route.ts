import { NextResponse } from "next/server";
import { worker } from "@/lib/worker";

/** OCR'd words with positions, used by the template designer to suggest anchors. */
export async function POST(req: Request) {
  const body = (await req.json()) as { document_id: string; page_number?: number };
  try {
    return NextResponse.json(await worker("/ocr/words", { document_id: body.document_id, page_number: body.page_number ?? 1 }));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
