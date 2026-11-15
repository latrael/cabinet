import { Link } from '@tanstack/react-router';
import type { ItemSummary } from '../lib/api.ts';
import { thumbUrl } from '../lib/api.ts';
import { host, relTime, TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';

function coverSrc(i: ItemSummary): string | undefined {
  if (i.cover) return i.cover;
  if (i.type === 'image' && i.attachment) return i.attachment;
  if (i.type === 'pdf' && i.attachment) return i.attachment;
  return undefined;
}

/** The small uppercase type label that sits above a headline. */
export function TypeTab({ type, label }: { type: ItemSummary['type']; label?: string }) {
  return <span className="kicker">{label ?? TYPE_LABEL[type]}</span>;
}

/** One cell of the item grid: label line, headline, a sentence, then tags. Nothing moves on hover. */
export function ItemCard({
  item,
  footer,
  compact,
  onClick,
  draggable,
}: {
  item: ItemSummary;
  footer?: React.ReactNode;
  compact?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  draggable?: boolean;
}) {
  const cover = coverSrc(item);
  const Icon = TYPE_ICON[item.type];
  const isQuote = item.type === 'quote';
  const source = item.site ?? host(item.url) ?? (item.type === 'project' ? (item.projectStatus ?? 'active') : undefined);
  return (
    <article className="item-cell group flex flex-col" data-item={item.slug} data-type={item.type} draggable={draggable}>
      <Link to="/item/$id" params={{ id: item.id }} className="block" onClick={onClick} draggable={false}>
        <div className="kicker mb-2 flex items-center gap-1.5">
          <Icon size={12} strokeWidth={1.8} aria-hidden />
          <span className="truncate">
            {TYPE_LABEL[item.type]}
            {source && <span className="font-medium tracking-[0.04em] normal-case"> / {source}</span>}
          </span>
          <span className="ml-auto shrink-0 font-medium tracking-[0.04em] normal-case">{relTime(item.created)}</span>
        </div>
        {cover && !compact && (
          <div className="mb-3 aspect-[3/2] overflow-hidden bg-paper-deep">
            <img src={thumbUrl(cover, 480)} alt="" loading="lazy" className="block h-full w-full object-cover" draggable={false} onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
          </div>
        )}
        {isQuote && item.excerpt ? (
          <blockquote className="item-title font-serif text-[18px] leading-[1.3] text-ink italic">“{item.excerpt.replace(/^[>\s“"]+|[”"]+$/g, '')}”</blockquote>
        ) : (
          <h3 className="item-title font-serif text-[19px] leading-[1.22] text-ink">{item.title}</h3>
        )}
        {item.why && <p className="mt-1.5 font-serif text-[14.5px] leading-snug text-ink-soft">{item.why.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a: string, b: string) => b || a.replace(/-/g, ' '))}</p>}
        {!item.why && !isQuote && item.excerpt && !compact && <p className="mt-1.5 line-clamp-3 font-serif text-[14.5px] leading-snug text-faded">{item.excerpt}</p>}
        {(item.extraction === 'pending' || item.extraction === 'failed' || item.status === 'inbox' || (item.tags.length > 0 && !compact)) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-faded">
            {item.extraction === 'pending' && <span className="text-brass">fetching…</span>}
            {item.extraction === 'failed' && <span className="text-alert">needs content</span>}
            {item.status === 'inbox' && <span className="font-semibold text-lamp">In inbox</span>}
            {!compact && item.tags.slice(0, 4).map((t) => <span key={t}>#{t}</span>)}
          </div>
        )}
      </Link>
      {footer && <div className="mt-auto pt-3">{footer}</div>}
    </article>
  );
}

/** A dense catalogue row for list views. */
export function ItemRow({ item, right, onClick }: { item: ItemSummary; right?: React.ReactNode; onClick?: () => void }) {
  const Icon = TYPE_ICON[item.type];
  return (
    <div className="group flex items-center gap-3 border-b border-rule py-2.5 pr-2" data-item={item.slug}>
      <Icon size={15} strokeWidth={1.7} className="shrink-0 text-faded" aria-hidden />
      <Link to="/item/$id" params={{ id: item.id }} className="min-w-0 flex-1" onClick={onClick}>
        <div className="truncate font-serif text-[15.5px] text-ink">{item.title}</div>
        <div className="truncate text-[12.5px] text-faded">
          {item.why ?? item.excerpt ?? item.site ?? host(item.url) ?? ''}
        </div>
      </Link>
      <div className="hidden shrink-0 gap-1 md:flex">
        {item.tags.slice(0, 3).map((t) => (
          <span key={t} className="text-[11.5px] text-faded">
            #{t}
          </span>
        ))}
      </div>
      <span className="w-20 shrink-0 text-right text-[12px] text-faded">{relTime(item.created)}</span>
      {right}
    </div>
  );
}
