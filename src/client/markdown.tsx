/** 极简 Markdown 渲染：标题、列表、引用、代码块、内联强调。足够 Atlas 的对话使用。 */
import { Fragment, type ReactNode } from 'react'

export interface OutlineItem {
  id: string
  text: string
  level: 2 | 3
}

type Block =
  | { kind: 'h'; level: 2 | 3; text: string; id?: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string; code: string }

export function Markdown({ text, idPrefix }: { text: string; idPrefix?: string }) {
  const blocks = parseBlocks(text)
  let headingIndex = 0

  return (
    <div className="atlas-md">
      {blocks.map((block, index) => {
        if (block.kind === 'h') {
          const id = idPrefix ? `${idPrefix}-h-${headingIndex++}` : undefined
          const Tag = block.level === 2 ? 'h2' : 'h3'
          return (
            <Tag key={index} id={id}>
              {inline(block.text)}
            </Tag>
          )
        }
        if (block.kind === 'p') return <p key={index}>{inline(block.text)}</p>
        if (block.kind === 'quote') return <blockquote key={index}>{inline(block.text)}</blockquote>
        if (block.kind === 'code') {
          return (
            <pre key={index}>
              <code>{block.code}</code>
            </pre>
          )
        }
        const Tag = block.kind
        return (
          <Tag key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{inline(item)}</li>
            ))}
          </Tag>
        )
      })}
    </div>
  )
}

export function extractHeadings(text: string, messageId: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let inCode = false
  let headingIndex = 0
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const matched = /^(#{1,4})\s+(.+)$/.exec(line.trim())
    if (!matched) continue
    const rawLevel = matched[1]!.length
    const index = headingIndex++
    if (rawLevel !== 2 && rawLevel !== 3) continue
    items.push({ id: `${messageId}-h-${index}`, text: matched[2]!.trim(), level: rawLevel })
  }
  return items
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (!trimmed) {
      index++
      continue
    }

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim()
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index]!.trim().startsWith('```')) {
        code.push(lines[index]!)
        index++
      }
      index++
      blocks.push({ kind: 'code', lang, code: code.join('\n') })
      continue
    }

    if (trimmed === '---' || trimmed === '***') {
      blocks.push({ kind: 'p', text: '' })
      index++
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (heading) {
      blocks.push({
        kind: 'h',
        level: heading[1]!.length >= 3 ? 3 : 2,
        text: heading[2]!,
      })
      index++
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!.trim())) {
        items.push(lines[index]!.trim().replace(/^[-*]\s+/, ''))
        index++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!.trim())) {
        items.push(lines[index]!.trim().replace(/^\d+\.\s+/, ''))
        index++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && lines[index]!.trim().startsWith('>')) {
        quote.push(lines[index]!.trim().replace(/^>\s?/, ''))
        index++
      }
      blocks.push({ kind: 'quote', text: quote.join(' ') })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index]!.trim()
      if (
        !next ||
        next.startsWith('```') ||
        next.startsWith('>') ||
        /^(#{1,4})\s+/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break
      }
      paragraph.push(next)
      index++
    }
    blocks.push({ kind: 'p', text: paragraph.join(' ') })
  }

  return blocks
}

function inline(text: string): ReactNode {
  if (!text) return null
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g)
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index}>{part.slice(1, -1)}</code>
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer noopener">
          {link[1]}
        </a>
      )
    }
    return <Fragment key={index}>{part}</Fragment>
  })
}
