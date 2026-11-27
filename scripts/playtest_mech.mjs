#!/usr/bin/env node
/**
 * HexaBallistica 機構ブロック（センサー・角度調整ヒンジ・自動装填・弾消滅タイマー）自動プレイテスト
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(REPO_ROOT, '.playtest-out', 'mech_lab');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8782;
const CDP_PORT = 9242;
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
      if (await evalJS('Boolean(window.__HB_DEBUG__?.mech)')) break;
      await sleep(150);
    }
    await sleep(250);

    // 1. 設計モード確認（デスクトップ）
    await evalJS(`window.__HB_DEBUG__.loadPreset('mech_lab')`);
    await sleep(150);
    const designState = await evalJS(`window.__HB_DEBUG__.mech.getState()`);
    console.log('1) DESIGN:', JSON.stringify(designState));
    await shot('mech_design_desktop.png');

    // 2. 自動追尾(auto) + 装填1.5s + 弾消滅3.0s で実射テスト
    await evalJS(`
      window.__HB_DEBUG__.mech.setParams({ reloadInterval: 1.5, shellLifetime: 3, rotatorMode: 'auto', sensorRange: 700 });
      window.__HB_DEBUG__.startSim();
    `);
    const s05 = await evalJS(`window.__HB_DEBUG__.stepFrames(30); window.__HB_DEBUG__.mech.getState()`);
    console.log('2a) t=0.5s:', JSON.stringify(s05));
    await shot('mech_sim_t05.png');

    const s15 = await evalJS(`window.__HB_DEBUG__.stepFrames(60); window.__HB_DEBUG__.mech.getState()`);
    console.log('2b) t=1.5s:', JSON.stringify(s15));

    const s35 = await evalJS(`window.__HB_DEBUG__.stepFrames(120); window.__HB_DEBUG__.mech.getState()`);
    console.log('2c) t=3.5s:', JSON.stringify(s35));
    await shot('mech_sim_t35.png');

    const s55 = await evalJS(`window.__HB_DEBUG__.stepFrames(120); window.__HB_DEBUG__.mech.getState()`);
    const snap55 = await evalJS(`window.__HB_DEBUG__.getSnapshot()`);
    console.log('2d) t=5.5s:', JSON.stringify(s55), 'NaN:', snap55.hasNaN, 'tunneled:', snap55.tunneled);
    await shot('mech_sim_t55.png');

    // 3. 固定角度(-25°) + 弾消えない(0) テスト
    await evalJS(`
      window.__HB_DEBUG__.stopSim();
      window.__HB_DEBUG__.loadPreset('mech_lab');
      window.__HB_DEBUG__.mech.setParams({ reloadInterval: 1.5, shellLifetime: 0, rotatorMode: '-25', sensorRange: 700 });
      window.__HB_DEBUG__.startSim();
      window.__HB_DEBUG__.stepFrames(240);
    `);
    const fixedState = await evalJS(`window.__HB_DEBUG__.mech.getState()`);
    console.log('3) FIXED -25deg / lifetime=0 (t=4.0s):', JSON.stringify(fixedState));
    await shot('mech_sim_fixed25.png');

    // 4. モバイル360x800確認（設計モード＋実射モード）
    await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    await evalJS(`
      window.__HB_DEBUG__.stopSim();
      window.__HB_DEBUG__.loadPreset('mech_lab');
      window.__HB_DEBUG__.mech.setParams({ reloadInterval: 1.5, shellLifetime: 3, rotatorMode: 'auto', sensorRange: 700 });
    `);
    await sleep(150);
    await shot('mech_design_mobile360.png');
    const mobileOverflowDesign = await evalJS('document.documentElement.scrollWidth > window.innerWidth');

    await evalJS(`
      window.__HB_DEBUG__.startSim();
      window.__HB_DEBUG__.stepFrames(120);
    `);
    await sleep(150);
    await shot('mech_sim_mobile360.png');
    const mobileOverflowSim = await evalJS('document.documentElement.scrollWidth > window.innerWidth');
    console.log('4) MOBILE OVERFLOW design/sim:', mobileOverflowDesign, mobileOverflowSim, 'ERRORS:', errors);

    // アサーション
    const checks = {
      mechBarVisible: designState.mechBarVisible,
      sensorLocked: s05.sensorLocked,
      rotatorTilted: s05.gunAngleDeg < -5 && s55.gunAngleDeg > -35 && s55.gunAngleDeg < -5,
      reloadedAndFired: s55.shotsFired >= 2,
      shellsDespawned: s55.shellCount < s55.shotsFired, // 3秒消滅が効いていれば、発射数より残存弾数が少ない
      blocksAttached: Boolean(s55.gunMats.sensor && s55.gunMats.rotator && s55.gunMats.loader),
      fixedAngleWorks: Math.abs(fixedState.gunAngleDeg - (-25)) < 4,
      infiniteLifetimeWorks: fixedState.shellCount >= fixedState.shotsFired && fixedState.shotsFired >= 2,
      noNaNOrTunnel: !snap55.hasNaN && !snap55.tunneled,
      noOverflow: !mobileOverflowDesign && !mobileOverflowSim,
      noErrors: errors.length === 0
    };
    console.log('CHECKS:', JSON.stringify(checks, null, 2));
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0) {
      console.error('FAILED CHECKS:', failed);
      process.exitCode = 1;
    }
  } finally {
    if (ws) ws.close();
    srv.kill();
    chrome.kill();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
