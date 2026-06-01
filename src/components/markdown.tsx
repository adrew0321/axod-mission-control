"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders agent message markdown with the app's dark palette: cyan links,
// pill-styled inline code, fenced code blocks, lists, tables (GFM), etc.
// react-markdown sanitizes by default (no raw HTML), so this is safe for
// model output.
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="text-xs leading-relaxed text-[#c9d1d9] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-[#00e0ff] underline decoration-[#00e0ff]/30 hover:decoration-[#00e0ff] transition-colors"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-[#e6edf3]">{children}</strong>,
          em: ({ children }) => <em className="italic text-[#b9c2cc]">{children}</em>,
          ul: ({ children }) => <ul className="list-disc pl-4 my-1.5 space-y-0.5 marker:text-[#5c6470]">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-4 my-1.5 space-y-0.5 marker:text-[#5c6470]">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => (
            <h1 className="text-sm font-bold text-[#e6edf3] font-heading mt-3 mb-1.5">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-[13px] font-bold text-[#e6edf3] font-heading mt-3 mb-1.5">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xs font-semibold text-[#e6edf3] uppercase tracking-wide mt-2.5 mb-1">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[#00e0ff]/30 pl-3 my-1.5 text-[#8b949e] italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-[#1e2632]" />,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return <code className="font-mono text-[11px] text-[#c9d1d9]">{children}</code>;
            }
            return (
              <code className="bg-[#161c25] border border-[#2a3441] text-cyan-300 px-1 py-0.5 rounded text-[10.5px] font-mono">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="bg-[#060810] border border-[#1e2632] rounded-md p-2.5 my-2 overflow-x-auto">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="border-collapse text-[11px] w-full">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[#2a3441] bg-[#161c25] px-2 py-1 text-left font-semibold text-[#e6edf3]">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border border-[#1e2632] px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
