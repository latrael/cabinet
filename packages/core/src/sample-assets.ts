// Tiny dependency-free encoders for the synthetic sample library assets.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export type Rgb = [number, number, number];

/** Encode an RGB image; `pixel(x, y)` returns the colour. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = Math.max(0, Math.min(255, Math.round(r)));
      raw[o++] = Math.max(0, Math.min(255, Math.round(g)));
      raw[o++] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A paper lamp glowing in a dim room. */
export function lampImage(w = 480, h = 360): Buffer {
  const wall: Rgb = [58, 42, 32];
  const floor: Rgb = [92, 66, 44];
  const glow: Rgb = [255, 214, 150];
  return encodePng(w, h, (x, y) => {
    let c = y > h * 0.78 ? mix(floor, [70, 50, 34], (y - h * 0.78) / (h * 0.22)) : wall;
    const cx = w * 0.42;
    const cy = h * 0.42;
    const dx = (x - cx) / (w * 0.13);
    const dy = (y - cy) / (h * 0.25);
    const d = Math.sqrt(dx * dx + dy * dy);
    const halo = Math.max(0, 1 - Math.sqrt(((x - cx) / w) ** 2 + ((y - cy) / h) ** 2) * 2.2);
    c = mix(c, glow, halo * halo * 0.75);
    if (d < 1) {
      const ribs = Math.abs(Math.sin(dy * 9)) < 0.08 ? 0.82 : 1;
      c = mix([250, 236, 205], glow, d * 0.6).map((v) => v * ribs) as Rgb;
    }
    if (Math.abs(x - cx) < 2 && y > cy + h * 0.25 && y < h * 0.8) c = [40, 30, 22];
    return c;
  });
}

/** A wooden listening-bar counter with a row of records. */
export function counterImage(w = 480, h = 360): Buffer {
  return encodePng(w, h, (x, y) => {
    const wood: Rgb = mix([120, 74, 42], [150, 98, 58], (Math.sin(x / 9 + Math.sin(y / 23) * 3) + 1) / 2);
    if (y > h * 0.62) return mix(wood, [70, 44, 28], (y - h * 0.62) / (h * 0.5));
    const shelf = Math.floor(x / 22);
    const hue = [
      [196, 92, 62],
      [222, 180, 110],
      [60, 70, 82],
      [140, 150, 120],
      [230, 214, 190],
      [110, 60, 50],
    ][shelf % 6] as Rgb;
    if (y > h * 0.18 && y < h * 0.58 && x % 22 > 2) return mix(hue, [30, 22, 18], (y - h * 0.18) / (h * 1.4));
    return mix([44, 32, 26], [64, 46, 34], y / h);
  });
}

/** Sourdough crumb: speckled warm beige. */
export function breadImage(w = 480, h = 360): Buffer {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const holes = Array.from({ length: 90 }, () => [rnd() * w, rnd() * h, 3 + rnd() * 14]);
  return encodePng(w, h, (x, y) => {
    const crust = Math.min(x, y, w - x, h - y) < 18;
    if (crust) return [126, 72, 36];
    let c: Rgb = [236, 214, 176];
    for (const [hx, hy, r] of holes) {
      const d = Math.hypot(x - hx, y - hy);
      if (d < r) c = mix([186, 156, 116], c, d / r);
    }
    return c;
  });
}

function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A minimal, valid single-font PDF with one page per entry in `pages` (each a list of lines). */
export function simplePdf(title: string, pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (s: string) => {
    objects.push(s);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>');
  const pageIds: number[] = [];
  pages.forEach((lines, pi) => {
    let stream = 'BT\n';
    let y = 760;
    if (pi === 0) {
      stream += `/F2 20 Tf 72 ${y} Td (${pdfEscape(title)}) Tj ET\nBT\n`;
      y -= 40;
    }
    stream += `/F1 12 Tf 72 ${y} Td 16 TL\n`;
    for (const l of lines) stream += `(${pdfEscape(l)}) '\n`;
    stream += 'ET';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info << /Title (${pdfEscape(title)}) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
