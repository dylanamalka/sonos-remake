import { test, expect } from '@playwright/test';
test('credential-free SoundCloud setup persists, selects a synchronized line-in group, retries and stops on desktop/mobile', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Pairing code').fill('current-e2e-only');
  await page.getByRole('button', { name: 'Connect to your home' }).click();
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
  for (const id of ['MOCK_0', 'MOCK_1', 'MOCK_2'])
    await page.request.post(`/api/rooms/${id}/group`, { data: { coordinator: null } });
  await page.request.put('/api/listening', { data: { sourceRoomId: null, targetRoomIds: [] } });
  await page.reload();
  const navigate = async () => {
    if (testInfo.project.name === 'mobile')
      await page
        .locator('.mobile-nav')
        .getByRole('button', { name: 'SoundCloud', exact: true })
        .click();
    else
      await page
        .locator('.sidebar')
        .getByRole('button', { name: 'SoundCloud', exact: true })
        .click();
  };
  await navigate();
  await expect(page.getByRole('heading', { name: 'SoundCloud, through your Mac.' })).toBeVisible();
  await expect(page.getByText('No developer keys.', { exact: false })).toBeVisible();
  await page.getByLabel('Wired Sonos source').selectOption('MOCK_0');
  await page.getByLabel('Listen in Studio', { exact: true }).uncheck();
  await page.getByLabel('Listen in Lounge', { exact: true }).check();
  await page.getByLabel('Listen in Terrace', { exact: true }).check();
  await page.getByRole('button', { name: 'Save setup', exact: true }).click();
  await expect(page.getByText('Listening setup saved')).toBeVisible();
  await page.getByRole('button', { name: /^(Listen in selected rooms|Reconnect rooms)$/ }).click();
  await expect(
    page.locator('.listening-status').getByText('Sonos input selected', { exact: true }),
  ).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  expect(state.rooms.find((r: any) => r.id === 'MOCK_2').coordinator).toBe('MOCK_1');
  expect(state.listening.audiblePlaybackVerified).toBe(false);
  expect(state.soundcloud.configured).toBe(false);
  await expect(
    page.locator('.player').getByText('SoundCloud · Mac line-in', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open SoundCloud on Mac' }).click();
  await expect(
    page.getByText('Simulated browser launch; nothing opened.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await expect(
    page.locator('.listening-status').getByText('Sonos input paused', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^(Listen in selected rooms|Reconnect rooms)$/ }).click();
  await expect(
    page.locator('.listening-status').getByText('Sonos input selected', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await navigate();
  await expect(page.getByText('Studio line-in → Lounge, Terrace')).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect rooms', exact: true }).click();
  await expect(
    page.locator('.listening-status').getByText('Sonos input selected', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `.local/screenshots/soundcloud-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
