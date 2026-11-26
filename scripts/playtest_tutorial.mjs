#!/usr/bin/env node
/**
 * HexaBallistica チュートリアル専用プレイテスト＆パーツ別挙動ログ出力スクリプト
 * チュートリアル STEP 1〜5 を実行し、全パーツ（砲身・弾丸・ノーズ・標的タワー各層）の
 * 時系列挙動を tutorial_trace.json に記録＋コンソール要約出力します。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.argv[2] || path.join(REPO_ROOT, '.playtest-out', 'tutorial');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8778;
const CDP_PORT = 9238;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function classifyPart(b) {
  if (b.x < 400 && b.mats.dense && b.totalTris >= 30) return 'barrel(砲身)';
  if (b.x < 400 && b.mats.slick && b.mats.dense) return 'shell+nose(一体弾丸)';
  if (b.x < 400 && b.mats.slick) return 'shell(滑性弾体)';
  if (b.x < 400 && b.mats.dense && b.totalTris <= 4) return 'nose_detached(分離した先端!!)';
  if (b.x > 700 && b.mats.dense) return 'tower_cap(タワー天板)';
  if (b.x > 700 && b.mats.light) return `tower_slab(y=${Math.round(b.y)})`;
  return `part_${b.id}`;
}

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
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
      if (await evalJS('Boolean(window.__HB_DEBUG__)')) break;
      await sleep(150);
    }
    await sleep(250);

    // チュートリアル STEP 1〜4 を完了させる（STEP 4 でプレイヤーが「⚡異素材一括分離」を使ったケースを再現）
    await evalJS(`
      window.__HB_DEBUG__.startTutorial();
      window.__HB_DEBUG__.advanceTutorialStep(true); // STEP 1: 上壁
      window.__HB_DEBUG__.advanceTutorialStep(true); // STEP 2: 火薬
      window.__HB_DEBUG__.advanceTutorialStep(true); // STEP 3: 先端三角
      window.__HB_DEBUG__.advanceTutorialStep(true); // STEP 4: 切り離し
      window.__HB_DEBUG__.startSim();
    `);

    const init = await evalJS(`window.__HB_DEBUG__.getSnapshot()`);
    const roleMap = new Map();
    init.bodies.forEach(b => roleMap.set(b.id, classifyPart(b)));
    await shot('tut_0_t0.0s.png');

    // 0.1秒（6フレーム）ごとに 3.0秒間（30サンプル）全パーツの挙動を記録
    const trace = [{ t: 0, bodies: init.bodies.map(b => ({ ...b, role: roleMap.get(b.id) })), stats: init.stats }];
    const shotSteps = new Set([3, 8, 15, 22, 30]); // 0.3s, 0.8s, 1.5s, 2.2s, 3.0s

    for (let s = 1; s <= 30; s++) {
      const snap = await evalJS(`window.__HB_DEBUG__.stepFrames(6)`);
      const labeled = snap.bodies.map(b => ({
        ...b,
        role: roleMap.get(b.id) || `fragment_${b.id}`
      }));
      trace.push({ t: snap.simTime, bodies: labeled, stats: snap.stats, events: snap.events, hints: snap.hints });
      if (shotSteps.has(s)) {
        await shot(`tut_${s}_t${snap.simTime}s.png`);
      }
    }

    // パーツごとのサマリー集計
    const summary = {};
    for (const b of init.bodies) {
      const role = roleMap.get(b.id);
      summary[b.id] = {
        id: b.id,
        role,
        mats: b.mats,
        initX: b.x, initY: b.y,
        finalX: b.x, finalY: b.y,
        maxX: b.x, minX: b.x, minY: b.y, maxY: b.y,
        maxSpeed: 0, maxAngleDeg: 0, minHpPct: 100
      };
    }
    for (const frame of trace) {
      for (const b of frame.bodies) {
        if (!summary[b.id]) continue;
        const s = summary[b.id];
        s.finalX = b.x; s.finalY = b.y;
        s.maxX = Math.max(s.maxX, b.x);
        s.minX = Math.min(s.minX, b.x);
        s.minY = Math.min(s.minY, b.y);
        s.maxY = Math.max(s.maxY, b.y);
        s.maxSpeed = Math.max(s.maxSpeed, b.speed);
        s.maxAngleDeg = Math.max(s.maxAngleDeg, Math.abs(b.angleDeg));
        s.minHpPct = Math.min(s.minHpPct, b.hpPct);
      }
    }

    const finalSnap = trace[trace.length - 1];
    const report = {
      initBodyCount: init.bodyCount,
      finalBodyCount: finalSnap.bodies.length,
      finalStats: finalSnap.stats,
      events: finalSnap.events,
      hints: finalSnap.hints,
      partsSummary: Object.values(summary),
      trace
    };
    fs.writeFileSync(path.join(OUT_DIR, 'tutorial_trace.json'), JSON.stringify(report, null, 2));

    console.log('\n=== チュートリアル パーツ別挙動ログ要約 (t=0.0s -> 3.0s) ===');
    for (const p of Object.values(summary)) {
      const dx = Math.round(p.finalX - p.initX);
      const dy = Math.round(p.finalY - p.initY);
      console.log(
        `  #${p.id} ${p.role.padEnd(26)} | pos:(${p.initX},${p.initY})->(${p.finalX},${p.finalY}) Δ(${dx>=0?'+':''}${dx},${dy>=0?'+':''}${dy}) | maxSpd:${String(p.maxSpeed).padStart(3)} | rot:${p.maxAngleDeg}° | hp:${p.minHpPct}%`
      );
    }
    console.log('\nイベントログ:', finalSnap.events.map(e => `[${e.t}s] ${e.msg}`).join(' / ') || 'なし');
    // 着弾前（t=0.8s時点）のタワー静止精度＆壁上漏れチェック
    const preHit = trace.find(f => Math.abs(f.t - 0.8) < 0.06) || trace[8];
    let maxPreDrift = 0;
    for (const b of preHit.bodies) {
      const initB = init.bodies.find(x => x.id === b.id);
      if (initB && initB.x > 700) {
        maxPreDrift = Math.max(maxPreDrift, Math.hypot(b.x - initB.x, b.y - initB.y));
      }
    }
    const maxLeakAbove = Math.max(...trace.slice(0, 12).map(f => f.stats.leakAboveBarrel || 0));
    console.log(`着弾前(t=0.8s)タワー最大ズレ: ${maxPreDrift.toFixed(2)}px | 砲身上壁からの圧力漏れ: ${maxLeakAbove}`);
    console.log('最終統計:', JSON.stringify(finalSnap.stats));
    console.log('詳細ログ保存先:', path.join(OUT_DIR, 'tutorial_trace.json'));
  } finally {
    if (ws) ws.close();
    srv.kill();
    chrome.kill();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
