import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config';

const base = { DATABASE_URL: 'postgres://u@h/db', PAYMENT_GATEWAY: 'fake', LOG_LEVEL: 'silent' };

describe('loadConfig', () => {
  it('DATABASE_URL 이 없으면 무엇이 빠졌는지 읽을 수 있는 메시지로 실패한다', () => {
    expect(() => loadConfig({ PAYMENT_GATEWAY: 'fake' })).toThrow(/DATABASE_URL: DATABASE_URL is required/);
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL is required/);
  });

  it('잘못된 값은 변수 이름과 함께 모두 보고한다', () => {
    let message = '';
    try {
      loadConfig({ DATABASE_URL: 'x', PAYMENT_GATEWAY: 'stripe', HOLD_MINUTES: '999' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/PAYMENT_GATEWAY/);
    expect(message).toMatch(/HOLD_MINUTES/);
  });

  it('프로덕션에서는 가짜 PG·데모 인증을 명시적으로 허용하지 않으면 기동하지 않는다', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/ALLOW_FAKE_GATEWAY/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ALLOW_FAKE_GATEWAY: '1', DEMO_AUTH: '1' })).toThrow(/ALLOW_DEMO_AUTH/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', ALLOW_FAKE_GATEWAY: '1', DEMO_AUTH: '1', ALLOW_DEMO_AUTH: '1' }).demoAuth).toBe(true);
  });

  it('토스 모드에는 시크릿 키와 충분히 긴 웹훅 토큰이 필요하다', () => {
    expect(() => loadConfig({ ...base, PAYMENT_GATEWAY: 'toss' })).toThrow(/TOSS_SECRET_KEY/);
    expect(() => loadConfig({ ...base, PAYMENT_GATEWAY: 'toss', TOSS_SECRET_KEY: 'test_sk_x', WEBHOOK_TOKEN: 'short' })).toThrow(/WEBHOOK_TOKEN/);
    expect(loadConfig({ ...base, PAYMENT_GATEWAY: 'toss', TOSS_SECRET_KEY: 'test_sk_x', WEBHOOK_TOKEN: 'x'.repeat(24) }).gateway).toBe('toss');
  });

  it('포트원 모드에는 API 시크릿, 웹훅 서명 시크릿, 충분히 긴 웹훅 토큰이 모두 필요하다 (서명 검증을 끈 채로는 기동하지 않는다)', () => {
    const token = 'x'.repeat(24);
    expect(() => loadConfig({ ...base, PAYMENT_GATEWAY: 'portone', PORTONE_WEBHOOK_SECRET: 'w', WEBHOOK_TOKEN: token })).toThrow(/PORTONE_API_SECRET/);
    expect(() => loadConfig({ ...base, PAYMENT_GATEWAY: 'portone', PORTONE_API_SECRET: 's', WEBHOOK_TOKEN: token })).toThrow(/PORTONE_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, PAYMENT_GATEWAY: 'portone', PORTONE_API_SECRET: 's', PORTONE_WEBHOOK_SECRET: 'w' })).toThrow(/WEBHOOK_TOKEN/);
    const c = loadConfig({ ...base, PAYMENT_GATEWAY: 'portone', PORTONE_API_SECRET: 's', PORTONE_WEBHOOK_SECRET: 'w', WEBHOOK_TOKEN: token, PORTONE_STORE_ID: '' });
    expect(c.portone).toEqual({ apiSecret: 's', storeId: undefined, webhookSecret: 'w' });
  });
});
