/** 筛选和分页只影响展示，选择集合始终使用完整相对路径。 */
import type { WikiDocument } from '@/lib/api/knowledge-api';

export function filterDocuments(files: WikiDocument[], query: string, directory: string, status: string): WikiDocument[] {
  const text = query.trim().toLocaleLowerCase();
  return files.filter((file) => (!text || file.filename.toLocaleLowerCase().includes(text))
    && (!directory || file.filename.startsWith(directory + '/'))
    && (status === 'all' || (status === 'pending-work' ? ['pending', 'changed', 'failed'].includes(file.status) : file.status === status)));
}

export function selectDocuments(selected: ReadonlySet<string>, filenames: string[], checked: boolean): Set<string> {
  const next = new Set(selected);
  for (const filename of filenames) { if (checked) next.add(filename); else next.delete(filename); }
  return next;
}

export function documentDirectories(files: WikiDocument[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.filename.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return [...directories].sort();
}
