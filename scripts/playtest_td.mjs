#!/usr/bin/env node
/**
 * HexaBallistica 実物理TD（装填・熱疲労・センサー・角度調整・実物理敵撃破）自動プレイテスト
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(REPO_ROOT, '.playtest-out', 'real_td');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8780;
const CDP_PORT = 9240;
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

    // 1. 安価・軽質砲 × 高速連射(1.0s) → 過熱・疲労テスト
    await evalJS(`window.__HB_DEBUG__.td.open('td_cheap', 1.0)`);
    let cheapFast = await evalJS(`window.__HB_DEBUG__.td.stepFrames(240)`);
    console.log('1) 安価軽質×高速(1.0s):', JSON.stringify(cheapFast));
    await shot('real_td_cheap_overheat.png');

    // 2. センサー追尾・角度調整砲 × 標準連射(1.8s) → 旋回・装填・撃破テスト
    await evalJS(`window.__HB_DEBUG__.td.open('td_smart', 1.8)`);
    let smartMid = await evalJS(`window.__HB_DEBUG__.td.stepFrames(240)`);
    await shot('real_td_smart_mid.png');
    console.log('2) センサー追尾・角度調整砲:', JSON.stringify(smartMid));

    // 3. 重装甲・高速連射砲 × 高速連射(1.0s) → 熱に耐えて撃破テスト
    await evalJS(`window.__HB_DEBUG__.td.open('td_heavy', 1.0)`);
    let heavyMid = await evalJS(`window.__HB_DEBUG__.td.stepFrames(300)`);
    await shot('real_td_heavy_mid.png');
    console.log('3) 重装甲×高速(1.0s):', JSON.stringify(heavyMid));

    // 4. モバイル360x800確認
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await evalJS(`window.__HB_DEBUG__.td.open('td_smart', 1.8); window.__HB_DEBUG__.td.stepFrames(150);`);
    await sleep(150);
    await shot('real_td_mobile_360.png');
    const overflow = await evalJS('document.documentElement.scrollWidth > window.innerWidth');
    console.log('MOBILE 360 OVERFLOW:', overflow, 'ERRORS:', errors);

    if (overflow || errors.length > 0 || smartMid.shotsFired < 2 || heavyMid.shotsFired < 3) {
      process.exitCode = 1;
    }
  } finally {
    if (ws) ws.close();
    srv.kill();
    chrome.kill();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
