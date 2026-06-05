// Pure file-presentation helpers (no fs/DB) — shared by the tree UI (icons),
// the content route (language), and the list route (excludes). Unit-tested.

export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.next', 'dist', '.superpowers', '.turbo', 'coverage',
]);

/** Extension → Monaco language id. */
export function fileLanguage(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'typescript';
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'astro': case 'html': case 'vue': case 'svelte': return 'html';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'json': return 'json';
    case 'md': case 'mdx': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'py': return 'python';
    case 'sh': return 'shell';
    default: return 'plaintext';
  }
}

export interface FileIcon { icon: string; color: string; }

/** Extension → a lucide icon name + a Tailwind text-color class (the Vivid palette). */
export function fileIcon(name: string): FileIcon {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'tsx': case 'jsx': return { icon: 'FileCode', color: 'text-[#36c5f0]' };
    case 'ts': case 'mts': case 'cts': case 'js': case 'mjs': case 'cjs':
      return { icon: 'FileCode', color: 'text-[#6cb6ff]' };
    case 'astro': case 'html': return { icon: 'FileCode', color: 'text-[#ff7b53]' };
    case 'css': case 'scss': return { icon: 'FileType', color: 'text-[#d2a8ff]' };
    case 'json': return { icon: 'Braces', color: 'text-[#e3b341]' };
    case 'md': case 'mdx': return { icon: 'FileText', color: 'text-[#9aa4af]' };
    case 'yml': case 'yaml': return { icon: 'FileCog', color: 'text-[#e3b341]' };
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico':
      return { icon: 'Image', color: 'text-[#a5d6ff]' };
    default: return { icon: 'File', color: 'text-[#8b949e]' };
  }
}
