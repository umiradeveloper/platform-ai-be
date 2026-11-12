/**
 * Ekstraksi teks dari file untuk dijadikan konteks AI.
 * Didukung: PDF, DOCX, XLSX, CSV/TSV, TXT/MD/JSON/XML/HTML/LOG dan file kode umum.
 */
export const TEXT_EXT = ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'log', 'yml', 'yaml', 'ini', 'sql', 'html', 'htm', 'js', 'ts', 'py', 'php', 'java'];
export const SUPPORTED_EXT = ['pdf', 'docx', 'xlsx', ...TEXT_EXT];

export const extOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase();
export const isSupported = (name: string) => SUPPORTED_EXT.includes(extOf(name));

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
};
export const mimeOf = (name: string) => MIME[extOf(name)] ?? 'text/plain';

// unpdf hanya ESM — import dinamis agar tetap jalan di build CommonJS NestJS
const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

export async function extractText(name: string, buf: Buffer, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  const ext = extOf(name);
  let text = '';
  if (ext === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await esmImport('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const r = await pdfText(pdf, { mergePages: false });
    const pages: string[] = Array.isArray(r.text) ? r.text : [r.text];
    text = pages.map((p, i) => `--- Halaman ${i + 1} ---\n${p.trim()}`).join('\n\n');
    if (!text.replace(/--- Halaman \d+ ---/g, '').trim()) {
      text = '[PDF ini tidak memiliki teks yang bisa dibaca — kemungkinan hasil scan/gambar.]';
    }
  } else if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    text = r.value;
  } else if (ext === 'xlsx') {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const parts: string[] = [];
    wb.eachSheet((ws) => {
      const rows: string[] = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = (row.values as any[]).slice(1).map((v) => cellText(v));
        if (vals.some((v) => v !== '')) rows.push(vals.join('\t'));
      });
      parts.push(`--- Sheet: ${ws.name} (${rows.length} baris) ---\n${rows.join('\n')}`);
    });
    text = parts.join('\n\n');
  } else if (ext === 'html' || ext === 'htm') {
    text = buf.toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
  } else if (TEXT_EXT.includes(ext)) {
    text = buf.toString('utf8');
  } else {
    throw new Error(`Format .${ext} belum didukung`);
  }
  text = text.replace(/\u0000/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: false };
}

function cellText(v: any): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result); // formula
    if ('richText' in v) return v.richText.map((t: any) => t.text).join('');
    if ('text' in v) return String(v.text); // hyperlink
    if ('error' in v) return String(v.error);
  }
  return String(v).replace(/\s+/g, ' ').trim();
}
