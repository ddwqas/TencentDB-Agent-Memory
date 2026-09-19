import { describe, expect, it } from 'vitest';
import { documentDirectories, filterDocuments, selectDocuments } from '../../web/src/pages/WikiPage/utils/document-selection.js';
import type { WikiDocument } from '../../web/src/lib/api/knowledge-api.js';

const files: WikiDocument[] = Array.from({ length: 125 }, (_, index) => ({
  filename: `chapter-${Math.floor(index / 50)}/document-${index}.md`, size: index,
  status: index % 2 ? 'pending' : 'completed',
}));

describe('文档选择', () => {
  it('当前页全选不会扩展到其他页，跨页增选和取消保留其他选择', () => {
    const first = selectDocuments(new Set(), files.slice(0, 50).map((file) => file.filename), true);
    const both = selectDocuments(first, [files[80].filename], true);
    expect(both.size).toBe(51);
    const remaining = selectDocuments(both, files.slice(0, 50).map((file) => file.filename), false);
    expect([...remaining]).toEqual([files[80].filename]);
    expect(first.size).toBe(50);
  });
  it('筛选结果全选包含所有页，目录和状态过滤按完整相对路径匹配', () => {
    const allPending = filterDocuments(files, '', '', 'pending-work');
    expect(allPending.length).toBe(62);
    expect(selectDocuments(new Set(), allPending.map((file) => file.filename), true).size).toBe(62);
    expect(filterDocuments(files, '', 'chapter-1', 'all')).toHaveLength(50);
    expect(filterDocuments(files, 'DOCUMENT-12', '', 'all')).toHaveLength(6);
    expect(documentDirectories([...files, { filename: 'chapter-1/nested/README.md', status: 'failed', size: 10 }])).toContain('chapter-1/nested');
  });
  it('同名原文按目录区分，待删除项不混入待分析选择', () => {
    const same: WikiDocument[] = [
      { filename: 'a/README.md', status: 'changed', size: 10 },
      { filename: 'b/README.md', status: 'deleted', size: 10 },
    ];
    expect(filterDocuments(same, '', '', 'pending-work').map((file) => file.filename)).toEqual(['a/README.md']);
    expect(selectDocuments(new Set(), same.map((file) => file.filename), true).size).toBe(2);
  });
});
