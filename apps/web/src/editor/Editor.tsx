import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  keymap,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, completionKeymap, completionStatus, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { api, type ItemSummary } from '../lib/api.ts';
import { TYPE_LABEL } from '../lib/meta.ts';

const highlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-md-h1' },
  { tag: t.heading2, class: 'cm-md-h2' },
  { tag: t.heading3, class: 'cm-md-h3' },
  { tag: t.strong, class: 'cm-md-strong' },
  { tag: t.emphasis, class: 'cm-md-em' },
  { tag: t.quote, class: 'cm-md-quote' },
  { tag: t.monospace, class: 'cm-md-code' },
  { tag: t.link, class: 'cm-md-link' },
  { tag: t.url, class: 'cm-md-link' },
  { tag: t.processingInstruction, class: 'cm-md-mark' },
  { tag: t.meta, class: 'cm-md-mark' },
]);

const wikiMatcher = new MatchDecorator({
  regexp: /!?\[\[([^\[\]\n]+?)\]\]/g,
  decoration: (m) => Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-target': m[1].split('|')[0].split('#')[0].trim() } }),
});

const wikiLinks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = wikiMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = wikiMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** `[[` autocomplete against the library. Inserts `slug]]`. */
export function wikiCompletion(opts: { exclude?: string } = {}) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 120), ctx.pos);
    const open = before.lastIndexOf('[[');
    if (open < 0) return null;
    const query = before.slice(open + 2);
    if (/[\]\n|]/.test(query)) return null;
    const from = ctx.pos - query.length;
    const { items } = await api<{ items: ItemSummary[] }>(`/api/suggest?q=${encodeURIComponent(query)}&limit=10`);
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    return {
      from,
      filter: false,
      options: items
        .filter((i) => i.id !== opts.exclude)
        .map((i) => ({
          label: i.title,
          detail: TYPE_LABEL[i.type],
          apply: (view: EditorView, _c: unknown, f: number, to: number) => {
            const insert = after === ']]' ? i.slug : `${i.slug}]]`;
            view.dispatch({ changes: { from: f, to, insert }, selection: { anchor: f + insert.length + (after === ']]' ? 2 : 0) } });
          },
        })),
    };
  };
}

export interface EditorProps {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  onSave?: () => void;
  onSubmit?: () => void; // Mod-Enter
  onOpenLink?: (target: string) => void;
  excludeId?: string;
  minHeight?: string;
  autoFocus?: boolean;
  /** Plain Enter (Shift+Enter still inserts a newline). */
  onEnter?: () => void;
  className?: string;
  extensions?: Extension[];
  ariaLabel?: string;
}

/** Markdown editor. `value` changes from outside replace the doc only when they differ. */
export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const keys = keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (latest.current.onSave?.(), true) },
      { key: 'Mod-Enter', preventDefault: true, run: () => (latest.current.onSubmit?.(), !!latest.current.onSubmit) },
      {
        key: 'Enter',
        run: (v) => {
          if (!latest.current.onEnter || completionStatus(v.state) === 'active') return false;
          latest.current.onEnter();
          return true;
        },
      },
    ]);
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        keys,
        history(),
        keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        wikiLinks,
        autocompletion({ override: [wikiCompletion({ exclude: props.excludeId })], icons: false, activateOnTyping: true }),
        cmPlaceholder(props.placeholder ?? ''),
        EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel ?? 'Editor' }),
        EditorView.theme({
          '&': { minHeight: props.minHeight ?? 'auto' },
          '.cm-scroller': { fontFamily: 'var(--font-serif)', lineHeight: '1.7' },
          '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', maxHeight: '16em' },
          '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px' },
          '.cm-content': { minHeight: props.minHeight ?? 'auto', fontFamily: 'var(--font-serif)' },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          mousedown: (e) => {
            const el = (e.target as HTMLElement).closest('.cm-wikilink') as HTMLElement | null;
            if (el && (e.metaKey || e.ctrlKey) && latest.current.onOpenLink) {
              e.preventDefault();
              latest.current.onOpenLink(el.dataset.target!);
              return true;
            }
            return false;
          },
        }),
        ...(props.extensions ?? []),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    if (props.autoFocus) setTimeout(() => v.focus(), 30);
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (props.value !== cur) v.dispatch({ changes: { from: 0, to: cur.length, insert: props.value } });
  }, [props.value]);

  return <div ref={host} className={props.className} data-editor />;
}
