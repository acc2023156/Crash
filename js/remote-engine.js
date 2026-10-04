(function (global) {
  'use strict';

  const Base = global.Crash;
  const { CFG, STYLES, multAt, floor2 } = Base;
  const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(global.location.hostname)
    ? 'http://127.0.0.1:8791'
    : 'https://sha-platform-dev.sha-platform.workers.dev';

  const round2 = value => Math.round(value * 100) / 100;
  const toUnits = value => String(Math.round(Number(value) * 1000));
  const fromMoney = money => Number(money.units) / (10 ** money.scale);
  const randomId = () => global.crypto.randomUUID();

  function makeAccounts() {
    const styles = Object.keys(STYLES);
    return Array.from({ length: CFG.ACCOUNT_COUNT }, (_, index) => ({
      id: `bot${String(index + 1).padStart(3, '0')}`,
      name: `Player${String(index + 1).padStart(3, '0')}`,
      hidden: index % 7 === 0,
      style: styles[index % styles.length],
      color: `hsl(${(index * 47) % 360} 65% 58%)`,
      balance: 500 + ((index * 137) % 9500),
      rounds: 0,
      wins: 0,
      profit: 0,
      refills: 0,
    }));
  }

  class RemoteEngine {
    constructor(store) {
      this.store = store || null;
      this.listeners = {};
      this.accounts = makeAccounts();
      this.player = { id: '', name: '你', color: '#00e701', balance: 0, rounds: 0, wins: 0, profit: 0, history: [] };
      this.settings = { botMin: 5, botMax: 60 };
      this.history = [];
      this.roundId = 0;
      this.round = null;
      this.queued = null;
      this.auto = { on: false };
      this.commitment = null;
      this.launching = false;
      this.polling = false;
      this.nextPoll = 0;
      this.loadSettings();
    }

    on(event, handler) { (this.listeners[event] || (this.listeners[event] = [])).push(handler); }
    emit(event, data) { (this.listeners[event] || []).forEach(handler => handler(data)); }
    fail(message) { this.emit('toast', { msg: message, type: 'err' }); return false; }

    async api(path, options = {}) {
      const response = await fetch(API_BASE + path, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-player-id': this.player.id, ...(options.headers || {}) },
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(payload.error && payload.error.message || `API ${response.status}`);
        error.code = payload.error && payload.error.code;
        throw error;
      }
      return payload;
    }

    async start(now) {
      let playerId = '';
      try { playerId = this.store && this.store.getItem('crash.playerId') || ''; } catch (e) { /* ignore */ }
      if (!playerId) {
        playerId = `crash-${randomId()}`;
        try { if (this.store) this.store.setItem('crash.playerId', playerId); } catch (e) { /* ignore */ }
      }
      this.player.id = playerId;
      await this.api(`/api/v1/dev/players/${encodeURIComponent(playerId)}/bootstrap`, {
        method: 'POST', body: JSON.stringify({ initial_units: '1000000' })
      });
      await this.refreshSession();
      this.newRound(now);
    }

    async refreshSession() {
      const session = await this.api('/api/v1/games/crash/session', { method: 'POST', body: '{}' });
      this.player.balance = fromMoney(session.balance);
      this.commitment = session.commitment;
      this.emit('balance');
    }

    myBet() { return this.round ? this.round.bets.find(bet => bet.isPlayer) : null; }

    newRound(now) {
      const id = ++this.roundId;
      this.round = {
        id,
        serverId: null,
        proofToken: '',
        hash: this.commitment ? this.commitment.server_seed_hash : '',
        crash: Infinity,
        phase: 'betting',
        phaseStart: now,
        bets: [],
        pending: [],
        remote: false,
      };
      for (let index = 0; index < Math.max(this.settings.botMin, 0); index += 1) {
        const account = this.accounts[(id * 13 + index) % this.accounts.length];
        const style = STYLES[account.style];
        const amount = round2(Math.max(CFG.MIN_BET, Math.min(account.balance, 1 + ((id + index * 7) % 50))));
        const target = floor2(style.target[0] + ((index * 17) % 100) / 100 * (style.target[1] - style.target[0]));
        this.round.pending.push({ acc: account, at: (index + 1) * CFG.BET_MS / (Math.max(this.settings.botMin, 1) + 1), amount, target });
      }
      this.emit('round', this.round);
      if (this.auto.on) this.placeBet(this.auto.amount, this.auto.target);
      else if (this.queued) {
        const queued = this.queued;
        this.queued = null;
        this.placeBet(queued.amount, queued.target);
      }
      this.emit('queue');
    }

    joinBot(pending) {
      const bet = { isPlayer: false, acc: pending.acc, name: pending.acc.name, hidden: pending.acc.hidden, amount: pending.amount, target: pending.target, cashedAt: null, payout: 0 };
      bet.acc.balance = round2(bet.acc.balance - bet.amount);
      this.round.bets.push(bet);
      this.emit('bet', bet);
    }

    placeBet(amount, target) {
      amount = round2(+amount);
      target = +target >= 1.01 ? floor2(+target) : null;
      if (!(amount >= CFG.MIN_BET)) return this.fail(`下注金額最少 ${CFG.MIN_BET}`);
      if (amount > this.player.balance) return this.fail('餘額不足');
      const round = this.round;
      if (round.phase !== 'betting') {
        this.queued = { amount, target };
        this.emit('queue');
        return true;
      }
      if (this.myBet()) return false;
      const bet = { isPlayer: true, acc: this.player, name: '你', hidden: false, amount, target, cashedAt: null, payout: 0 };
      this.player.balance = round2(this.player.balance - amount);
      round.bets.push(bet);
      this.emit('bet', bet);
      this.emit('balance');
      return true;
    }

    cancelBet() {
      if (this.queued) { this.queued = null; this.emit('queue'); return; }
      const bet = this.myBet();
      if (!bet || this.round.phase !== 'betting') return;
      this.round.bets.splice(this.round.bets.indexOf(bet), 1);
      this.player.balance = round2(this.player.balance + bet.amount);
      this.emit('bet', null);
      this.emit('balance');
    }

    async launchRemote(now) {
      if (this.launching) return;
      this.launching = true;
      const round = this.round;
      const bet = this.myBet();
      round.phase = 'starting';
      try {
        const payload = await this.api('/api/v1/games/crash/rounds', {
          method: 'POST',
          body: JSON.stringify({
            request_id: randomId(),
            commitment_id: this.commitment.id,
            wager: { units: toUnits(bet.amount), currency: 'TWD', scale: 3 }
          })
        });
        round.id = payload.round.id;
        round.serverId = payload.round.id;
        round.remote = true;
        round.hash = payload.fairness.server_seed_hash;
        round.proofToken = payload.fairness.proof_token;
        round.phase = 'running';
        round.phaseStart = performance.now() - Math.max(0, Date.now() - Date.parse(payload.round.started_at));
        this.player.balance = fromMoney(payload.balance);
        this.emit('balance');
        this.emit('run', round);
        this.nextPoll = 0;
      } catch (error) {
        this.player.balance = round2(this.player.balance + bet.amount);
        round.bets.splice(round.bets.indexOf(bet), 1);
        this.emit('balance');
        this.fail(`開局失敗：${error.message}`);
        round.phase = 'crashed';
        round.crash = 1;
        round.phaseStart = now;
      } finally {
        this.launching = false;
      }
    }

    runDemo(now) {
      const round = this.round;
      const seed = `${Date.now()}:${round.id}:${Math.random()}`;
      round.crash = Math.min(5, Base.crashFromSeed(global.sha256(seed), round.id));
      round.phase = 'running';
      round.phaseStart = now;
      this.emit('run', round);
    }

    async pollRemote() {
      if (this.polling || !this.round.remote) return;
      this.polling = true;
      const round = this.round;
      try {
        const headers = round.proofToken ? { authorization: `Bearer ${round.proofToken}` } : {};
        const proof = await fetch(`${API_BASE}/api/v1/games/crash/rounds/${encodeURIComponent(round.serverId)}/proof`, { headers, cache: 'no-store' });
        const payload = await proof.json();
        if (payload.reveal) this.finishRemote(payload);
      } catch (error) {
        // A transient poll failure must not alter the authoritative round.
      } finally {
        this.polling = false;
      }
    }

    finishRemote(proof) {
      const round = this.round;
      if (round.phase === 'crashed') return;
      round.crash = Number(proof.recorded_result.crash_multiplier);
      round.phase = 'crashed';
      round.phaseStart = performance.now();
      const bet = this.myBet();
      if (bet) {
        const profit = round2((bet.cashedAt ? bet.payout : 0) - bet.amount);
        this.player.rounds += 1;
        if (bet.cashedAt) this.player.wins += 1;
        this.player.profit = round2(this.player.profit + profit);
        const item = { id: round.serverId, amount: bet.amount, target: bet.target, cashedAt: bet.cashedAt, crash: round.crash, profit, token: round.proofToken };
        this.player.history.unshift(item);
        this.player.history.length = Math.min(this.player.history.length, 50);
        this.history.unshift({ id: round.serverId, crash: round.crash, hash: round.hash, token: round.proofToken });
        this.history.length = Math.min(this.history.length, 30);
        if (this.auto.on) {
          const won = !!bet.cashedAt;
          const percentage = won ? this.auto.winPct : this.auto.lossPct;
          this.auto.amount = percentage ? Math.max(CFG.MIN_BET, round2(this.auto.amount * (1 + percentage / 100))) : this.auto.base;
          if (this.auto.remaining > 0 && --this.auto.remaining === 0) this.stopAuto('自動投注完成');
        }
      }
      for (const bot of round.bets.filter(item => !item.isPlayer)) {
        bot.acc.rounds += 1;
        if (bot.cashedAt) { bot.acc.wins += 1; bot.acc.profit = round2(bot.acc.profit + bot.payout - bot.amount); }
        else bot.acc.profit = round2(bot.acc.profit - bot.amount);
      }
      this.emit('crash', round);
      this.refreshSession().catch(() => {});
    }

    async cashOut() {
      const round = this.round;
      const bet = this.myBet();
      if (round.phase !== 'running' || !round.remote || !bet || bet.cashedAt || round.cashing) return;
      round.cashing = true;
      try {
        const payload = await this.api(`/api/v1/games/crash/rounds/${encodeURIComponent(round.serverId)}/cashout`, {
          method: 'POST', body: JSON.stringify({ request_id: randomId() })
        });
        bet.cashedAt = Number(payload.round.cashed_at);
        bet.payout = fromMoney(payload.round.payout);
        this.player.balance = fromMoney(payload.balance);
        this.commitment = payload.next_commitment;
        this.emit('cashout', bet);
        this.emit('balance');
      } catch (error) {
        if (error.code === 'ROUND_CRASHED' || error.code === 'ROUND_FINISHED') this.pollRemote();
        else this.fail(`兌現失敗：${error.message}`);
      } finally {
        round.cashing = false;
      }
    }

    tick(now) {
      const round = this.round;
      if (!round) return;
      const elapsed = now - round.phaseStart;
      if (round.phase === 'betting') {
        while (round.pending.length && round.pending[0].at <= elapsed) this.joinBot(round.pending.shift());
        if (elapsed >= CFG.BET_MS) {
          while (round.pending.length) this.joinBot(round.pending.shift());
          if (this.myBet()) this.launchRemote(now);
          else this.runDemo(now);
        }
      } else if (round.phase === 'running') {
        const multiplier = floor2(multAt(elapsed));
        round.bets.filter(bet => !bet.cashedAt && bet.target && bet.target <= multiplier && !bet.isPlayer)
          .forEach(bet => { bet.cashedAt = bet.target; bet.payout = round2(bet.amount * bet.target); this.emit('cashout', bet); });
        const mine = this.myBet();
        if (mine && mine.target && !mine.cashedAt && multiplier >= mine.target) this.cashOut();
        if (round.remote) {
          if (now >= this.nextPoll) { this.nextPoll = now + 250; this.pollRemote(); }
        } else if (multiplier >= round.crash) {
          round.phase = 'crashed';
          round.phaseStart = now;
          this.emit('crash', round);
        }
      } else if (round.phase === 'crashed' && elapsed >= CFG.CRASH_PAUSE_MS) {
        this.newRound(now);
      }
    }

    startAuto({ amount, target, count, winPct, lossPct }) {
      amount = round2(+amount);
      target = +target;
      if (!(target >= 1.01)) return this.fail('自動投注需設定兌現倍數 ≥ 1.01');
      if (!(amount >= CFG.MIN_BET)) return this.fail(`下注金額最少 ${CFG.MIN_BET}`);
      this.auto = { on: true, base: amount, amount, target: floor2(target), remaining: Math.max(0, count | 0), winPct: +winPct || 0, lossPct: +lossPct || 0 };
      if (this.round.phase === 'betting' && !this.myBet()) this.placeBet(amount, target);
      this.emit('auto');
      return true;
    }

    stopAuto(message) { this.auto.on = false; this.emit('auto'); if (message) this.emit('toast', { msg: message, type: 'info' }); }
    setBotRange(minimum, maximum) { this.settings.botMin = Math.max(0, Math.min(100, minimum | 0)); this.settings.botMax = Math.max(0, Math.min(100, maximum | 0)); this.saveSettings(); }
    saveSettings() { try { if (this.store) this.store.setItem('crash.remote.settings', JSON.stringify(this.settings)); } catch (e) { /* ignore */ } }
    loadSettings() { try { if (this.store) Object.assign(this.settings, JSON.parse(this.store.getItem('crash.remote.settings') || '{}')); } catch (e) { /* ignore */ } }
    reset() { try { if (this.store) this.store.removeItem('crash.remote.settings'); } catch (e) { /* ignore */ } }
  }

  Base.Engine = RemoteEngine;
  Base.API_BASE = API_BASE;
})(typeof window !== 'undefined' ? window : globalThis);
