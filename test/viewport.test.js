// Viewport model: pixelsPerSecond + scrollTime, mouse-anchored zoom,
// shift-wheel pan, follow suspension, minimap viewport box.
import { test, expect } from './base.js';
import path from 'path';

const FIXTURE = path.resolve('test/fixtures/sine-3s.mp3');

// helper: load a file into wavearea via file input
async function loadFile(page, filePath = FIXTURE) {
  const fileInput = page.locator('input#file');
  await fileInput.waitFor({ state: 'attached', timeout: 5000 });
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    fileInput.dispatchEvent('click')
  ]);
  await fileChooser.setFiles(filePath);
  await page.waitForFunction(() => {
    let el = document.querySelector('#editarea');
    return el && el.textContent.length > 10;
  }, { timeout: 15000 });
  await page.locator('#play').waitFor({ state: 'visible', timeout: 15000 });
}

// helper: open a long silence document so the page actually scrolls
// (spacing pins the char width — the ch-based max-width is font-racy)
async function openSilence(page, sec, minTotal) {
  await page.evaluate((s) => {
    document.querySelector('#wavearea').style.setProperty('--wavefont-spacing', '4px');
    wa.openSilence(s);
  }, sec);
  await page.waitForFunction((t) => !document.querySelector('#status') && wa.total > t, minTotal, { timeout: 30000 });
  await page.waitForTimeout(300);
}

// helper: ctrl/shift+wheel on the waveform (pinch arrives as ctrl+wheel)
const wheel = (page, init) => page.evaluate((i) => {
  document.querySelector('#waveform').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...i }));
}, init);

// helper: select an exact block range and run the editarea selection handler
const setSelection = (page, from, to) => page.evaluate(([f, t]) => {
  let node = document.querySelector('#editarea').firstChild;
  let isB = c => c >= 'Ā' && c < '̀';
  let toRaw = (b) => {
    let str = node.textContent, c = 0, raw = 0;
    while (c < b && raw < str.length) {
      if (isB(str[raw])) c++;
      raw++;
      while (raw < str.length && !isB(str[raw])) raw++;
    }
    return raw;
  };
  let sel = window.getSelection();
  sel.removeAllRanges();
  let r = new Range();
  r.setStart(node, toRaw(f));
  r.setEnd(node, toRaw(t));
  sel.addRange(r);
}, [from, to]);

const selectLoop = async (page, from, to) => {
  await setSelection(page, from, to);
  await page.locator('#editarea').dispatchEvent('focus');
  await page.waitForFunction(() => window.wa.loop === true, { timeout: 3000 });
};

const setCaret = (page, block) => page.evaluate((b) => {
  let node = document.querySelector('#editarea').firstChild;
  let isB = c => c >= 'Ā' && c < '̀';
  let str = node.textContent, clean = 0, raw = 0;
  while (clean < b && raw < str.length) {
    if (isB(str[raw])) clean++;
    raw++;
    while (raw < str.length && !isB(str[raw])) raw++;
  }
  window.getSelection().collapse(node, raw);
}, block);

const zoomTo = async (page, blockSize, dy) => {
  await wheel(page, { ctrlKey: true, deltaY: dy });
  await page.waitForFunction((bs) => wa.blockSize === bs, blockSize, { timeout: 10000 });
  await page.evaluate(() => wa._editQ); // anchor scroll runs after the rerender
  await page.waitForTimeout(200);
};


