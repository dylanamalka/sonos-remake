import { test, expect } from '@playwright/test';
test('Stream from Mac is primary, runs the real encoder with mocked devices, stops, and reconnects on desktop/mobile', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Pairing code').fill('current-e2e-only');
  await page.getByRole('button', { name: 'Connect to your home' }).click();
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
  await page.request.post('/api/stream/stop', { data: {} });
  for (const id of ['MOCK_0', 'MOCK_1', 'MOCK_2'])
    await page.request.post(`/api/rooms/${id}/group`, { data: { coordinator: null } });
  await page.reload();
  const nav = () =>
    testInfo.project.name === 'mobile'
      ? page.locator('.mobile-nav').getByRole('button', { name: 'SoundCloud', exact: true }).click()
      : page.locator('.sidebar').getByRole('button', { name: 'SoundCloud', exact: true }).click();
  await nav();
  await expect(page.getByRole('heading', { name: 'Stream from Mac', exact: true })).toBeVisible();
  await expect(
    page.getByText('Demo uses a synthetic tone and simulated Sonos.', { exact: false }),
  ).toBeVisible();
  for (const name of ['Studio', 'Lounge', 'Terrace']) {
    const input = page.getByLabel(`Stream to ${name}`, { exact: true });
    await input.setChecked(name !== 'Terrace');
  }
  await page.getByLabel('Captured browser').selectOption('chrome');
  await page
    .locator('.network-listening')
    .getByRole('button', { name: 'Stream from Mac', exact: true })
    .click();
  await expect(
    page
      .locator('.network-listening')
      .getByText('Waiting for the Sonos audio reader', { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const response = await page.request.get('/api/stream');
  const state = await response.json();
  expect(state.mock).toBe(true);
  expect(state.encoder.frames).toBeGreaterThan(0);
  expect(state.encoder.bitrateKbps).toBe(192);
  expect(state.audiblePlaybackVerified).toBe(false);
  expect(state.hardwareHttpObserved).toBe(false);
  const rooms = (await (await page.request.get('/api/state')).json()).rooms;
  expect(rooms.find((r: any) => r.id === 'MOCK_1').coordinator).toBe('MOCK_0');
  await expect(
    page.locator('.player').getByText('SoundCloud · Stream from Mac', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop stream', exact: true }).click();
  await expect(
    page.locator('.listening-status').getByText('Capture stopped', { exact: true }),
  ).toBeVisible();
  await page
    .locator('.network-listening')
    .getByRole('button', { name: 'Stream from Mac', exact: true })
    .click();
  await expect(
    page
      .locator('.network-listening')
      .getByText('Waiting for the Sonos audio reader', { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.reload();
  await nav();
  await expect(page.getByRole('button', { name: 'Reconnect stream', exact: true })).toBeVisible();
  await page.screenshot({
    path: `.local/screenshots/network-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Stop stream', exact: true }).click();
  const pulse = await page.context().newPage();
  pulse.on('pageerror', (e) => errors.push(e.message));
  await pulse.goto('/capture-test.html');
  await pulse.getByRole('button', { name: 'Start pulse', exact: true }).click();
  await expect(pulse.getByRole('status')).toContainText('Pulse 1 scheduled');
  await pulse.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(pulse.getByRole('status')).toContainText('Off · no audio generated');
  await pulse.close();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
