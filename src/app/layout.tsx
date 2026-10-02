import type { Metadata } from 'next';
import Link from 'next/link';
import { UserSwitcher } from '@/components/UserSwitcher';
import './globals.css';

export const metadata: Metadata = {
  title: 'Slatebook — 스튜디오·장비 대여',
  description: '촬영 스튜디오와 장비를 시간 단위로 예약하는 중개 플랫폼 (포트폴리오 구현)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="top">
          <Link href="/" className="brand">🎬 Slatebook</Link>
          <UserSwitcher />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
