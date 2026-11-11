import { useEffect, useState } from 'react';
import { useIsActiveTab } from '../../review/TabVisibility';

export function BoundRepository({ reviewId, directory, refreshKey }: {
  reviewId: string;
  directory: string | null;
  refreshKey: number;
}) {
  const active = useIsActiveTab();
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !directory) return;
    let request = 0;
    const refresh = () => {
      const latest = ++request;
      void window.duetlens.review.localBranch(reviewId).then(
        (name) => {
          if (latest === request) setBranch(name === '' ? '分离 HEAD' : name ?? '无法读取');
        },
        () => { if (latest === request) setBranch('无法读取'); },
      );
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      request++;
      window.removeEventListener('focus', refresh);
    };
  }, [active, directory, reviewId, refreshKey]);

  return (
    <dl className="review-repository" aria-label="绑定的本地仓库">
      <div>
        <dt>本地分支</dt>
        <dd className="mono">{directory ? branch ?? '读取中…' : '未关联'}</dd>
      </div>
      <div>
        <dt>绑定目录</dt>
        <dd className="mono">{directory ?? '未关联'}</dd>
      </div>
    </dl>
  );
}
