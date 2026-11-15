import { Link } from '@tanstack/react-router';
import type { ItemSummary } from '../lib/api.ts';
import { thumbUrl } from '../lib/api.ts';
import { host, relTime, tabPosition, TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';

function coverSrc(i: ItemSummary): string | undefined {
  if (i.cover) return i.cover;
  if (i.type === 'image' && i.attachment) return i.attachment;
  if (i.type === 'pdf' && i.attachment) return i.attachment;
  return undefined;
}

export function TypeTab({ type, label }: { type: ItemSummary['type']; label?: string }) {
  return (
    <span className="tab" style={{ ['--tab-x' as any]: tabPosition(type) }} aria-hidden>
      {label ?? TYPE_LABEL[type]}
    </span>
  );
}

/** An index card. Image items lead with the picture; text items with their words. */
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
  return (
    <article className="card card-interactive group mt-3" data-item={item.slug} data-type={item.type} draggable={draggable}>
      <TypeTab type={item.type} />
      <Link to="/item/$id" params={{ id: item.id }} className="block focus-visible:outline-offset-4" onClick={onClick} draggable={false}>
        {cover && !compact && (
          <div className={`overflow-hidden rounded-t-[2px] bg-paper-deep ${item.type === 'pdf' ? 'max-h-48 border-b border-rule' : ''}`}>
            <img src={thumbUrl(cover, 480)} alt="" loading="lazy" className="block w-full object-cover" draggable={false} onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
          </div>
        )}
        <div className="px-3.5 pt-3 pb-3">
          {isQuote && item.excerpt ? (
            <blockquote className="font-serif text-[16px] leading-snug text-ink italic">“{item.excerpt.replace(/^[>\s“"]+|[”"]+$/g, '')}”</blockquote>
          ) : (
            <h3 className="font-serif text-[16.5px] leading-snug text-ink">{item.title}</h3>
          )}
          {item.why && <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">{item.why.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a: string, b: string) => b || a.replace(/-/g, ' '))}</p>}
          {!item.why && !isQuote && item.excerpt && !compact && <p className="mt-1.5 line-clamp-3 text-[13px] leading-snug text-faded">{item.excerpt}</p>}
          <div className="card-rule mt-2.5 mb-2" />
          <div className="flex items-center gap-2 text-[11.5px] text-faded">
            <Icon size={12} strokeWidth={1.8} aria-hidden />
            <span className="truncate">{item.site ?? host(item.url) ?? (item.type === 'project' ? (item.projectStatus ?? 'active') : TYPE_LABEL[item.type])}</span>
            {item.extraction === 'pending' && <span className="text-brass">fetching…</span>}
            {item.extraction === 'failed' && <span className="text-alert">needs content</span>}
            {item.status === 'inbox' && <span className="rounded-sm bg-lamp-wash px-1 text-lamp">inbox</span>}
            <span className="ml-auto shrink-0">{relTime(item.created)}</span>
          </div>
          {item.tags.length > 0 && !compact && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.slice(0, 4).map((t) => (
                <span key={t} className="text-[11.5px] text-lamp">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      </Link>
      {footer && <div className="border-t border-rule px-3.5 py-2">{footer}</div>}
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
          <span key={t} className="text-[11.5px] text-lamp">
            #{t}
          </span>
        ))}
      </div>
      <span className="w-20 shrink-0 text-right text-[12px] text-faded">{relTime(item.created)}</span>
      {right}
    </div>
  );
}
