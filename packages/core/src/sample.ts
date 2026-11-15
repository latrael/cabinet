// Deterministic synthetic sample library used for development, tests and screenshots.
// All content is invented for this project.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentsMd, libraryGitignore } from './agents-md.ts';
import { defaultConfig } from './config.ts';
import { serializeMarkdown } from './format.ts';
import { sha1 } from './ids.ts';
import { breadImage, counterImage, lampImage, simplePdf } from './sample-assets.ts';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped id with a real timestamp and a random part derived from the slug. */
export function fixedId(iso: string, slug: string): string {
  let ms = Date.parse(iso);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const h = sha1(slug);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[parseInt(h.slice(i * 2, i * 2 + 2), 16) % 32];
  return time + rand;
}

interface Spec {
  folder: string;
  slug: string;
  fm: Record<string, unknown>;
  body: string;
}

export function sampleSpecs(): Spec[] {
  const specs: Spec[] = [];
  const add = (folder: string, slug: string, created: string, fm: Record<string, unknown>, body: string, updated?: string) => {
    specs.push({
      folder,
      slug,
      fm: { id: fixedId(created, slug), ...fm, created, updated: updated ?? created },
      body,
    });
  };

  // ---------------------------------------------------------------- sources
  add(
    'sources',
    'japanese-listening-rooms',
    '2026-06-02T19:20:00Z',
    {
      type: 'article',
      title: 'Japanese listening rooms',
      status: 'library',
      why: 'The low warm light is exactly the feeling I want for the [[reading-corner]].',
      tags: ['audio', 'interiors', 'japan'],
      collections: ['Listening rooms'],
      source: { url: 'https://journal.example.org/listening-rooms', author: 'M. Arai', site: 'The Quiet Journal', published: '2026-05-28' },
      captured_via: 'web',
      cover: 'attachments/2026/06/01hx-counter.png',
      extraction: 'ok',
    },
    `Re-read this when choosing bulbs. The bit about "a room that lowers its voice" stuck with me.

## Content
In a narrow street behind the station, a door with no sign opens onto a room the size of a train carriage. A wall of records, two large horn speakers, and a counter of dark cedar. Nobody talks above a murmur.

These listening rooms grew out of the jazz kissa of the 1950s, when records were expensive and a café with a good system was the only place to hear them properly. The owners curated the night: one side of an album, start to finish, no skipping.

What makes them feel calm is less the equipment than the light. Lamps sit low, below eye level, and their light is warm — closer to candlelight than to an office. Paper shades soften the edges. Shadows are allowed to stay in the corners.

Sound matters too. Shelves of records break up reflections; heavy curtains and a rug take the edge off the room. The result is a space that lowers its voice, and invites you to do the same.
`,
  );

  add(
    'sources',
    'paper-lamp-photo',
    '2026-06-05T08:10:00Z',
    {
      type: 'image',
      title: 'Paper lamp in a dim room',
      status: 'library',
      why: 'Reference for the light temperature I want.',
      tags: ['lighting', 'interiors'],
      collections: ['Warm light'],
      attachment: 'attachments/2026/06/01hy-paper-lamp.png',
      cover: 'attachments/2026/06/01hy-paper-lamp.png',
      captured_via: 'telegram',
    },
    `Taken at a friend's flat. Note how the shade glows rather than shines.

![[attachments/2026/06/01hy-paper-lamp.png]]
`,
  );

  add(
    'sources',
    'akari-style-floor-lamp',
    '2026-06-09T12:00:00Z',
    {
      type: 'link',
      title: 'Paper lantern floor lamp, 120 cm',
      status: 'library',
      why: 'Candidate for the corner. Check the height against the armchair.',
      tags: ['lighting', 'to-buy'],
      source: { url: 'https://shop.example.com/lamps/paper-lantern-120', site: 'Example Lamp Shop' },
      captured_via: 'web',
      extraction: 'ok',
    },
    `## Content
Hand-made mulberry paper shade on a bamboo frame. 120 cm tall, 45 cm diameter. Takes an E27 bulb; we recommend 2200–2700 K.
`,
  );

  add(
    'sources',
    'room-acoustics-primer',
    '2026-07-14T21:00:00Z',
    {
      type: 'pdf',
      title: 'A primer on small-room acoustics',
      status: 'library',
      why: 'Answers how much dampening a small reading corner actually needs.',
      tags: ['audio', 'acoustics'],
      collections: ['Listening rooms'],
      attachment: 'attachments/2026/07/01j2-room-acoustics-primer.pdf',
      captured_via: 'web',
      extraction: 'ok',
    },
    `Page 2 has the rule of thumb about covering 20–30% of wall area.

## Content
Small rooms have three problems: early reflections, flutter echo between parallel walls, and uneven bass.
Early reflections are best handled at the first reflection points with soft panels or bookshelves.
Flutter echo disappears once one of two parallel walls is broken up, by shelves, curtains or art.
Bass is hard. Corner placement of soft furniture helps a little; bass traps help more.
Rule of thumb: treat 20 to 30 percent of the wall area, and use a thick rug on hard floors.
A reading corner rarely needs panels. A full bookshelf and a heavy curtain usually suffice.
`,
  );

  add(
    'sources',
    'how-a-record-is-cut',
    '2026-07-02T18:30:00Z',
    {
      type: 'video',
      title: 'How a lacquer master is cut',
      status: 'library',
      why: 'Lovely, patient craft. The part about groove spacing is the best explanation I have seen.',
      tags: ['audio', 'vinyl', 'craft'],
      collections: ['Listening rooms'],
      source: { url: 'https://www.youtube.com/watch?v=Xq3vR8cLp2A', author: 'Groove Workshop', site: 'YouTube' },
      captured_via: 'web',
      extraction: 'ok',
    },
    `## Timestamps
- [01:05](https://youtu.be/Xq3vR8cLp2A?t=65) the lathe and the cutting head
- [04:12](https://youtu.be/Xq3vR8cLp2A?t=252) groove spacing and why loud records are shorter
- [09:40](https://youtu.be/Xq3vR8cLp2A?t=580) checking the lacquer under the microscope
`,
  );

  add(
    'sources',
    'morris-useful-beautiful',
    '2026-06-20T07:45:00Z',
    {
      type: 'quote',
      title: 'Useful or beautiful',
      status: 'library',
      tags: ['interiors', 'quotes'],
      source: { author: 'William Morris', published: '1880' },
      captured_via: 'web',
    },
    `> Have nothing in your houses that you do not know to be useful, or believe to be beautiful.

A good filter for what goes in the corner.
`,
  );

  add(
    'sources',
    'listening-bar-counter',
    '2026-08-01T22:15:00Z',
    {
      type: 'image',
      title: 'Listening bar counter',
      status: 'library',
      tags: ['audio', 'interiors', 'japan'],
      collections: ['Listening rooms'],
      attachment: 'attachments/2026/06/01hx-counter.png',
      cover: 'attachments/2026/06/01hx-counter.png',
      captured_via: 'telegram',
    },
    `Cedar counter, records as the back wall.

![[attachments/2026/06/01hx-counter.png]]
`,
  );

  add(
    'sources',
    'record-fair-notes',
    '2026-09-07T15:00:00Z',
    {
      type: 'text',
      title: 'Notes from the September record fair',
      status: 'library',
      tags: ['vinyl'],
      captured_via: 'telegram',
    },
    `Stall 14 had a box of Japanese pressings, all with obi. Ask about the ambient ones next time.
Bought: one Hiroshi-style ambient reissue, one jazz trio live record. The seller recommended washing records with a drop of surfactant and distilled water.
`,
  );

  add(
    'sources',
    'single-tasking',
    '2026-08-18T06:30:00Z',
    {
      type: 'article',
      title: 'The case for single-tasking',
      status: 'library',
      why: 'Why the corner should have no screens.',
      tags: ['attention', 'reading'],
      source: { url: 'https://essays.example.net/single-tasking', author: 'R. Okafor', site: 'Slow Essays' },
      captured_via: 'web',
      extraction: 'ok',
    },
    `## Content
Attention is not a muscle you train once; it is a habit of place. We read deeply where we have read deeply before.
A chair that is only for reading becomes a cue. Sit there, and the phone feels out of place.
The trick is to make one spot in the house that asks for one thing.
`,
  );

  add(
    'sources',
    'sourdough-hydration',
    '2026-07-21T09:00:00Z',
    {
      type: 'link',
      title: 'Sourdough hydration calculator',
      status: 'library',
      tags: ['baking', 'sourdough'],
      source: { url: 'https://bread.example.com/hydration', site: 'Bread Notes' },
      captured_via: 'web',
      extraction: 'failed',
    },
    `Useful for scaling the 75% loaf.
`,
  );

  add(
    'sources',
    'open-crumb-photo',
    '2026-07-25T10:00:00Z',
    {
      type: 'image',
      title: 'Open crumb, loaf #6',
      status: 'library',
      tags: ['baking', 'sourdough'],
      attachment: 'attachments/2026/07/01j3-crumb.png',
      cover: 'attachments/2026/07/01j3-crumb.png',
      captured_via: 'telegram',
    },
    `Best one so far. 76% hydration, 18 h cold retard.

![[attachments/2026/07/01j3-crumb.png]]
`,
  );

  add(
    'sources',
    'wabi-sabi-small-spaces',
    '2026-11-10T20:00:00Z',
    {
      type: 'article',
      title: 'Wabi-sabi in small spaces',
      status: 'inbox',
      tags: ['interiors'],
      source: { url: 'https://journal.example.org/wabi-sabi-small', author: 'K. Lund', site: 'The Quiet Journal' },
      captured_via: 'web',
      extraction: 'ok',
    },
    `## Content
Imperfection is easier to live with in a small room. A worn chair, a lamp with a slightly crooked shade, a stack of books that is never quite straight.
Choose fewer, warmer things. Let materials age. Leave one surface empty.
`,
  );

  add(
    'sources',
    'bulb-colour-temperature',
    '2026-11-12T08:00:00Z',
    {
      type: 'link',
      title: 'Choosing bulb colour temperature',
      status: 'inbox',
      tags: ['lighting'],
      source: { url: 'https://home.example.com/bulbs/kelvin', site: 'Home Example' },
      captured_via: 'telegram',
      extraction: 'ok',
    },
    `## Content
2200 K is candle-like, 2700 K is classic incandescent, 4000 K is neutral and 5000 K+ feels like daylight. For evening rooms stay at or below 2700 K.
`,
  );

  // ---------------------------------------------------------------- notes
  add(
    'notes',
    'what-makes-a-room-calm',
    '2026-06-12T21:40:00Z',
    {
      type: 'note',
      title: 'What makes a room calm',
      status: 'library',
      tags: ['interiors', 'thinking'],
    },
    `Three things keep coming up:

1. **Low, warm light.** Lamps below eye level, 2700 K or lower. See [[japanese-listening-rooms]] and [[paper-lamp-photo]].
2. **Soft surfaces that eat sound.** Books, curtains, a rug — [[room-acoustics-primer]] says that is usually enough.
3. **One purpose.** A place that asks for one thing ([[single-tasking]]).

Morris's rule applies: [[morris-useful-beautiful|useful or beautiful]].
`,
    '2026-08-20T10:00:00Z',
  );

  add(
    'notes',
    'warm-light',
    '2026-06-06T22:00:00Z',
    {
      type: 'note',
      title: 'Warm light',
      status: 'library',
      tags: ['lighting'],
      collections: ['Warm light'],
    },
    `Light that glows rather than shines. Paper, linen, frosted glass.

The [[paper-lamp-photo]] is the reference. The [[akari-style-floor-lamp]] might be it.
`,
  );

  add(
    'notes',
    'sourdough-log',
    '2026-07-20T08:00:00Z',
    {
      type: 'note',
      title: 'Sourdough log',
      status: 'library',
      tags: ['baking', 'sourdough'],
    },
    `| Loaf | Hydration | Retard | Result |
| --- | --- | --- | --- |
| #5 | 72% | 12 h | tight crumb |
| #6 | 76% | 18 h | open, see [[open-crumb-photo]] |

Next: try the [[sourdough-hydration]] calculator for an 80% loaf.
`,
  );

  add(
    'notes',
    'vinyl-care',
    '2026-09-08T19:00:00Z',
    {
      type: 'note',
      title: 'Vinyl care',
      status: 'library',
      tags: ['vinyl'],
    },
    `From the [[record-fair-notes]]: distilled water and a drop of surfactant. Inner sleeves matter more than I thought.
`,
  );

  // ---------------------------------------------------------------- projects
  add(
    'projects',
    'reading-corner',
    '2026-06-03T09:00:00Z',
    {
      type: 'project',
      title: 'Reading corner',
      status: 'library',
      kind: 'hobby',
      intent: 'A calm corner by the window for reading in the evening: warm light, soft sound, no screens.',
      project_status: 'active',
      view: 'cards',
      tags: ['interiors'],
      cover: 'attachments/2026/06/01hy-paper-lamp.png',
    },
    `## Material
### Inspiration
- [[japanese-listening-rooms]]: the low warm light is the feeling I want
- [[what-makes-a-room-calm]]
### Lighting
- [[paper-lamp-photo]]: reference for the glow
- [[bulb-colour-temperature]]: stay at 2700 K or below
### Acoustics
- [[room-acoustics-primer]]: probably just a bookshelf and a curtain
### To buy
- [[akari-style-floor-lamp]]: check sizes first

## Notes
The armchair is 95 cm tall, so the lamp should be at least 120 cm.

## Questions
- How much sound dampening does a reading corner need?
- Is a side table worth the space?

## Checklist
- [x] Pick the corner
- [ ] Measure the corner
- [ ] Order the lamp
`,
    '2026-11-12T09:00:00Z',
  );

  add(
    'projects',
    'listening-rooms-essay',
    '2026-07-03T20:00:00Z',
    {
      type: 'project',
      title: 'Listening rooms essay',
      status: 'library',
      kind: 'writing',
      intent: 'A short essay on why listening rooms feel the way they do.',
      project_status: 'active',
      view: 'list',
      tags: ['audio', 'writing'],
      cover: 'attachments/2026/06/01hx-counter.png',
    },
    `## Material
### Sources
- [[japanese-listening-rooms]]: history paragraph, the kissa origin
- [[how-a-record-is-cut]]: open with the lathe scene at 01:05
- [[listening-bar-counter]]: describe the cedar counter
### Ideas
- [[what-makes-a-room-calm]]: the three-part structure

## Questions
- Is the essay about rooms, or about attention?

## Checklist
- [ ] Outline
- [ ] First draft
`,
    '2026-09-01T10:00:00Z',
  );

  add(
    'projects',
    'sourdough',
    '2026-07-19T07:00:00Z',
    {
      type: 'project',
      title: 'Sourdough',
      status: 'library',
      kind: 'learning',
      intent: 'Get a reliably open crumb.',
      project_status: 'paused',
      view: 'cards',
      tags: ['baking'],
      cover: 'attachments/2026/07/01j3-crumb.png',
    },
    `## Material
- [[sourdough-log]]
- [[open-crumb-photo]]: target crumb
- [[sourdough-hydration]]

## Checklist
- [x] Feed starter daily for a week
- [ ] Try 80% hydration
`,
  );

  // ---------------------------------------------------------------- collections
  add(
    'collections',
    'listening-rooms',
    '2026-06-02T19:30:00Z',
    {
      type: 'collection',
      title: 'Listening rooms',
      status: 'library',
      cover: 'attachments/2026/06/01hx-counter.png',
    },
    `Rooms built for listening: kissa, listening bars, home setups.
`,
  );
  add(
    'collections',
    'warm-light',
    '2026-06-05T08:20:00Z',
    {
      type: 'collection',
      title: 'Warm light',
      status: 'library',
      cover: 'attachments/2026/06/01hy-paper-lamp.png',
    },
    `Lamps, bulbs and rooms with light that glows rather than shines.
`,
  );

  // ---------------------------------------------------------------- memories
  add(
    'memories',
    'prefers-warm-light',
    '2026-09-10T12:00:00Z',
    {
      type: 'memory',
      title: 'Prefers warm light around 2700 K',
      status: 'library',
      agent: 'claude',
      tags: ['lighting', 'preferences'],
      captured_via: 'mcp:claude',
    },
    `The owner prefers warm, low light (≤ 2700 K) in evening spaces. Relevant to [[reading-corner]].
`,
  );
  add(
    'memories',
    'reading-corner-dimensions',
    '2026-11-12T09:30:00Z',
    {
      type: 'memory',
      title: 'Armchair in the reading corner is 95 cm tall',
      status: 'library',
      agent: 'claude',
      tags: ['reading-corner'],
      captured_via: 'mcp:claude',
    },
    `The armchair in the [[reading-corner]] is 95 cm tall; a floor lamp should be ≥ 120 cm.
`,
  );

  return specs;
}

