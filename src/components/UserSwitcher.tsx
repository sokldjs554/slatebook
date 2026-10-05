'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface DemoUsers {
  users: { id: string; name: string; host: boolean }[];
  current: string | null;
}

/** ⚠ 데모 전용 사용자 전환기. DEMO_AUTH 가 꺼져 있으면(API 404) 아무것도 그리지 않는다. */
export function UserSwitcher() {
  const [data, setData] = useState<DemoUsers | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    api<DemoUsers>('/api/demo/users', { signal: ac.signal }).then((r) => {
      if (r.ok && !ac.signal.aborted) setData(r.data);
    });
    return () => ac.abort();
  }, []);

  if (!data) return null;
  const current = data.users.find((u) => u.id === data.current);

  async function change(userId: string) {
    setBusy(true);
    const r = userId
      ? await api('/api/demo/login', { method: 'POST', body: { userId } })
      : await api('/api/demo/login', { method: 'DELETE' });
    if (r.ok) window.location.reload();
    else setBusy(false);
  }

  return (
    <div className="demo" title="데모 전용 — 실서비스에서는 실제 로그인으로 교체됩니다">
      <label htmlFor="demo-user" style={{ margin: 0 }}>데모 사용자</label>
      <select id="demo-user" value={data.current ?? ''} disabled={busy} onChange={(e) => change(e.target.value)} style={{ width: 'auto', padding: '6px 8px' }}>
        <option value="">선택…</option>
        {data.users.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>
      {current?.host && <Link href="/host" className="btn secondary" style={{ padding: '6px 10px', fontSize: 14 }}>호스트 화면</Link>}
    </div>
  );
}
