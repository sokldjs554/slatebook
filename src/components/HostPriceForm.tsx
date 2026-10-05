'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

/** 호스트가 상품의 시간당 가격을 바꾸는 한 줄짜리 폼. 저장되면 서버 컴포넌트를 다시 읽어 화면의 숫자를 갱신한다. */
export function HostPriceForm({ listing }: { listing: { id: string; title: string; hourlyPrice: number } }) {
  const router = useRouter();
  const [value, setValue] = useState(String(listing.hourlyPrice));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const hourlyPrice = Number(value);
    setBusy(true);
    setMessage(null);
    const r = await api<{ hourlyPrice: number }>(`/api/host/listings/${listing.id}`, { method: 'PATCH', body: { hourlyPrice } });
    setBusy(false);
    if (r.ok) {
      setMessage({ ok: true, text: '저장했어요' });
      router.refresh();
    } else {
      setMessage({ ok: false, text: r.code === 'UNAUTHORIZED' ? '화면 위쪽에서 데모 사용자를 선택해 주세요.' : r.message });
    }
  }

  return (
    <form onSubmit={submit} className="kv" aria-label={`${listing.title} 가격`} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--ink)' }}>{listing.title}</span>
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="muted">시간당</span>
        <input
          type="number"
          inputMode="numeric"
          min={1000}
          max={10_000_000}
          step={1000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`${listing.title} 시간당 가격`}
          style={{ width: 120, padding: '6px 8px', font: 'inherit', textAlign: 'right' }}
        />
        <span className="muted">원</span>
        <button type="submit" className="secondary" disabled={busy || Number(value) === listing.hourlyPrice} style={{ padding: '6px 10px' }}>
          {busy ? '저장 중…' : '저장'}
        </button>
        {message && (
          <span className={message.ok ? 'muted' : 'notice bad'} role={message.ok ? 'status' : 'alert'} style={{ fontSize: 13, padding: message.ok ? 0 : '4px 8px' }}>
            {message.text}
          </span>
        )}
      </span>
    </form>
  );
}