export function sampleAssets(): Record<string, Buffer> {
  return {
    'attachments/2026/06/01hy-paper-lamp.png': lampImage(),
    'attachments/2026/06/01hx-counter.png': counterImage(),
    'attachments/2026/07/01j3-crumb.png': breadImage(),
    'attachments/2026/07/01j2-room-acoustics-primer.pdf': simplePdf('A primer on small-room acoustics', [
      [
        'Small rooms have three problems: early reflections, flutter echo between',
        'parallel walls, and uneven bass.',
        '',
        'Early reflections are best handled at the first reflection points with',
        'soft panels or bookshelves. Flutter echo disappears once one of two',
        'parallel walls is broken up, by shelves, curtains or art.',
      ],
      [
        'Bass is hard. Corner placement of soft furniture helps a little; bass',
        'traps help more.',
        '',
        'Rule of thumb: treat 20 to 30 percent of the wall area, and use a thick',
        'rug on hard floors. A reading corner rarely needs panels. A full',
        'bookshelf and a heavy curtain usually suffice.',
      ],
    ]),
  };
}

/** Write the sample library to `dir`. Returns the number of files written. */
export function generateSampleLibrary(dir: string, opts: { clean?: boolean } = {}): number {
  if (opts.clean && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  let n = 0;
  const write = (rel: string, data: string | Buffer) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
    n++;
  };
  for (const f of ['notes', 'sources', 'projects', 'collections', 'memories', 'attachments']) mkdirSync(join(dir, f), { recursive: true });
  const cfg = defaultConfig('Sample Cabinet');
  write('.cabinet/config.json', JSON.stringify(cfg, null, 2) + '\n');
  write('AGENTS.md', agentsMd());
  write('.gitignore', libraryGitignore());
  for (const s of sampleSpecs()) write(`${s.folder}/${s.slug}.md`, serializeMarkdown(s.fm, s.body));
  for (const [rel, data] of Object.entries(sampleAssets())) write(rel, data);
  return n;
}
