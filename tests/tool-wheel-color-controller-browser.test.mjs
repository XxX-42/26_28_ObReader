import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { resolveBrowserPath } from './browser-path.mjs';
import { launchTestBrowser } from './browser-test-launch.mjs';

const browserPath = resolveBrowserPath();
test('wheel swatches remain visible and selectable near viewport edges', { skip: !browserPath && 'Chrome or Edge is required', timeout: 30000 }, async () => {
  const browser = await launchTestBrowser(puppeteer, { executablePath: browserPath, headless: true, args: ['--no-sandbox'] }, { testName: 'wheel-color-layout' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 320, height: 240 });
    await page.setContent('<style>body{margin:0}.pdfToolWheel{position:fixed;filter:drop-shadow(0 4px 12px #0008)}</style>');
    await page.addScriptTag({ content: await readFile(new URL('../viewer-adapter/input/tool-wheel-color-controller.js', import.meta.url), 'utf8') });
    await page.evaluate(() => {
      window.commits = [];
      window.controller = new window.PdfReaderInputRuntime.ToolWheelColorController({
        getWheel: () => window.wheel, getToolKey: item => item.key, getColor: () => '#FFFF98',
        commit: value => { window.commits.push(value.color); window.wheel = null; },
      });
      window.controller.install();
      window.makeWheel = (x, y, radius) => {
        window.wheel?.element.remove();
        const element = document.createElement('div'); element.className = 'pdfToolWheel';
        Object.assign(element.style, { left: `${x-radius}px`, top: `${y-radius}px`, width: `${radius*2}px`, height: `${radius*2}px` });
        element.innerHTML = Array.from({length:6}, (_, i) => `<button data-sector="${i}">tool</button>`).join('') + '<svg>' + '<path></path>'.repeat(6) + '</svg>'; 
        document.body.append(element);
        window.wheel = { element, x, y, radius, pointerId: 1, items: Array.from({length:6}, (_, i) => ({label: `tool ${i}`, key: i === 0 ? 'highlight' : `tool${i}`, startAngle:240+i*60, endAngle:300+i*60})), sectors:[...element.querySelectorAll('path')] }; window.controller.decorate(window.wheel);
      };
    });
    for (const [x, y, radius] of [[160,120,80], [64,64,60], [256,64,60], [64,176,60], [256,176,60]]) {
      await page.evaluate(({x,y,radius}) => window.makeWheel(x,y,radius), {x,y,radius});
      const center = await page.evaluate(() => ({x:window.wheel.x, y:window.wheel.y}));
      await page.mouse.move(center.x, center.y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(center.x, center.y-radius*0.7);
      const ring = await page.$eval('.pdfToolWheelColorRing', node => ({ background:getComputedStyle(node).backgroundImage, pointerEvents:getComputedStyle(node).pointerEvents }));
      assert.match(ring.background, /255, 255, 152/);
      assert.equal(ring.pointerEvents, 'none');
      const rects = await page.$$eval('.pdfToolWheelColors span', nodes => nodes.map(node => {
        const r=node.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height };
      }));
      assert.equal(rects.length, 5);
      const radii = rects.map(r => Math.hypot(r.x + r.width / 2 - center.x, r.y + r.height / 2 - center.y));
      assert.ok(Math.max(...radii) - Math.min(...radii) < 1, JSON.stringify({x,y,radii}));
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.x+r.width <= 320 && r.y+r.height <= 240, JSON.stringify({x,y,r}));
        assert.ok(r.width >= 18 && r.height >= 18);
      }
      const swatch = rects[4];
      await page.mouse.move(swatch.x+swatch.width/2, swatch.y+swatch.height/2, {steps: 4});
      await page.mouse.up({ button: 'middle' });
      assert.equal(await page.evaluate(() => window.commits.at(-1)), '#FF4F5F');
    }
  } finally { await browser.close(); }
});
