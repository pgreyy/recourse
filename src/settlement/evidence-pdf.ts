/**
 * A plain-text PDF (Helvetica, US Letter, wrapped lines, as many pages as needed), written by hand so no
 * PDF library is needed. Used for the dispute evidence file.
 */
function escapePdf(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
}

function wrap(text: string, width = 92): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        if (line) out.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      } else line = (line + ' ' + word).trim();
    }
    if (line) out.push(line);
  }
  return out;
}

export function textPdf(title: string, sections: Array<{ heading: string; body: string }>): Buffer {
  const lines: Array<{ text: string; bold: boolean }> = [{ text: title, bold: true }, { text: '', bold: false }];
  for (const s of sections) {
    lines.push({ text: s.heading, bold: true });
    for (const l of wrap(s.body)) lines.push({ text: l, bold: false });
    lines.push({ text: '', bold: false });
  }
  const perPage = 54;
  const pages: Array<typeof lines> = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));

  const objs: string[] = [];
  const add = (o: string) => objs.push(o) - 1; // returns 0-based index; object number = index + 1
  const catalog = add('');
  const pagesObj = add('');
  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds: number[] = [];
  pages.forEach((pg, n) => {
    const body = pg.map((l) => `/${l.bold ? 'F2' : 'F1'} ${l.bold ? 11 : 9.5} Tf (${escapePdf(l.text)}) Tj T*`).join(' ');
    const footer = `BT /F1 8 Tf 50 30 Td (Page ${n + 1} of ${pages.length}) Tj ET`;
    const stream = `BT 50 750 Td 13 TL ${body} ET ${footer}`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj + 1} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRegular + 1} 0 R /F2 ${fontBold + 1} 0 R >> >> /Contents ${content + 1} 0 R >>`));
  });
  objs[catalog] = `<< /Type /Catalog /Pages ${pagesObj + 1} 0 R >>`;
  objs[pagesObj] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i + 1} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog + 1} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
