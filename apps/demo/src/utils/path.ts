export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}
