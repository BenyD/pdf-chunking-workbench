import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DOCUMENTATION_MD } from "@/content/documentation";

export const metadata = { title: "Documentation" };

export default function DocsPage() {
  return (
    <article className="prose-md mx-auto max-w-3xl rounded-xl border bg-card px-5 py-4 text-[15px] sm:px-8 sm:py-6">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{DOCUMENTATION_MD}</ReactMarkdown>
    </article>
  );
}
