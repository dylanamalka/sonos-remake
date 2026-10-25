import { test, expect } from '@playwright/test';
test('pair, control playback, change volume, group rooms, manage queue, and inspect SoundCloud setup', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Pairing code').fill('current-e2e-only');
  await page.getByRole('button', { name: 'Connect to your home' }).click();
  await page.request.post('/api/rooms/MOCK_1/group', { data: { coordinator: null } });
  await page.request.post('/api/rooms/MOCK_0/control', { data: { action: 'play' } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible();
  await expect(
    page.getByText('Demo mode · simulated rooms and playback. No physical speakers connected.'),
  ).toBeVisible();
  const studio = page
    .locator('.room-card')
    .filter({ has: page.getByText('Studio', { exact: true }) });
  await studio.getByRole('button', { name: 'Pause Studio' }).click();
  await expect(studio.getByRole('button', { name: 'Play Studio' })).toBeVisible();
  await studio.getByLabel('Studio volume').fill('42');
  await expect(studio.getByText('42%')).toBeVisible();
  await page.getByRole('button', { name: 'Manage groups' }).click();
  await page.getByLabel('Group Lounge').check();
  await expect(page.getByText('Room group updated')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('Grouped with Studio')).toBeVisible();
  await page.getByRole('button', { name: 'Open Now Playing' }).click();
  await expect(page.getByRole('dialog', { name: 'Now playing' })).toBeVisible();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Playback queue' })).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Remove Late night currents' }).click();
    await expect(page.getByRole('button', { name: 'Remove Late night currents' })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Close queue' }).click();
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: '.local/screenshots/desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'SoundCloud', exact: true }).first().click();
  } else {
    await page.screenshot({ path: '.local/screenshots/mobile.png', fullPage: true });
    await page
      .locator('.mobile-nav')
      .getByRole('button', { name: 'SoundCloud', exact: true })
      .click();
  }
  await expect(
    page.getByRole('heading', { name: 'Your next favorite is out there.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Set up SoundCloud' }).click();
  await expect(page.getByText('SOUNDCLOUD_CLIENT_ID', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open diagnostics' }).click();
  await expect(page.getByRole('heading', { name: 'Diagnostics.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
