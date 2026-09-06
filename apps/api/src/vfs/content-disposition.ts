const CONTROL_OR_NON_ASCII = /[\x00-\x1f\x7f-\uffff"\\]/g;
const RFC5987_EXTRA = /['()*!]/g;

export function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(CONTROL_OR_NON_ASCII, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    RFC5987_EXTRA,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
