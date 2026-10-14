import { NextResponse } from "next/server";
import { worker } from "@/lib/worker";

type Ctx = { params: Promise<{ id: string }> };

/** Ask the worker to (re)write question suggestions for a document. */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    return NextResponse.json(await worker("/suggest", { document_id: id }));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
