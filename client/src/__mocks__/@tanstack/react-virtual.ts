export interface VirtualItem {
  key: number;
  index: number;
  start: number;
  end: number;
  size: number;
}

interface UseVirtualizerOptions {
  count: number;
  estimateSize: (index: number) => number;
}

interface VirtualizerResult {
  getVirtualItems: () => VirtualItem[];
  getTotalSize: () => number;
}

/**
 * jsdom performs no layout, so the real @tanstack/react-virtual always
 * measures a zero-size viewport and renders no rows regardless of `count`.
 * This test-only mock renders every row unvirtualized so components built
 * on the shared DataTable have real content to assert against.
 */
export function useVirtualizer(options: UseVirtualizerOptions): VirtualizerResult {
  const items: VirtualItem[] = [];
  let offset = 0;
  for (let index = 0; index < options.count; index += 1) {
    const size = options.estimateSize(index);
    items.push({ key: index, index, start: offset, end: offset + size, size });
    offset += size;
  }
  return {
    getVirtualItems: () => items,
    getTotalSize: () => offset,
  };
}
