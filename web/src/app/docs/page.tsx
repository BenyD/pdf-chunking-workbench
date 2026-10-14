import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DOCUMENTATION_MD } from "@/content/documentation";
import { Panel } from "@/components/Panel";

export const metadata = { title: "Documentation" };

export default function DocsPage() {
  return (
    <Panel className="mx-auto max-w-3xl" bodyClassName="px-5 py-4 sm:px-8 sm:py-6">
      <article className="prose-md text-[15px]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{DOCUMENTATION_MD}</ReactMarkdown>
      </article>
    </Panel>
  );
}
