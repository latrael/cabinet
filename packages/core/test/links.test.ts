import { describe, expect, test } from 'vitest';
import { extractLinks, linkKey, openLinkQuery, rewriteLinks } from '../src/links.ts';

describe('wikilinks', () => {
  test('extracts links, aliases, headings and embeds', () => {
    const links = extractLinks('See [[a-note]], [[B Note|bee]] and [[c#Section|sea]]. ![[attachments/2026/01/x.png]]');
    expect(links.map((l) => [l.target, l.alias, l.heading, l.embed])).toEqual([
      ['a-note', undefined, undefined, false],
      ['B Note', 'bee', undefined, false],
      ['c', 'sea', 'Section', false],
      ['attachments/2026/01/x.png', undefined, undefined, true],
    ]);
  });

  test('ignores links in code', () => {
    const t = 'Real [[one]]\n```\n[[fake]]\n```\nand `[[inline]]` and [[two]]';
    expect(extractLinks(t).map((l) => l.target)).toEqual(['one', 'two']);
  });

  test('link keys normalize case, folders and .md', () => {
    expect(linkKey('Notes/My Note.md')).toBe('my note');
    expect(linkKey('  Reading-Corner ')).toBe('reading-corner');
  });

  test('rewrite keeps alias and heading', () => {
    const r = rewriteLinks('[[old]] [[Old Title|x]] [[old#h]] [[other]] ![[old]]', ['old', 'Old Title'], 'new');
    expect(r.text).toBe('[[new]] [[new|x]] [[new#h]] [[other]] ![[old]]');
    expect(r.count).toBe(3);
  });

  test('open link query for autocomplete', () => {
    expect(openLinkQuery('hello [[wor', 11)).toEqual({ from: 8, query: 'wor' });
    expect(openLinkQuery('hello [[done]] x', 16)).toBeNull();
  });
});
