import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  getPreamble,
  getSection,
  parseMarkdown,
  serializeMarkdown,
  setPreamble,
  setSection,
  splitNotesAndContent,
  toPlainText,
} from '../src/format.ts';
import { SAMPLE } from './helpers.ts';

describe('frontmatter round-trip', () => {
  test('serialize → parse → serialize is stable', () => {
    const fm = {
      id: '01JD0000000000000000000000',
      type: 'article',
      title: 'A title: with a colon',
      status: 'inbox',
      created: '2026-11-14T10:00:00Z',
      updated: '2026-11-14T10:00:00Z',
      why: '[[reading-corner]] is why',
      tags: ['a', 'b-c'],
      source: { url: 'https://example.com/x?y=1#z', author: 'Someone' },
      custom_key: { nested: true },
    };
    const body = 'Hello [[world]].\n\n## Content\nText.\n';
    const text = serializeMarkdown(fm, body);
    const parsed = parseMarkdown(text);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe(body);
    expect(serializeMarkdown(parsed.frontmatter, parsed.body)).toBe(text);
  });

  test('every sample file is already canonical (byte-identical round-trip)', () => {
    for (const folder of ['notes', 'sources', 'projects', 'collections', 'memories']) {
      for (const f of readdirSync(join(SAMPLE, folder))) {
        const text = readFileSync(join(SAMPLE, folder, f), 'utf8');
        const p = parseMarkdown(text);
        expect(serializeMarkdown(p.frontmatter, p.body), `${folder}/${f}`).toBe(text);
      }
    }
  });

  test('canonical key order, unknown keys preserved after known ones', () => {
    const text = serializeMarkdown({ zzz: 1, title: 'T', id: 'X', type: 'note', created: 'c', updated: 'u' }, '');
    expect(text).toBe('---\nid: X\ntype: note\ntitle: T\ncreated: c\nupdated: u\nzzz: 1\n---\n');
  });

  test('tolerates missing or broken frontmatter and CRLF', () => {
    expect(parseMarkdown('# Just a note\r\nbody').body).toBe('# Just a note\nbody');
    expect(parseMarkdown('---\n: : bad yaml [\n---\nbody\n').frontmatter).toEqual({});
    expect(parseMarkdown('---\ntitle: x\n---\n').body).toBe('');
  });
});

describe('sections', () => {
  const body = 'My notes about [[x]].\n\n## Content\nArticle text.\n\n```\n## not a heading\n```\n\n## Timestamps\n- [01:00](u) a\n';

  test('preamble and sections', () => {
    expect(getPreamble(body)).toBe('My notes about [[x]].');
    expect(getSection(body, 'content')).toBe('Article text.\n\n```\n## not a heading\n```');
    expect(getSection(body, 'Timestamps')).toBe('- [01:00](u) a');
  });

  test('setSection replaces in place and inserts before given headings', () => {
    const b2 = setSection(body, 'Content', 'New text.');
    expect(getSection(b2, 'Content')).toBe('New text.');
    expect(getSection(b2, 'Timestamps')).toBe('- [01:00](u) a');
    const b3 = setSection(body, 'Related', '- [[y]]', { before: ['Content'] });
    expect(b3.indexOf('## Related')).toBeLessThan(b3.indexOf('## Content'));
    expect(setPreamble(body, 'Changed.').startsWith('Changed.\n\n## Content')).toBe(true);
  });

  test('notes vs content split', () => {
    const { notes, content } = splitNotesAndContent(body);
    expect(notes).toBe('My notes about [[x]].');
    expect(content).toContain('Article text.');
    expect(content).toContain('[01:00]');
  });

  test('plain text strips markdown and keeps link labels', () => {
    expect(toPlainText('**Bold** [[a-b|Label]] and [[c]] [x](http://y)')).toBe('Bold Label and c x');
  });
});
