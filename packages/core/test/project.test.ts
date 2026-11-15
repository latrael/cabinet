import { describe, expect, test } from 'vitest';
import {
  addEntry,
  addSection,
  moveEntry,
  parseProject,
  removeEntry,
  removeSection,
  setEntryContext,
  writeChecklist,
  writeMaterial,
  writeQuestions,
} from '../src/project.ts';

const BODY = `Intro text stays.

## Material
### Lighting
- [[japanese-listening-rooms]]: the low warm light is the feeling I want
- [[paper-lamp-photo]]
### To buy
- [[akari-lamp]]: check sizes first
## Questions
- How much sound dampening does a reading corner need?
## Checklist
- [ ] Measure the corner
`;

describe('project body', () => {
  test('parses the plan example', () => {
    const p = parseProject(BODY);
    expect(p.material.map((s) => s.name)).toEqual(['Lighting', 'To buy']);
    expect(p.material[0].lines).toEqual([
      { kind: 'item', target: 'japanese-listening-rooms', alias: undefined, context: 'the low warm light is the feeling I want' },
      { kind: 'item', target: 'paper-lamp-photo', alias: undefined, context: undefined },
    ]);
    expect(p.questions).toEqual(['How much sound dampening does a reading corner need?']);
    expect(p.checklist).toEqual([{ done: false, text: 'Measure the corner' }]);
  });

  test('reorder and move between sections rewrites the list in place', () => {
    let m = parseProject(BODY).material;
    m = moveEntry(m, 'paper-lamp-photo', 'Lighting', 0);
    m = moveEntry(m, 'akari-lamp', 'Lighting', 1);
    const out = writeMaterial(BODY, m);
    expect(out).toBe(`Intro text stays.

## Material
### Lighting
- [[paper-lamp-photo]]
- [[akari-lamp]]: check sizes first
- [[japanese-listening-rooms]]: the low warm light is the feeling I want

### To buy

## Questions
- How much sound dampening does a reading corner need?
## Checklist
- [ ] Measure the corner
`);
    expect(parseProject(out).questions).toHaveLength(1);
  });

  test('add, context, remove, sections', () => {
    let m = parseProject(BODY).material;
    m = addSection(m, 'Inspiration');
    m = addEntry(m, 'new-item', { section: 'Inspiration', context: 'because' });
    m = setEntryContext(m, 'paper-lamp-photo', 'glow reference');
    m = removeEntry(m, 'akari-lamp');
    m = removeSection(m, 'To buy');
    const p = parseProject(writeMaterial(BODY, m));
    expect(p.material.map((s) => s.name)).toEqual(['Lighting', 'Inspiration']);
    expect(p.material[0].lines[1]).toMatchObject({ target: 'paper-lamp-photo', context: 'glow reference' });
    expect(p.material[1].lines[0]).toMatchObject({ target: 'new-item', context: 'because' });
  });

  test('adding the same item twice does not duplicate it', () => {
    let m = parseProject(BODY).material;
    m = addEntry(m, 'paper-lamp-photo', { context: 'updated' });
    expect(m.flatMap((s) => s.lines).filter((l) => l.kind === 'item' && l.target === 'paper-lamp-photo')).toHaveLength(1);
  });

  test('creates Material/Questions/Checklist in a bare project body', () => {
    let b = 'Just an intent.\n';
    b = writeChecklist(b, [{ done: true, text: 'Start' }]);
    b = writeMaterial(b, addEntry([], 'x', { section: 'Refs' }));
    b = writeQuestions(b, ['Why?']);
    expect(b).toBe('Just an intent.\n\n## Material\n### Refs\n- [[x]]\n\n## Questions\n- Why?\n\n## Checklist\n- [x] Start\n');
  });

  test('keeps non-link text lines inside material', () => {
    const b = '## Material\n### A\n- [[w]]\nSome loose note\n- [[x]]: y\n';
    const m = moveEntry(parseProject(b).material, 'x', 'A', 0);
    expect(writeMaterial(b, m)).toBe('## Material\n### A\n- [[x]]: y\n- [[w]]\nSome loose note\n');
  });
});
