// A minimal, dependency-free Markdown renderer for LLM answers. Every
// piece of text becomes a React text node (never dangerouslySetInnerHTML),
// so arbitrary model output can never inject HTML or scripts - worst case
// an unsupported construct just renders as plain text.
import type { ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) nodes.push(<strong key={`${keyPrefix}-${i}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) nodes.push(<code key={`${keyPrefix}-${i}`}>{token.slice(1, -1)}</code>);
    else nodes.push(<em key={`${keyPrefix}-${i}`}>{token.slice(1, -1)}</em>);
    lastIndex = pattern.lastIndex;
    i++;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const NUMBERED_RE = /^\d+\.\s+(.*)$/;

export function renderMarkdownLite(text: string): ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const key = blockKey++;
      // Demoted one level so an answer's headings never outrank the modal's own <h2>.
      const size = Math.min(heading[1].length + 1, 5);
      blocks.push(
        <div key={key} className={`ask-heading ask-heading-${size}`}>
          {renderInline(heading[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        items.push(BULLET_RE.exec(lines[i])![1]);
        i++;
      }
      const key = blockKey++;
      blocks.push(
        <ul key={key}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `li${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (NUMBERED_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && NUMBERED_RE.test(lines[i])) {
        items.push(NUMBERED_RE.exec(lines[i])![1]);
        i++;
      }
      const key = blockKey++;
      blocks.push(
        <ol key={key}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `oli${key}-${idx}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !HEADING_RE.test(lines[i]) && !BULLET_RE.test(lines[i]) && !NUMBERED_RE.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    const key = blockKey++;
    blocks.push(<p key={key}>{renderInline(paraLines.join(" "), `p${key}`)}</p>);
  }

  return <>{blocks}</>;
}
