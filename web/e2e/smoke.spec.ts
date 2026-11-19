import { Page, expect, test } from '@playwright/test';

const instance = process.env['PV_INSTANCE'] ?? 'simulator';
const page_ = `/ext/packet-viewer?c=${instance}`;

const rows = (page: Page) => page.locator('.pv-row');
const count = (page: Page) => page.locator('.pv-filterbar > span');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(page_);
  await expect(page.locator('pv-log')).toContainText('Loaded definition of', { timeout: 30_000 });
  return errors;
}

/** menu bar → item */
async function menu(page: Page, name: string, item: string | RegExp) {
  await page.locator('.pv-menubutton', { hasText: name }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('Packet Viewer is in the Telemetry group of the sidebar', async ({ page }) => {
  await page.goto(`/instance?c=${instance}`);
  const item = page.locator('a', { hasText: 'Packet Viewer' });
  const telemetry = page.getByText('Telemetry', { exact: true }).first();
  await expect(telemetry).toBeVisible({ timeout: 30_000 });
  if (!(await item.isVisible())) await telemetry.click(); // the group may be collapsed
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(/\/ext\/packet-viewer/);
  await expect(page.locator('pv-log')).toContainText('Loaded definition of', { timeout: 30_000 });
});

test('a local file: packets, details, hex highlight, filter, navigation', async ({ page, request }) => {
  const errors = await open(page);
  // packets recorded by this Yamcs, as a CCSDS file
  const file = await (await request.get(`/api/archive/${instance}:exportPackets`)).body();
  test.skip(file.length === 0, 'no packets in the archive');

  await menu(page, 'File', /Open/);
  await page.locator('.pv-dialog input[type=file]').setInputFiles({ name: 'export.raw', mimeType: 'application/octet-stream', buffer: file });
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('pv-log')).toContainText(/Loaded \d+ packets from "export.raw"/);
  const total = Number((await count(page).textContent())!.match(/(\d+) packets/)![1]);
  expect(total).toBeGreaterThan(0);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator('.pv-row', { hasText: 'unknown' })).toHaveCount(0);

  // details of a packet
  await page.locator('.pv-row', { hasText: '/SIMULATOR/FlightData' }).first().click();
  await expect(page.locator('.pv-params tbody tr').first()).toBeVisible();
  await expect(page.locator('pv-hexdump pre')).toContainText('0000 ');
  await page.locator('.pv-params tbody tr').nth(1).click();
  await expect(page.locator('pv-hexdump .h').first()).toBeVisible();
  await page.getByRole('button', { name: 'Structure' }).click();
  await expect(page.locator('.pv-node').first()).toContainText('/SIMULATOR/FlightData');
  await page.getByRole('button', { name: 'Parameters' }).click();

  // filter: red while invalid, then applied
  const filter = page.locator('.pv-filter input');
  await filter.fill('subtype ==');
  await expect(page.locator('.pv-filter')).toHaveClass(/pv-invalid/);
  await filter.fill('packet.length > 40');
  await expect(page.locator('.pv-filter')).not.toHaveClass(/pv-invalid/);
  await filter.press('Enter');
  await expect(count(page)).toContainText(new RegExp(`of ${total} packets`));
  for (const len of await page.locator('.pv-row > div:nth-child(4)').allTextContents()) {
    expect(Number(len)).toBeGreaterThan(40);
  }
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(count(page)).toHaveText(`${total} packets`);

  // navigation: Go to Packet, mark, next, back
  await page.locator('.pv-scroll').focus();
  await page.keyboard.press('Control+g');
  await page.locator('.pv-dialog input').fill('3');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pv-row.sel > div').first()).toHaveText('3');
  await page.keyboard.press('Control+m');
  await expect(page.locator('.pv-row.sel')).toHaveClass(/marked/);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.pv-row.sel > div').first()).toHaveText('4');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.pv-row.sel > div').first()).toHaveText('3');

  // a parameter as a column, then hidden again
  await page.locator('.pv-params tbody tr').first().click({ button: 'right' });
  await page.getByRole('button', { name: 'Apply as Left Column' }).click();
  await expect(page.locator('.pv-colhead')).toHaveCount(1);
  await page.locator('.pv-colhead').click({ button: 'right' });
  await page.getByRole('button', { name: 'Hide Column' }).click();
  await expect(page.locator('.pv-colhead')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('live packets of the realtime stream', async ({ page }) => {
  const errors = await open(page);
  await menu(page, 'File', /Connect to Yamcs/);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.pv-source')).toContainText('(live)');
  await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
  await page.getByText('Disconnect').click();
  await expect(page.locator('.pv-source')).toContainText('(stopped)');
  expect(errors).toEqual([]);
});

test('packets of the archive', async ({ page }) => {
  const errors = await open(page);
  await menu(page, 'File', /Load from Archive/);
  await page.getByRole('button', { name: 'Last day' }).click();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('pv-log')).toContainText(/Loaded \d+ packets? from the archive/, { timeout: 30_000 });
  await expect(rows(page).first()).toBeVisible();
  expect(errors).toEqual([]);
});
