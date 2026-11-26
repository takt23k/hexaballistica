#!/usr/bin/env node
/**
 * HexaBallistica 自動プレイテスト＆物理検証ハーネス
 * 全6プリセットをヘッドレスChromeで実際にシミュレーション実行し、
 * 物理挙動の期待値チェック＋キーフレームスクリーンショットを出力します。
 *
 * 使い方:
 *   node scripts/playtest.mjs [出力ディレクトリ]
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(REPO_ROOT, '.playtest-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8775;
const CDP_PORT = 9235;

const PRESETS = [
  {
    key: 'cannon',
    name: '① 平滑バレル・火薬砲',
    frames: [24, 54, 120], // 0.4s, 0.9s, 2.0s
    check(init, snaps) {
      const fin = snaps[snaps.length - 1];
      const issues = [];
      if (fin.stats.maxSpeed < 250) issues.push(`弾速が低すぎる (maxSpeed=${fin.stats.maxSpeed} < 250)`);
      // 弾(slick)が右側(x>650)まで飛ぶか、または標的(light)が大きく崩れたか
      const slickMovedRight = snaps.some(s => s.bodies.some(b => b.mats.slick && b.x > 600));
      const targetDisturbed = fin.bodies.some(b => b.mats.light && (b.x > 870 || Math.abs(b.vx) > 40 || b.y > 460)) || fin.stats.brokenBonds > 0 || fin.stats.destroyedTris > 0;
      if (!slickMovedRight && !targetDisturbed) issues.push('砲弾が標的タワーに到達・着弾していない');
      return issues;
    }
  },
  {
    key: 'recoilless',
    name: '② 楔（くさび）弾＆無反動砲',
    frames: [24, 54, 120],
    check(init, snaps) {
      const fin = snaps[snaps.length - 1];
      const issues = [];
      if (fin.stats.maxSpeed < 220) issues.push(`弾速が低すぎる (maxSpeed=${fin.stats.maxSpeed} < 220)`);
      const slickFired = snaps.some(s => s.bodies.some(b => b.mats.slick && b.x > 550));
      if (!slickFired) issues.push('楔弾が十分に前進していない');
      return issues;
    }
  },
  {
    key: 'ricochet',
    name: '③ 60°斜面バウンド跳弾砲',
    frames: [30, 72, 140],
    check(init, snaps) {
      const fin = snaps[snaps.length - 1];
      const issues = [];
      if (fin.stats.maxSpeed < 200) issues.push(`初速が低すぎる (maxSpeed=${fin.stats.maxSpeed} < 200)`);
      // 跳弾して弾性ランプから空中へ跳ね返ったか（初期y=382より上へ跳ね上がり）
      const bounced = snaps.some(s => s.bodies.some(b => b.mats.elastic && b.totalTris === 6 && b.minY !== null && b.minY < 355 && b.x > 350));
      if (!bounced) issues.push('斜面で十分に上方向へ跳弾していない');
      return issues;
    }
  },
  {
    key: 'rocket',
    name: '④ ノズル形状・推進ロケット',
    frames: [36, 90, 160],
    check(init, snaps) {
      const fin = snaps[snaps.length - 1];
      const issues = [];
      if (fin.stats.maxSpeed < 120) issues.push(`ロケットの加速が不足 (maxSpeed=${fin.stats.maxSpeed} < 120)`);
      const initX = init.bodies[0]?.x || 150;
      const maxX = Math.max(...snaps.flatMap(s => s.bodies.filter(b => b.mats.energy_sustained || b.mats.light).map(b => b.x)), 0);
      const minY = Math.min(...snaps.flatMap(s => s.bodies.filter(b => b.mats.energy_sustained || b.mats.light).map(b => b.y)), 999);
      if (maxX - initX < 120 && minY > 300) issues.push(`ロケットの推進移動量が小さすぎる (dx=${Math.round(maxX - initX)}, minY=${Math.round(minY)})`);
      return issues;
    }
  },
  {
    key: 'rupture',
    name: '⑤ 薄肉ケーシング暴発テスト',
    frames: [18, 48, 100],
    check(init, snaps) {
      const fin = snaps[snaps.length - 1];
      const issues = [];
      if (fin.stats.brokenBonds === 0 && fin.stats.destroyedTris === 0) {
        issues.push('薄肉ケーシングが暴発・破断していない (brokenBonds=0, destroyedTris=0)');
      }
      return issues;
    }
  },
  {
    key: 'catapult',
    name: '⑥ 平板ビーム＆三角支点投石機',
    frames: [30, 75, 140],
    check(init, snaps) {
      const fin = snaps[snaps.length - 1];
      const issues = [];
      if (fin.stats.maxSpeed < 100) issues.push(`投石機の射出速度が不足 (maxSpeed=${fin.stats.maxSpeed} < 100)`);
      const launched = snaps.some(s => s.bodies.some(b => b.x > 480 && b.y < 420));
      if (!launched) issues.push('投石機の飛翔体が右上方へ十分に射出されていない');
      return issues;
    }
  }
];

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
    const runtimeErrors = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      if (msg.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
    });
    const send = (method, params = {}) => new Promise(res => {
      const id = ++cid;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJS = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.result?.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error(`${d.text}: ${d.exception?.description || ''}`);
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
      const ready = await evalJS('Boolean(window.__HB_DEBUG__)');
      if (ready) break;
      await sleep(150);
    }
    await sleep(300);

    const results = [];
    for (const p of PRESETS) {
      await evalJS(`window.__HB_DEBUG__.loadPreset('${p.key}'); window.__HB_DEBUG__.startSim();`);
      const init = await evalJS(`window.__HB_DEBUG__.getSnapshot()`);
      await shot(`${p.key}_0_init.png`);

      const snaps = [];
      let prevF = 0;
      for (let i = 0; i < p.frames.length; i++) {
        const delta = p.frames[i] - prevF;
        prevF = p.frames[i];
        const snap = await evalJS(`window.__HB_DEBUG__.stepFrames(${delta})`);
        snaps.push(snap);
        await shot(`${p.key}_${i + 1}_t${snap.simTime}s.png`);
      }

      const issues = p.check(init, snaps);
      const anyNaN = snaps.some(s => s.hasNaN);
      const anyTunnel = snaps.some(s => s.tunneled);
      if (anyNaN) issues.unshift('CRITICAL: NaN/Infinity 座標が発生');
      if (anyTunnel) issues.unshift('CRITICAL: 地面すり抜け（トンネリング）が発生');

      const fin = snaps[snaps.length - 1];
      results.push({
        key: p.key,
        name: p.name,
        pass: issues.length === 0,
        issues,
        stats: fin.stats,
        bodyCount: fin.bodyCount,
        hints: fin.hints
      });
    }

    console.log('\n=== HexaBallistica 自動プレイテスト結果 ===');
    for (const r of results) {
      const badge = r.pass ? 'PASS' : 'FAIL';
      console.log(`[${badge}] ${r.name} | maxSpd=${r.stats.maxSpeed} broken=${r.stats.brokenBonds} destroyed=${r.stats.destroyedTris} peakE=${r.stats.peakEnergy} bodies=${r.bodyCount}`);
      if (r.issues.length) r.issues.forEach(i => console.log(`   ↳ ${i}`));
      if (r.hints.length) console.log(`   ↳ Advisor: ${r.hints.join(' / ')}`);
    }
    if (runtimeErrors.length) {
      console.log('\nRUNTIME ERRORS:', runtimeErrors);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ results, runtimeErrors }, null, 2));
    const allPass = results.every(r => r.pass) && runtimeErrors.length === 0;
    process.exitCode = allPass ? 0 : 1;
  } finally {
    if (ws) ws.close();
    srv.kill();
    chrome.kill();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
