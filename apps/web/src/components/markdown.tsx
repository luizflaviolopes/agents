"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Renders agent-authored markdown — task results, chat replies, verdicts.
 *
 * Agents write markdown by default (headings, bullets, tables, fenced code),
 * and the platform used to print it verbatim in a `whitespace-pre-wrap` block,
 * which made a structured review read like a wall of asterisks.
 *
 * Two deliberate constraints:
 *
 * - **No raw HTML.** react-markdown ignores embedded HTML unless `rehype-raw`
 *   is added, and it is not added here on purpose. Everything rendered through
 *   this component was written by an LLM that reads untrusted text — pull
 *   request descriptions, ticket bodies, issue comments — so treating its
 *   output as markup would hand a prompt injection a rendering primitive.
 * - **No typography plugin.** The project styles Tailwind v4 with its own
 *   tokens and does not ship `@tailwindcss/typography`, so the element map
 *   below is the style sheet. Sizes inherit from the caller (`text-sm` in a
 *   chat bubble, the same in a result panel) rather than being fixed here.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-3 leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

type Components = React.ComponentProps<typeof ReactMarkdown>["components"];

const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 text-sm font-semibold text-muted-foreground first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  // Fenced blocks arrive as <pre><code>; inline code does not. Styling the
  // `pre` wrapper and letting the inner `code` inherit avoids the doubled
  // background that a single shared rule produces.
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const fenced = /language-/.test(className ?? "");
    if (fenced) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
  // Wide tables scroll inside their own container rather than stretching the
  // dialog they sit in.
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-left text-xs">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-border px-2.5 py-1.5 font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
};
