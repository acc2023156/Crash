/* 合成音效（Web Audio，不需音檔），做法與 Plinko 相同：第一次使用者操作後才建立 AudioContext */
(function (global) {
  'use strict';
  let ctx = null;
  let enabled = true;
  let noiseBuf = null;
  let hum = null;
  let lastBlip = 0;
  try { enabled = localStorage.getItem('crash.sound') !== 'off'; } catch (e) { /* storage unavailable */ }

  function audio() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, { at = 0, dur = 0.08, type = 'sine', gain = 0.12, slide = 0 } = {}) {
    const ac = enabled && audio();
    if (!ac) return;
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // 白噪音經低通濾波，用在發射與爆炸
  function noise({ dur = 0.6, gain = 0.3, from = 3000, to = 120, at = 0 } = {}) {
    const ac = enabled && audio();
    if (!ac) return;
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ac.currentTime + at;
    const src = ac.createBufferSource();
    const f = ac.createBiquadFilter();
    const g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  function humFreq(m) { return 90 + Math.min(520, 150 * Math.log2(m) + 40 * (m - 1)); }

  const Sound = {
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      if (!enabled) Sound.humStop();
      try { localStorage.setItem('crash.sound', enabled ? 'on' : 'off'); } catch (e) { /* storage unavailable */ }
      return enabled;
    },
    unlock() { if (enabled) audio(); },

    bet() { tone(520, { dur: 0.06, type: 'square', gain: 0.05 }); tone(780, { at: 0.06, dur: 0.09, type: 'square', gain: 0.05 }); },
    cancel() { tone(420, { dur: 0.12, type: 'triangle', gain: 0.09, slide: 0.6 }); },
    tick(last) { tone(last ? 1175 : 880, { dur: last ? 0.16 : 0.07, type: 'sine', gain: 0.1 }); },
    launch() {
      tone(160, { dur: 0.5, type: 'sawtooth', gain: 0.06, slide: 3 });
      noise({ dur: 0.45, gain: 0.12, from: 600, to: 4000 });
    },
    milestone(m) { // 2×、5×、10×… 的提示音
      const base = m >= 10 ? 1047 : m >= 5 ? 880 : 784;
      tone(base, { dur: 0.1, type: 'triangle', gain: 0.08 });
      tone(base * 1.5, { at: 0.08, dur: 0.14, type: 'triangle', gain: 0.07 });
    },
    blip() { // 其他玩家兌現，節流避免 60 人同時響
      const now = performance.now();
      if (now - lastBlip < 70) return;
      lastBlip = now;
      tone(1400 + Math.random() * 500, { dur: 0.04, type: 'sine', gain: 0.025 });
    },
    win() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, { at: i * 0.07, dur: 0.16, type: 'triangle', gain: 0.1 })); },
    crash() {
      noise({ dur: 0.9, gain: 0.35, from: 2500, to: 80 });
      tone(220, { dur: 0.6, type: 'sawtooth', gain: 0.08, slide: 0.25 });
      tone(70, { dur: 0.5, type: 'sine', gain: 0.2, slide: 0.5 });
    },
    lose() { tone(330, { at: 0.35, dur: 0.18, type: 'triangle', gain: 0.07 }); tone(247, { at: 0.52, dur: 0.3, type: 'triangle', gain: 0.07 }); },

    // 上升中的引擎低鳴，音高跟著倍數走
    humStart() {
      const ac = enabled && audio();
      if (!ac || hum) return;
      const osc = ac.createOscillator(), osc2 = ac.createOscillator();
      const f = ac.createBiquadFilter(), g = ac.createGain();
      osc.type = 'sawtooth'; osc2.type = 'triangle';
      osc.frequency.value = humFreq(1); osc2.frequency.value = humFreq(1) * 1.005;
      f.type = 'lowpass'; f.frequency.value = 900;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.035, ac.currentTime + 0.3);
      osc.connect(f); osc2.connect(f); f.connect(g).connect(ac.destination);
      osc.start(); osc2.start();
      hum = { osc, osc2, f, g };
    },
    humUpdate(m) {
      if (!hum || !ctx) return;
      const t = ctx.currentTime, fr = humFreq(m);
      hum.osc.frequency.setTargetAtTime(fr, t, 0.05);
      hum.osc2.frequency.setTargetAtTime(fr * 1.005, t, 0.05);
      hum.f.frequency.setTargetAtTime(900 + fr * 2, t, 0.1);
    },
    humStop() {
      if (!hum || !ctx) { hum = null; return; }
      const t = ctx.currentTime, h = hum;
      hum = null;
      h.g.gain.cancelScheduledValues(t);
      h.g.gain.setValueAtTime(Math.max(0.0001, h.g.gain.value), t);
      h.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      h.osc.stop(t + 0.1); h.osc2.stop(t + 0.1);
    },
  };

  global.Sound = Sound;
})(window);
