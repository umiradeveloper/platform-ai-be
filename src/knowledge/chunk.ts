/**
 * Pecah teks dokumen menjadi potongan ±`size` karakter dengan tumpang-tindih `overlap`,
 * mengikuti batas paragraf/baris/kalimat agar konteks tiap potongan tetap utuh.
 */
export function chunkText(text: string, size = 1500, overlap = 200): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  // unit terkecil: paragraf → baris → kalimat → potong paksa
  const units: string[] = [];
  const push = (u: string) => {
    if (u.length <= size) return units.push(u);
    const lines = u.split('\n');
    if (lines.length > 1) return lines.forEach(push);
    const sentences = u.split(/(?<=[.!?;])\s+/);
    if (sentences.length > 1) return sentences.forEach(push);
    for (let i = 0; i < u.length; i += size) units.push(u.slice(i, i + size));
  };
  clean.split(/\n\n/).forEach(push);

  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > size) {
      chunks.push(cur.trim());
      const tail = cur.slice(-overlap);
      const cut = tail.search(/\s/);
      cur = (cut >= 0 ? tail.slice(cut + 1) : tail) + '\n';
    }
    cur += (cur && !cur.endsWith('\n') ? '\n' : '') + u;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