test.describe('viewport: zoom & pan', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.wa, { timeout: 5000 });
  });

  test('ctrl+wheel zoom keeps the time under the mouse fixed', async ({ page }) => {
    test.setTimeout(60000);
    await openSilence(page, 180, 5000);

    // scroll to the middle of the document
    await page.evaluate(() => wa._scrollToTime(wa.duration / 2));
    await page.waitForTimeout(200);

    let before = await page.evaluate(() => {
      let y = Math.round(innerHeight / 2);
      return { y, t: wa._timeAtY(scrollY + y) };
    });

    // pinch/ctrl+wheel zooms out one step, anchored at the mouse
    await wheel(page, { ctrlKey: true, deltaY: 120, clientX: before.x, clientY: before.y });
    await page.waitForFunction(() => wa.blockSize === 2048, { timeout: 10000 });
    await page.waitForTimeout(300);

    let after = await page.evaluate((y) => wa._timeAtY(scrollY + y), before.y);

    expect(after).not.toBeNull();
    // the waveform point under the mouse must not jump
    expect(Math.abs(after - before.t)).toBeLessThan(0.5);
  });

  test('wheel deltaMode lines convert to pixels before the zoom threshold', async ({ page }) => {
    await loadFile(page);
    // 2 lines × lineHeight ≈ 160px — past the 50px pinch threshold
    await wheel(page, { ctrlKey: true, deltaY: 2, deltaMode: 1 });
    await page.waitForFunction(() => wa.blockSize === 2048, { timeout: 10000 });
    expect(await page.evaluate(() => wa.blockSize)).toBe(2048);
  });

  test('scroll clamps to content: no negative time, no overshoot', async ({ page }) => {
    test.setTimeout(60000);
    // short audio fits the viewport — panning must not move at all
    await openSilence(page, 2, 50);
    await wheel(page, { shiftKey: true, deltaY: -5000 });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => wa.scrollTime)).toBe(0);
    await wheel(page, { shiftKey: true, deltaY: 5000 });
    await page.waitForTimeout(150);
    let short = await page.evaluate(() => ({ st: wa.scrollTime, dur: wa.duration, vd: wa.viewDuration }));
    expect(short.st).toBe(0); // viewDuration >= duration → max scroll is 0

    // long document: pan far past both ends
    await openSilence(page, 120, 3000);
    await page.evaluate(() => wa._scrollToTime(-10));
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => wa.scrollTime)).toBe(0);

    await page.evaluate(() => wa._scrollToTime(99999));
    await page.waitForTimeout(200);
    let long = await page.evaluate(() => ({ st: wa.scrollTime, dur: wa.duration, vd: wa.viewDuration }));
    expect(long.st).toBeGreaterThan(0);
    expect(long.st).toBeLessThanOrEqual(Math.max(0, long.dur - long.vd) + 0.1);

    // shift+wheel pans through time, clamped at the origin
    await page.evaluate(() => wa._scrollToTime(0));
    await page.waitForTimeout(150);
    await wheel(page, { shiftKey: true, deltaY: -3000 });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => wa.scrollTime)).toBe(0);
    await wheel(page, { shiftKey: true, deltaY: 300 });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => wa.scrollTime)).toBeGreaterThan(0);
  });

  test('selection and playhead keep their time across repeated zooms', async ({ page }) => {
    await loadFile(page);

    // loop-select a range — its seconds must survive the zoom round-trip
    await selectLoop(page, 20, 60);
    let selSec = await page.evaluate(() =>
      [wa.clipStart, wa.clipEnd].map(b => b * wa.blockSize / wa.sampleRate));

    await zoomTo(page, 2048, 120);
    await zoomTo(page, 4096, 120);
    await zoomTo(page, 2048, -120);
    await zoomTo(page, 1024, -120);

    let sel = await page.evaluate(() => ({
      loop: wa.loop,
      s: wa.clipStart * wa.blockSize / wa.sampleRate,
      e: wa.clipEnd * wa.blockSize / wa.sampleRate,
    }));
    expect(sel.loop).toBe(true);
    expect(Math.abs(sel.s - selSec[0])).toBeLessThan(0.05);
    expect(Math.abs(sel.e - selSec[1])).toBeLessThan(0.05);

    // playhead maps from the audio clock — zooming must not restart or shift it
    await page.keyboard.press('Escape'); // drop the loop selection first
    await setCaret(page, 5);
    await page.keyboard.press('Control+Space');
    await page.waitForFunction(() => wa.playing === true, { timeout: 5000 });
    await page.waitForTimeout(400);
    let t1 = await page.evaluate(() => wa.caretOffset * wa.blockSize / wa.sampleRate);

    await wheel(page, { ctrlKey: true, deltaY: 120 });
    await page.waitForFunction(() => wa.blockSize === 2048, { timeout: 10000 });
    await page.evaluate(() => wa._editQ);
    await page.waitForTimeout(200);

    let t2 = await page.evaluate(() => wa.caretOffset * wa.blockSize / wa.sampleRate);
    expect(await page.evaluate(() => wa.playing)).toBe(true);
    expect(t2).toBeGreaterThanOrEqual(t1); // no jump back
    expect(t2 - t1).toBeLessThan(1.5);     // no restart / jump forward

    // and back the other way
    await wheel(page, { ctrlKey: true, deltaY: -120 });
    await page.waitForFunction(() => wa.blockSize === 1024, { timeout: 10000 });
    await page.evaluate(() => wa._editQ);
    await page.waitForTimeout(200);
    let t3 = await page.evaluate(() => wa.caretOffset * wa.blockSize / wa.sampleRate);
    expect(t3).toBeGreaterThanOrEqual(t2);
    expect(await page.evaluate(() => wa.playing)).toBe(true);

    await page.keyboard.press('Control+Space');
  });

  test('minimap viewport box matches scrollTime and the playing playhead', async ({ page }) => {
    test.setTimeout(60000);
    await openSilence(page, 120, 3000);

    // drag the minimap to ~50% — scrollTime follows the pointer
    await page.locator('#mini-wave').scrollIntoViewIfNeeded();
    let mm = await page.locator('#mini-wave').boundingBox();
    await page.mouse.click(mm.x + mm.width * 0.5, mm.y + mm.height / 2);
    await page.waitForTimeout(250);
    let s = await page.evaluate(() => ({ st: wa.scrollTime, dur: wa.duration, vd: wa.viewDuration }));
    expect(Math.abs(s.st - (s.dur * 0.5 - s.vd / 2))).toBeLessThan(1);

    // the viewport box is computed from scrollTime + viewDuration
    let box = await page.evaluate(() => ({
      left: parseFloat(document.querySelector('#viewport').style.left),
      width: parseFloat(document.querySelector('#viewport').style.width),
      st: wa.scrollTime, vd: wa.viewDuration, dur: wa.duration,
    }));
    expect(Math.abs(box.left - box.st / box.dur * 100)).toBeLessThan(2);
    expect(Math.abs(box.width - box.vd / box.dur * 100)).toBeLessThan(2);

    // zoom after the minimap drag — the box stays aligned with the main axis
    await zoomTo(page, 2048, 120);
    let box2 = await page.evaluate(() => ({
      left: parseFloat(document.querySelector('#viewport').style.left),
      st: wa.scrollTime, dur: wa.duration,
    }));
    expect(Math.abs(box2.left - box2.st / box2.dur * 100)).toBeLessThan(2);

    // playback: the playhead time stays inside the viewport box while following
    await page.evaluate(() => { wa._scrollToTime(0); wa.jumpTo(0); wa.speed = 8 });
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+Space');
    await page.waitForFunction(() => wa.playing && wa.scrollTime > 0.2, { timeout: 15000 });
    let p = await page.evaluate(() => ({
      caret: wa.caretOffset * wa.blockSize / wa.sampleRate,
      st: wa.scrollTime, vd: wa.viewDuration,
    }));
    expect(p.caret).toBeGreaterThanOrEqual(p.st - 0.5);
    expect(p.caret).toBeLessThanOrEqual(p.st + p.vd + 0.5);
    await page.keyboard.press('Control+Space');
  });
});
