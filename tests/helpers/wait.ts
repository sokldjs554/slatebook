export async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
