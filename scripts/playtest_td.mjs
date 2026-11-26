#!/usr/bin/env node
/**
 * HexaBallistica 防衛戦ステージ1（タワーディフェンス）自動プレイテスト
 * モバイル(360x800)＆デスクトップ(1080x640)の両方でUI崩れ・戦闘バランス・全3WAVEクリアを検証します。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(REPO_ROOT, '.playtest-out', 'td');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8779;
const CDP_PORT = 9239;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let wsUrl = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
        const page = list.find(t => t.type === 'page');
        if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(150);
    }
    if (!wsUrl) throw new Error('Failed to connect to Chrome CDP');

    ws = new WebSocket(wsUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let cid = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    });
    const send = (method, params = {}) => new Promise(res => {
      const id = ++cid; pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJS = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.result?.exceptionDetails) {
        throw new Error(`${r.result.exceptionDetails.text}: ${r.result.exceptionDetails.exception?.description || ''}`);
      }
      return r.result?.result?.value;
    };
    const shot = async (filename) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(r.result.data, 'base64'));
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 640, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 40; i++) {
      if (await evalJS('Boolean(window.__HB_DEBUG__?.td)')) break;
      await sleep(150);
    }
    await sleep(250);

    // 防衛戦を開く → 自作兵器・迫撃砲・散弾砲を配置
    await evalJS(`
      window.__HB_DEBUG__.td.open();
      window.__HB_DEBUG__.td.place(0, 'mortar');   // 45G
      window.__HB_DEBUG__.td.place(1, 'custom');   // 35G (自作兵器)
      window.__HB_DEBUG__.td.place(2, 'scatter');  // 40G
    `);
    await shot('td_desktop_setup.png');

    // WAVE 1 実行
    await evalJS(`window.__HB_DEBUG__.td.startWave()`);
    await evalJS(`window.__HB_DEBUG__.td.stepFrames(240)`);
    await shot('td_desktop_wave1_mid.png');
    let st = await evalJS(`window.__HB_DEBUG__.td.stepFrames(600)`);
    console.log('After Wave 1:', JSON.stringify(st));

    // WAVE 2: 稼いだ資金で前哨Dに衝撃榴弾砲を配置して実行
    await evalJS(`window.__HB_DEBUG__.td.place(3, 'he'); window.__HB_DEBUG__.td.startWave();`);
    await evalJS(`window.__HB_DEBUG__.td.stepFrames(300)`);
    await shot('td_desktop_wave2_mid.png');
    st = await evalJS(`window.__HB_DEBUG__.td.stepFrames(900)`);
    console.log('After Wave 2:', JSON.stringify(st));

    // WAVE 3 (BOSS WAVE)
    await evalJS(`window.__HB_DEBUG__.td.startWave()`);
    await evalJS(`window.__HB_DEBUG__.td.stepFrames(420)`);
    await shot('td_desktop_wave3_boss.png');
    st = await evalJS(`window.__HB_DEBUG__.td.stepFrames(1600)`);
    console.log('After Wave 3:', JSON.stringify(st));
    await shot('td_desktop_result.png');

    // モバイル360x800レイアウト確認
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await evalJS(`window.__HB_DEBUG__.td.reset(); window.__HB_DEBUG__.td.place(0, 'mortar'); window.__HB_DEBUG__.td.place(2, 'scatter'); window.__HB_DEBUG__.td.startWave(); window.__HB_DEBUG__.td.stepFrames(180);`);
    await sleep(150);
    await shot('td_mobile_360.png');
    const overflow = await evalJS('document.documentElement.scrollWidth > window.innerWidth');
    console.log('MOBILE 360 OVERFLOW:', overflow, 'ERRORS:', errors);

    if (st.status !== 'victory' || overflow || errors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (ws) ws.close();
    srv.kill();
    chrome.kill();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
