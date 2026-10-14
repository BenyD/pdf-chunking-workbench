import ReactMarkdown from "react-markdown";
import { DECISIONS_MD } from "@/content/decisions";

export default function DecisionsPage() {
  return (
    <article className="prose-md mx-auto max-w-3xl rounded-xl border bg-card px-5 py-4 text-[15px] sm:px-8 sm:py-6">
      <ReactMarkdown>{DECISIONS_MD}</ReactMarkdown>
    </article>
  );
}
