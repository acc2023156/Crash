(function () {
  'use strict';
  const { CFG, STYLES, Engine, multAt, timeFor, crashFromSeed, floor2 } = window.Crash;

  let store = null;
  try { store = window.localStorage; store.setItem('__t', '1'); store.removeItem('__t'); } catch (e) { store = null; }

  const eng = new Engine(store);
  const $ = s => document.querySelector(s);
  const fmt = v => (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtX = v => v.toFixed(2) + '×';
  const signed = v => (v >= 0 ? '+' : '') + fmt(v);

  const el = {
    balance: $('#balance'), history: $('#history'), live: $('#liveCashouts'),
    roundNo: $('#roundNo'), playerCount: $('#playerCount'), totalBet: $('#totalBet'), totalWon: $('#totalWon'),
    amount: $('#betAmount'), target: $('#autoCashout'), autoFields: $('#autoFields'),
    autoCount: $('#autoCount'), onWin: $('#onWin'), onLoss: $('#onLoss'),
    profitHint: $('#profitHint'), mainBtn: $('#mainBtn'),
    botMin: $('#botMin'), botMax: $('#botMax'), botRangeText: $('#botRangeText'),
    betList: $('#betList'), accList: $('#accList'), mineList: $('#mineList'),
    fairModal: $('#fairModal'), fairList: $('#fairList'), fairCurrent: $('#fairCurrent'),
    toasts: $('#toasts'),
  };

  let mode = 'manual';
  let tab = 'bets';
  let dirtyBets = true, dirtyAcc = true, dirtyMine = true;
  let liveCashouts = [];
  const MILESTONES = [2, 5, 10, 20, 50, 100];
  let milestoneIdx = 0, lastTickSec = 0;

  /* ---------- toast ---------- */
  function toast(msg, type = 'info') {
    const d = document.createElement('div');
    d.className = 'toast ' + type;
    d.textContent = msg;
    el.toasts.appendChild(d);
    setTimeout(() => d.remove(), 2600);
    while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
  }

  /* ---------- engine events ---------- */
  eng.on('toast', t => toast(t.msg, t.type));
  eng.on('balance', () => { el.balance.textContent = fmt(eng.player.balance); updateProfitHint(); });
  eng.on('round', r => {
    liveCashouts = [];
    el.live.innerHTML = '';
    el.roundNo.textContent = r.id;
    dirtyBets = true;
  });
  eng.on('bet', b => {
    dirtyBets = true;
    if (b === null) Sound.cancel();
    else if (b.isPlayer) Sound.bet();
  });
  eng.on('run', () => { milestoneIdx = 0; Sound.launch(); Sound.humStart(); });
  eng.on('cashout', b => {
    dirtyBets = true;
    liveCashouts.unshift(b);
    liveCashouts.length = Math.min(liveCashouts.length, 4);
    el.live.innerHTML = liveCashouts.map(c =>
      `<div>${c.isPlayer ? '⭐ 你' : c.hidden ? '🕶 Hidden' : c.name}<b>${fmtX(c.cashedAt)}</b><b>+${fmt(c.payout)}</b></div>`).join('');
    if (b.isPlayer) Sound.win(); else Sound.blip();
    if (b.isPlayer) toast(`兌現成功 ${fmtX(b.cashedAt)}　+${fmt(b.payout - b.amount)}`, 'win');
  });
  eng.on('crash', r => {
    dirtyBets = dirtyAcc = dirtyMine = true;
    renderHistory(true);
    Sound.humStop();
    Sound.crash();
    const mine = r.bets.find(b => b.isPlayer);
    if (mine && !mine.cashedAt) Sound.lose();
    if (mine && !mine.cashedAt) toast(`崩盤於 ${fmtX(r.crash)}　−${fmt(mine.amount)}`, 'lose');
  });
  eng.on('auto', () => { syncModeUI(); });

  /* ---------- history chips ---------- */
  function chipClass(x) { return x >= 10 ? 'y' : x >= 2 ? 'g' : x < 1.2 ? 'r' : ''; }
  function renderHistory(fresh) {
    el.history.innerHTML = eng.history.slice(0, 30).map((h, i) =>
      `<button type="button" class="chip ${chipClass(h.crash)} ${fresh && i === 0 ? 'new' : ''}" data-round="${h.id}">${fmtX(h.crash)}</button>`).join('');
  }
  el.history.addEventListener('click', e => {
    const b = e.target.closest('[data-round]');
    if (b) openFair(+b.dataset.round);
  });

  /* ---------- lists ---------- */
  function nameCell(b) {
    if (b.isPlayer) return `<span class="name"><i style="background:var(--green)"></i>你</span>`;
    if (b.hidden) return `<span class="name hid"><i style="background:#557086"></i>🕶 Hidden</span>`;
    return `<span class="name"><i style="background:${b.acc.color}"></i>${b.name}</span>`;
  }
  function renderBets() {
    const r = eng.round;
    const bets = r.bets.slice().sort((a, b) => (b.isPlayer - a.isPlayer) || (b.amount - a.amount));
    const total = bets.reduce((s, b) => s + b.amount, 0);
    const won = bets.reduce((s, b) => s + b.payout, 0);
    el.playerCount.textContent = bets.length;
    el.totalBet.textContent = fmt(total);
    el.totalWon.textContent = fmt(won);
    if (!bets.length) { el.betList.innerHTML = `<div class="empty">等待玩家下注…</div>`; return; }
    const crashed = r.phase === 'crashed';
    el.betList.innerHTML = bets.map(b => {
      const cls = b.cashedAt ? 'won' : crashed ? 'lost' : '';
      const mult = b.cashedAt ? fmtX(b.cashedAt) : crashed ? '崩' : '-';
      const pay = b.cashedAt ? '+' + fmt(b.payout) : crashed ? '−' + fmt(b.amount) : '-';
      return `<div class="row ${cls} ${b.isPlayer ? 'me' : ''}">${nameCell(b)}<span>${fmt(b.amount)}</span><span class="mult">${mult}</span><span class="pay">${pay}</span></div>`;
    }).join('');
  }
  function renderAccounts() {
    const inRound = new Set(eng.round.bets.map(b => b.acc.id));
    const list = eng.accounts.slice().sort((a, b) => b.balance - a.balance);
    el.accList.innerHTML = list.map(a =>
      `<div class="row"><span class="name"><i style="background:${a.color}"></i>${a.name}${a.hidden ? ' 🕶' : ''}${inRound.has(a.id) ? ' <em class="tag in">本局</em>' : ''}</span>` +
      `<span><em class="tag">${STYLES[a.style].label}</em></span><span>${fmt(a.balance)}</span>` +
      `<span class="${a.profit >= 0 ? 'pos' : 'neg'}">${signed(a.profit)}</span></div>`).join('');
  }
  function renderMine() {
    const h = eng.player.history;
    if (!h.length) { el.mineList.innerHTML = `<div class="empty">還沒有紀錄，下一注吧！</div>`; return; }
    el.mineList.innerHTML = h.map(x =>
      `<div class="row ${x.cashedAt ? 'won' : 'lost'}"><span>#${x.id}</span><span>${fmt(x.amount)}</span>` +
      `<span class="mult">${x.cashedAt ? fmtX(x.cashedAt) : '崩 ' + fmtX(x.crash)}</span><span class="pay">${signed(x.profit)}</span></div>`).join('');
  }

  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    ['bets', 'accounts', 'mine'].forEach(t => { $('#tab-' + t).hidden = t !== tab; });
    dirtyBets = dirtyAcc = dirtyMine = true;
  });

  /* ---------- controls ---------- */
  function readAmount() { return Math.max(0, +el.amount.value || 0); }
  function readTarget() { return +el.target.value || 0; }
  function updateProfitHint() {
    const t = readTarget();
    el.profitHint.textContent = t >= 1.01 ? fmt(readAmount() * (t - 1)) : '手動兌現';
  }
  el.amount.addEventListener('input', updateProfitHint);
  el.target.addEventListener('input', updateProfitHint);
  document.querySelectorAll('[data-amt]').forEach(b => b.addEventListener('click', () => {
    let v = readAmount();
    if (b.dataset.amt === 'half') v = v / 2;
    else if (b.dataset.amt === 'double') v = v * 2;
    else v = eng.player.balance;
    v = Math.min(Math.max(CFG.MIN_BET, Math.floor(v * 100) / 100), Math.max(CFG.MIN_BET, eng.player.balance));
    el.amount.value = v.toFixed(2);
    updateProfitHint();
  }));

  $('#modeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b || eng.auto.on) return;
    mode = b.dataset.mode;
    syncModeUI();
  });
  function syncModeUI() {
    document.querySelectorAll('#modeSeg button').forEach(x => {
      x.classList.toggle('on', x.dataset.mode === mode);
      x.disabled = eng.auto.on && x.dataset.mode !== mode;
    });
    el.autoFields.hidden = mode !== 'auto';
    [el.amount, el.target, el.autoCount, el.onWin, el.onLoss].forEach(i => { i.disabled = eng.auto.on; });
  }

  let btnKey = '';
  function updateButton(now) {
    const r = eng.round, bet = eng.myBet();
    let cls = '', label = '', sub = '';
    if (eng.auto.on) {
      cls = 'stop'; label = '停止自動投注';
      sub = `下注 ${fmt(eng.auto.amount)} @ ${fmtX(eng.auto.target)}` + (eng.auto.remaining ? `　剩 ${eng.auto.remaining} 局` : '　無限');
    } else if (r.phase === 'running' && bet && !bet.cashedAt) {
      const m = floor2(Math.min(multAt(now - r.phaseStart), r.crash));
      cls = 'cash'; label = '兌現 ' + fmt(bet.amount * m); sub = fmtX(m);
    } else if (r.phase === 'betting' && bet) {
      cls = 'cancel'; label = '取消下注'; sub = `${fmt(bet.amount)}${bet.target ? ' @ ' + fmtX(bet.target) : ''}`;
    } else if (eng.queued) {
      cls = 'queued'; label = '取消（已排下一局）'; sub = fmt(eng.queued.amount);
    } else if (mode === 'auto') {
      label = '開始自動投注';
    } else if (r.phase === 'betting') {
      label = '下注';
    } else {
      label = '下注（下一局）';
      if (bet && bet.cashedAt) sub = `本局已兌現 ${fmtX(bet.cashedAt)}`;
    }
    const key = cls + label + sub;
    if (key === btnKey) return;
    btnKey = key;
    el.mainBtn.className = 'main-btn ' + cls;
    el.mainBtn.innerHTML = label + (sub ? `<small>${sub}</small>` : '');
  }

  function onMain() {
    const now = performance.now();
    const r = eng.round, bet = eng.myBet();
    if (eng.auto.on) { eng.stopAuto('已停止自動投注'); return; }
    if (r.phase === 'running' && bet && !bet.cashedAt) { eng.cashOut(now); return; }
    if ((r.phase === 'betting' && bet) || eng.queued) { eng.cancelBet(); return; }
    if (mode === 'auto') {
      eng.startAuto({ amount: readAmount(), target: readTarget(), count: +el.autoCount.value, winPct: +el.onWin.value, lossPct: +el.onLoss.value });
      return;
    }
    eng.placeBet(readAmount(), readTarget());
  }
  el.mainBtn.addEventListener('click', onMain);
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || e.repeat) return;
    if (/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    onMain();
  });

  /* ---------- simulation settings ---------- */
  function syncBotRange() {
    el.botMin.value = eng.settings.botMin;
    el.botMax.value = eng.settings.botMax;
    const lo = Math.min(eng.settings.botMin, eng.settings.botMax), hi = Math.max(eng.settings.botMin, eng.settings.botMax);
    el.botRangeText.textContent = `${lo} ~ ${hi} 人`;
  }
  [el.botMin, el.botMax].forEach(i => i.addEventListener('input', () => {
    eng.setBotRange(+el.botMin.value, +el.botMax.value);
    syncBotRange();
  }));
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('確定要重置 100 個帳號與你的餘額？')) return;
    eng.reset();
    location.reload();
  });

  /* ---------- fairness ---------- */
  function openFair(focusId) {
    const r = eng.round;
    el.fairCurrent.innerHTML = `目前第 <b>${r.id}</b> 局 hash：<br><code>${r.hash}</code><br>` +
      (r.phase === 'crashed' ? `seed：<code>${r.seed}</code>` : '<span class="hint">seed 將在崩盤後公開</span>');
    el.fairList.innerHTML = eng.history.map(h =>
      `<details ${h.id === focusId ? 'open' : ''} data-id="${h.id}"><summary><span>#${h.id}</span><b class="chip ${chipClass(h.crash)}">${fmtX(h.crash)}</b></summary>` +
      `<div class="kv">hash：<code>${h.hash}</code></div><div class="kv">seed：<code>${h.seed}</code></div>` +
      `<div class="kv verify"></div></details>`).join('') || '<div class="empty">尚無已結束的局</div>';
    el.fairList.querySelectorAll('details').forEach(d => {
      const run = () => {
        const h = eng.history.find(x => x.id === +d.dataset.id);
        const hashOk = window.sha256(h.seed) === h.hash;
        const c = crashFromSeed(h.seed, h.id);
        d.querySelector('.verify').innerHTML = `重新計算：SHA256(seed) ${hashOk ? '<span class="ok">相符 ✓</span>' : '<span class="neg">不符 ✗</span>'}，崩盤點 ${fmtX(c)} ${c === h.crash ? '<span class="ok">✓</span>' : '<span class="neg">✗</span>'}`;
      };
      if (d.open) run();
      d.addEventListener('toggle', () => { if (d.open) run(); });
    });
    el.fairModal.hidden = false;
  }
  $('#fairBtn').addEventListener('click', () => openFair());
  el.fairModal.addEventListener('click', e => {
    if (e.target === el.fairModal || e.target.closest('[data-close]')) el.fairModal.hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') el.fairModal.hidden = true; });

  /* ---------- chart ---------- */
  const cv = $('#chart'), ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    const rect = cv.parentElement.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = rect.width; H = rect.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  new ResizeObserver(resize).observe(cv.parentElement);
  resize();

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  function draw(now) {
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const r = eng.round;
    let t = 0, m = 1;
    if (r.phase === 'running') { t = now - r.phaseStart; m = Math.min(multAt(t), r.crash); }
    else if (r.phase === 'crashed') { t = timeFor(r.crash); m = r.crash; }

    const small = W < 500;
    const P = { l: small ? 42 : 54, r: 14, t: 14, b: 26 };
    const gw = W - P.l - P.r, gh = H - P.t - P.b;
    const xMax = Math.max(10000, t * 1.1);
    const yMax = Math.max(2, 1 + (m - 1) * 1.15);
    const X = ms => P.l + (ms / xMax) * gw;
    const Y = v => P.t + gh - ((v - 1) / (yMax - 1)) * gh;

    // 格線與刻度
    ctx.font = `${small ? 10 : 12}px system-ui, sans-serif`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.fillStyle = '#7f8ea3';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ys = niceStep((yMax - 1) / 5);
    for (let k = 0; 1 + k * ys <= yMax + 1e-9; k++) {
      const v = 1 + k * ys, y = Y(v);
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(W - P.r, y); ctx.stroke();
      ctx.fillText((v < 10 ? v.toFixed(1) : Math.round(v)) + '×', P.l - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const xs = niceStep(xMax / 1000 / (small ? 4 : 6)) * 1000;
    for (let k = 1; k * xs <= xMax; k++) ctx.fillText((k * xs / 1000) + 's', X(k * xs), H - P.b + 7);

    const crashed = r.phase === 'crashed';
    if (t > 0) {
      const N = 90;
      const pts = [];
      for (let i = 0; i <= N; i++) { const ti = (t * i) / N; pts.push([X(ti), Y(Math.min(multAt(ti), m))]); }
      // 填色
      const g = ctx.createLinearGradient(0, Y(m), 0, Y(1));
      if (crashed) { g.addColorStop(0, 'rgba(237,65,99,.55)'); g.addColorStop(1, 'rgba(237,65,99,.08)'); }
      else { g.addColorStop(0, 'rgba(255,159,28,.95)'); g.addColorStop(1, 'rgba(255,159,28,.35)'); }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], Y(1));
      pts.forEach(p => ctx.lineTo(p[0], p[1]));
      ctx.lineTo(pts[N][0], Y(1));
      ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      // 曲線
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = crashed ? '#ed4163' : '#ffffff';
      ctx.lineWidth = small ? 3 : 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
      // 本局兌現點
      r.bets.forEach(b => {
        if (!b.cashedAt) return;
        const x = X(timeFor(b.cashedAt)), y = Y(b.cashedAt);
        ctx.beginPath(); ctx.arc(x, y, b.isPlayer ? 5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = b.isPlayer ? '#00e701' : 'rgba(255,255,255,.6)'; ctx.fill();
      });
      // 尖端
      ctx.beginPath(); ctx.arc(pts[N][0], pts[N][1], small ? 5 : 7, 0, Math.PI * 2);
      ctx.fillStyle = crashed ? '#ed4163' : '#ffffff'; ctx.fill();
    }

    // 中央文字
    const cx = P.l + gw / 2, cy = P.t + gh * (small ? 0.48 : 0.38);
    const big = Math.max(30, Math.min(W * 0.12, H * 0.22, 96));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (r.phase === 'betting') {
      const left = Math.max(0, CFG.BET_MS - (now - r.phaseStart));
      ctx.fillStyle = '#b1bad3';
      ctx.font = `600 ${Math.round(big * 0.28)}px system-ui, sans-serif`;
      ctx.fillText('下一局開始於', cx, cy - big * 0.55);
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 ${Math.round(big * 0.8)}px system-ui, sans-serif`;
      ctx.fillText((left / 1000).toFixed(1) + 's', cx, cy + big * 0.1);
      const bw = Math.min(gw * 0.6, 320), bx = cx - bw / 2, by = cy + big * 0.7;
      ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(bx, by, bw, 6);
      ctx.fillStyle = '#ff9f1c'; ctx.fillRect(bx, by, bw * (left / CFG.BET_MS), 6);
    } else {
      if (crashed) {
        ctx.fillStyle = '#ed4163';
        ctx.font = `700 ${Math.round(big * 0.3)}px system-ui, sans-serif`;
        ctx.fillText('崩盤！', cx, cy - big * 0.65);
      }
      ctx.fillStyle = crashed ? '#ed4163' : '#ffffff';
      ctx.font = `800 ${Math.round(big)}px system-ui, sans-serif`;
      ctx.fillText(fmtX(floor2(m)), cx, cy);
      const mine = eng.myBet();
      if (mine && mine.cashedAt) {
        const txt = `已兌現 ${fmtX(mine.cashedAt)}  +${fmt(mine.payout - mine.amount)}`;
        ctx.font = `700 ${Math.round(big * 0.24)}px system-ui, sans-serif`;
        const tw = ctx.measureText(txt).width + 28, th = big * 0.44;
        ctx.fillStyle = 'rgba(33,55,67,.95)';
        roundRect(cx - tw / 2, cy + big * 0.62 - th / 2, tw, th, 8); ctx.fill();
        ctx.fillStyle = '#00e701';
        ctx.fillText(txt, cx, cy + big * 0.62);
      }
    }
  }
  function roundRect(x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
  }

  /* ---------- sound ---------- */
  function soundFrame(now) {
    const r = eng.round;
    if (r.phase === 'betting') {
      const sec = Math.ceil((CFG.BET_MS - (now - r.phaseStart)) / 1000);
      if (sec <= 3 && sec >= 1 && sec !== lastTickSec) Sound.tick(sec === 1);
      lastTickSec = sec;
    } else if (r.phase === 'running') {
      const m = multAt(now - r.phaseStart);
      Sound.humUpdate(m);
      if (m >= MILESTONES[milestoneIdx] && m < r.crash) Sound.milestone(MILESTONES[milestoneIdx++]);
    }
  }
  const soundBtn = $('#soundBtn');
  function renderSound() {
    soundBtn.textContent = Sound.enabled ? '🔊' : '🔇';
    soundBtn.classList.toggle('off', !Sound.enabled);
    soundBtn.setAttribute('aria-pressed', String(Sound.enabled));
  }
  soundBtn.addEventListener('click', () => {
    Sound.toggle();
    Sound.unlock();
    if (Sound.enabled && eng.round.phase === 'running') Sound.humStart();
    renderSound();
  });
  // 瀏覽器要求使用者操作後才能出聲
  const unlock = () => {
    Sound.unlock();
    if (eng.round.phase === 'running') Sound.humStart();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) Sound.humStop();
    else if (eng.round.phase === 'running') Sound.humStart();
  });
  renderSound();

  /* ---------- loops ---------- */
  let lastList = 0;
  function frame(now) {
    eng.tick(now);
    soundFrame(now);
    draw(now);
    updateButton(now);
    if (now - lastList > 120) {
      lastList = now;
      if (tab === 'bets' && dirtyBets) { dirtyBets = false; renderBets(); }
      if (tab === 'accounts' && dirtyAcc) { dirtyAcc = false; renderAccounts(); }
      if (tab === 'mine' && dirtyMine) { dirtyMine = false; renderMine(); }
      if (tab !== 'bets' && dirtyBets) { // 頁尾統計仍要更新
        const bets = eng.round.bets;
        el.playerCount.textContent = bets.length;
        el.totalBet.textContent = fmt(bets.reduce((s, b) => s + b.amount, 0));
        el.totalWon.textContent = fmt(bets.reduce((s, b) => s + b.payout, 0));
      }
    }
    requestAnimationFrame(frame);
  }
  // 分頁在背景時 rAF 會停，改用計時器推進遊戲，保持自動兌現準確
  setInterval(() => { if (document.hidden) eng.tick(performance.now()); }, 250);

  eng.start(performance.now());
  el.balance.textContent = fmt(eng.player.balance);
  renderHistory(false);
  syncBotRange();
  syncModeUI();
  updateProfitHint();
  requestAnimationFrame(frame);

  // 跑馬燈：兩份相同文字捲動一半寬度形成無縫循環；每圈開頭都是「沖高高」，換圈時重洗祝福語
  (function startMarquee() {
    const track = $('#marquee');
    const sep = '　✦　';
    const cheers = ['祝你高倍', '一飛沖天', '好運連連', '大吉大利', '倍數噴發', '見好就收', '財源滾滾', '旗開得勝', '手氣長紅', '加油加油'];
    const build = () => {
      const c = cheers.slice().sort(() => Math.random() - 0.5);
      const text = ['沖高高', c[0], c[1], '沖高高', c[2], c[3]].join(sep) + sep;
      track.innerHTML = '';
      for (let i = 0; i < 2; i++) track.appendChild(document.createElement('span')).textContent = text;
      track.style.animationDuration = text.length * 0.32 + 's';
    };
    track.addEventListener('animationiteration', build);
    build();
  })();

  window.__crash = eng; // 方便除錯
})();
