import { useEffect, useState } from 'react';

/** 复制完整的仓库相对路径,不依赖本地 checkout 或文件是否仍然存在。 */
export function CopyFilePathButton({ path }: { path: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  useEffect(() => {
    setStatus('idle');
  }, [path]);
  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 1800);
    return () => clearTimeout(timer);
  }, [status]);

  const label = status === 'copied'
    ? '已复制路径'
    : status === 'error'
      ? '复制失败,点击重试'
      : '复制文件路径';

  return (
    <button
      type="button"
      className={`fh-copy-path${status === 'copied' ? ' on' : ''}`}
      title={`${label}: ${path}`}
      aria-label={`${label}: ${path}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(path);
          setStatus('copied');
        } catch {
          setStatus('error');
        }
      }}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        {status === 'copied' ? (
          <path d="m3 8 3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M3.5 10.5h-1v-8h8v1" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </svg>
      <span className="sr-only" role="status">{status === 'idle' ? '' : label}</span>
    </button>
  );
}
