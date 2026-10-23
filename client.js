/**
 * 频谱导航条（Spectrum Rail）
 *
 * 只改「画法」，不改「行为」：
 *   · 原生导航条保持可见、可交互（滚轮、悬停预览、点击跳转、键盘都对原生逻辑生效）
 *   · 我们只覆盖每条的 ::before：2px 粗、最长 60px、长度由音频 FFT 驱动
 *   · 未加载的轮次画成 1px 描边 + 2px 端帽的「托架」形状（约等于 [ 逆时针转 90°）
 *   · 唯一新增的交互：右键打开音频输入菜单
 *
 * 纪律：fail-open。找不到导航条、拿不到音频、任何一步异常都只是「不生效」，
 * 原生 UI 保持原样。
 */
window.__ModuleLoader__.load({
  id: "dsh-spectrum-rail",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;

    /* ════════════════════════════ 常量 ════════════════════════════ */

    var PKG = "dsh-spectrum-rail";
    var CSS_MARKER = PKG + "/client.css";
    var RAIL_ATTR = "data-dsh-spectrum-rail";
    var STATE_ATTR = "data-eq-state";
    var BAND_ATTR = "data-eq-band";

    /** 本机回放（WASAPI loopback）助手。 */
    var LOOPBACK_ID = "__loopback__";
    var LOOPBACK_PATH = "/dsh-spectrum-rail";
    var LOOPBACK_PORT_BASE = 45999;
    var LOOPBACK_PORT_SPAN = 12;

    /** 可见频段数（导航条一屏最多 42 条，节拍 10px）。 */
    var CELLS = 42;
    var PITCH = 10;
    var BAR_MAX = 60;
    var RAIL_W = 64; // 容纳 60px 的条
    var HIT_W = 28; // 按钮命中区，保持原生宽度

    var F_MIN = 40;
    var F_MAX = 16000;

    /** 低频用长窗（分得开），中高频用短窗（跟手）。 */
    var FFT_FAST = 2048;
    var FFT_LOW = 8192;
    var CROSSOVER_HZ = 350;

    var SMOOTHING = 0.5;
    var MIN_SCALE = 0.18;
    var TICK_MS = 220;

    var reducedMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    var MOTION_KEY = "dsh-spectrum-rail.motion";
    var motionPref = "on";
    try {
      if (localStorage.getItem(MOTION_KEY) === "off") motionPref = "off";
    } catch (error) {
      /* 忽略 */
    }

    function motionEnabled() {
      return motionPref !== "off";
    }

    /* ════════════════════════════ 文案 ════════════════════════════ */

    var COPY = {
      zh: {
        title: "频谱",
        choose: "音频输入",
        refresh: "刷新设备",
        hint: "选择虚拟声卡（CABLE Output）或立体声混音；也可以直接用「系统音频」。",
        empty: "没有检测到音频输入设备",
        unsupported: "当前环境不支持音频采集",
        denied: "无法打开音频输入（权限或设备被占用）",
        loopback: "系统音频（本机回放）",
        loopbackOff: "本机回放助手未运行，重启 DSH 后重试",
        streamLost: "音频流中断，正在重连…",
        running: "正在采集",
        motion: "频谱：{state}",
        on: "开",
        off: "关"
      },
      en: {
        title: "Spectrum",
        choose: "Audio input",
        refresh: "Refresh devices",
        hint: "Pick a loopback device (CABLE Output) or Stereo Mix, or use System audio.",
        empty: "No audio input device found",
        unsupported: "Audio capture is unavailable here",
        denied: "Could not open the audio input (permission or device busy)",
        loopback: "System audio (this computer)",
        loopbackOff: "The loopback helper is not running; restart DSH and try again",
        streamLost: "Audio stream lost, reconnecting…",
        running: "Live",
        motion: "Spectrum: {state}",
        on: "on",
        off: "off"
      }
    };

    var LANG = /^zh/i.test((typeof navigator !== "undefined" && navigator.language) || "") ? "zh" : "en";
    var DICT = COPY[LANG] || COPY.en;

    function t(key, vars) {
      var text = DICT[key] || key;
      if (vars) {
        Object.keys(vars).forEach(function (name) {
          text = text.replace("{" + name + "}", String(vars[name]));
        });
      }
      return text;
    }

    /* ════════════════════════════ 样式 ════════════════════════════ */

    var CSS = [
      /* 只加宽导航条本身，保留它的滚动与定位 */
      "nav[" + RAIL_ATTR + "]{width:" + RAIL_W + "px !important}",

      /* 每一条：颜色跟主题走；命中区保持原生 28px，条本身往左溢出到 60px */
      "nav[" + RAIL_ATTR + "] button[data-index]{color:var(--dsw-alias-label-primary,#f5f5f5);left:auto !important;right:0 !important;width:" + HIT_W + "px !important}",

      /* 覆盖原生那根 20×2 的小条：2px 粗、最长 60px、右对齐、按音频缩放 */
      "nav[" + RAIL_ATTR + "] button[data-index]::before{",
      "content:'' !important;position:absolute !important;right:0 !important;top:50% !important;",
      "width:" + BAR_MAX + "px !important;height:2px !important;margin:0 !important;",
      "border:0 !important;border-radius:0 !important;",
      "background:var(--dsw-alias-border-l4,#8a8a8a) !important;",
      "transform:translateY(-50%) scaleX(var(--eq-scale," + MIN_SCALE + ")) !important;",
      "transform-origin:100% 50% !important;opacity:1 !important;",
      "animation:none !important;transition:opacity .14s !important;",
      "}",

      /* 未加载：同色但降透明度，和原装一样浅 */
      "nav[" + RAIL_ATTR + "] button[data-index][" + STATE_ATTR + "=unloaded]::before{opacity:.6 !important}",

      /* 悬停：换成 label-tertiary（原生预览卡用的那档） */
      "nav[" + RAIL_ATTR + "] button[data-index]:hover::before{background:var(--dsw-alias-label-tertiary,#bdbdbd) !important;opacity:1 !important}",

      /* 当前轮：原生就是白色满档，放在悬停之后以覆盖它 */
      "nav[" + RAIL_ATTR + "] button[data-index][" + STATE_ATTR + "=active]::before{background:var(--dsw-alias-label-primary,#f5f5f5) !important;opacity:1 !important}",
      "nav[" + RAIL_ATTR + "] button[data-index][aria-current='true']::before{background:var(--dsw-alias-label-primary,#f5f5f5) !important;opacity:1 !important}",

      /* 补足 42 格的占位：1px 下边 + 2px 左右端帽的“托盘”，只描边 */
      ".dsh-eq-ph{position:fixed;z-index:59;pointer-events:none}",
      ".dsh-eq-ph-row{position:relative;width:" + RAIL_W + "px;height:" + PITCH + "px}",
      ".dsh-eq-ph-bar{position:absolute;right:0;top:50%;margin-top:-2px;box-sizing:border-box;width:" + BAR_MAX + "px;height:4px;border-bottom:1px solid currentColor;border-left:2px solid currentColor;border-right:2px solid currentColor;background:transparent;opacity:.4;transform-origin:100% 50%;transform:scaleX(var(--eq-scale," + MIN_SCALE + "))}",

      /* 右键菜单 */
      ".dsh-eq-menu{position:fixed;pointer-events:auto;z-index:61;box-sizing:border-box;min-width:250px;max-width:330px;max-height:70vh;overflow:auto;padding:6px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1c1f);color:var(--dsw-alias-label-primary,#f2f2f2);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.1));box-shadow:var(--dsw-elevation-panel,0 10px 32px rgba(0,0,0,.5));font:13px/1.45 system-ui,'Segoe UI',sans-serif}",
      ".dsh-eq-menu h4{margin:0;padding:8px 10px 6px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#9a9a9a)}",
      ".dsh-eq-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dsh-eq-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}",
      ".dsh-eq-item[data-on='1']{color:var(--dsw-alias-state-business-primary,#7cc4ff)}",
      ".dsh-eq-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-eq-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:0}",
      ".dsh-eq-item[data-on='1'] .dsh-eq-dot{opacity:1}",
      ".dsh-eq-note{margin:4px 10px 8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption,#8b8b8b)}",
      ".dsh-eq-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l3,rgba(255,255,255,.08))}"
    ].join("");

    function installStyles() {
      try {
        if (typeof document === "undefined" || !document.head) return;
        if (document.querySelector('style[data-plugin-css="' + CSS_MARKER + '"]')) return;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-css", CSS_MARKER);
        style.textContent = CSS;
        document.head.appendChild(style);
      } catch (error) {
        /* 样式失败只影响观感 */
      }
    }

    /* ════════════════════ 导航条：只读、只打标 ════════════════════ */

    function findRail() {
      try {
        var button = document.querySelector("button[data-index]");
        return button && button.closest ? button.closest("nav") : null;
      } catch (error) {
        return null;
      }
    }

    function isUnloadedLabel(label) {
      return /加载并跳转|Load and jump/i.test(label || "");
    }

    /**
     * 把每一格标上状态与频段：
     *   · 状态来自 aria-current / aria-label（不读哈希类名）
     *   · 频段按它在轨道里的纵向位置算（顶 = 最高频，底 = 最低频）
     */
    function layout() {
      /* 动画关 = 完全退回原装：不打标、不改宽、不画条 */
      if (!motionEnabled()) return [];

      var nav = findRail();
      if (!nav || !nav.isConnected) return [];

      var rect = nav.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return [];

      if (nav.getAttribute(RAIL_ATTR) !== "1") nav.setAttribute(RAIL_ATTR, "1");

      var buttons = nav.querySelectorAll("button[data-index]");
      var out = [];

      for (var i = 0; i < buttons.length; i += 1) {
        var button = buttons[i];
        var box = button.getBoundingClientRect();
        var center = box.top + box.height / 2 - rect.top;
        var band = Math.round(center / PITCH - 0.5);
        if (band < 0) band = 0;
        if (band > CELLS - 1) band = CELLS - 1;

        var active = button.getAttribute("aria-current") === "true";
        var unloaded = isUnloadedLabel(button.getAttribute("aria-label"));
        var state = active ? "active" : unloaded ? "unloaded" : "loaded";

        if (button.getAttribute(STATE_ATTR) !== state) button.setAttribute(STATE_ATTR, state);
        button.setAttribute(BAND_ATTR, String(CELLS - 1 - band));
        out.push(button);
      }

      return out;
    }

    /* ════════════════════════════ 音频 ════════════════════════════ */

    var audio = {
      devices: [],
      deviceId: "",
      status: "idle", // idle | starting | running | error
      error: "",
      ctx: null,
      stream: null,
      analyser: null,
      analyserLow: null,
      bins: null,
      binsLow: null,
      tones: null,
      bands: new Float32Array(CELLS),
      raf: 0,
      abort: null,
      reader: null,
      lbRate: 48000,
      lbChannels: 2,
      lbNext: 0,
      /* 会话计数：断流重连时用来判断"还是不是同一次会话" */
      session: 0,
      retry: 0,
      frame: 0,
      lowReady: false,
      stats: { bytes: 0, peak: 0, rate: 0, channels: 0 }
    };

    function mediaAvailable() {
      return !!(typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    async function refreshDevices() {
      if (!mediaAvailable()) {
        audio.status = "error";
        audio.error = "unsupported";
        return;
      }
      try {
        var list = await navigator.mediaDevices.enumerateDevices();
        var inputs = [];
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].kind !== "audioinput") continue;
          inputs.push({
            id: list[i].deviceId,
            label: list[i].label || DICT.choose + " " + (inputs.length + 1)
          });
        }
        audio.devices = inputs;
      } catch (error) {
        audio.devices = [];
      }
    }

    /** 每格的对数频段（40Hz–16kHz）。 */
    function buildTones(sampleRate) {
      var max = Math.min(F_MAX, (sampleRate / 2) * 0.95);
      var tones = [];
      for (var i = 0; i < CELLS; i += 1) {
        var f0 = F_MIN * Math.pow(max / F_MIN, i / CELLS);
        var f1 = F_MIN * Math.pow(max / F_MIN, (i + 1) / CELLS);
        tones.push({ hz: Math.sqrt(f0 * f1), lo: f0, hi: f1 });
      }
      return tones;
    }

    function stopAudio() {
      if (audio.retry) {
        clearTimeout(audio.retry);
        audio.retry = 0;
      }
      if (audio.raf) {
        cancelAnimationFrame(audio.raf);
        audio.raf = 0;
      }
      if (audio.abort) {
        try {
          audio.abort.abort();
        } catch (error) {
          /* 忽略 */
        }
        audio.abort = null;
      }
      audio.reader = null;
      audio.lbNext = 0;
      try {
        if (audio.stream) {
          var tracks = audio.stream.getTracks();
          for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
        }
      } catch (error) {
        /* 忽略 */
      }
      try {
        if (audio.ctx && audio.ctx.close) audio.ctx.close();
      } catch (error) {
        /* 忽略 */
      }
      audio.ctx = null;
      audio.stream = null;
      audio.analyser = null;
      audio.analyserLow = null;
      audio.bins = null;
      audio.binsLow = null;
      audio.tones = null;
      audio.status = "idle";
      audio.lowReady = false;
      audio.bands = new Float32Array(CELLS);
    }

    /**
     * 音频流意外结束（助手退出、设备被拔、麦克风被抢占）：
     * 标记错误状态，并自动重连一次——用户不用再去菜单里点一遍。
     */
    function handleStreamEnd(session) {
      if (session !== audio.session) return; // 已经是旧会话
      if (!audio.abort && !audio.stream) return; // 用户主动停的

      stopAudio();
      audio.status = "error";
      audio.error = "stream";
      store.emit();

      if (!motionEnabled()) return;
      var target = audio.deviceId;
      audio.retry = setTimeout(function () {
        audio.retry = 0;
        if (!motionEnabled() || audio.status === "running") return;
        if (target === LOOPBACK_ID) startLoopback();
        else if (target) startAudio(target);
      }, 1500);
    }

    function wireAnalysers(actx, entry) {
      var analyser = actx.createAnalyser();
      analyser.fftSize = FFT_FAST;
      analyser.smoothingTimeConstant = SMOOTHING;

      var analyserLow = actx.createAnalyser();
      analyserLow.fftSize = FFT_LOW;
      analyserLow.smoothingTimeConstant = 0.7;

      var mute = actx.createGain();
      mute.gain.value = 0;

      analyserLow.connect(analyser);
      analyser.connect(mute);
      mute.connect(actx.destination);
      entry.connect(analyserLow);

      audio.ctx = actx;
      audio.analyser = analyser;
      audio.analyserLow = analyserLow;
      audio.bins = new Uint8Array(analyser.frequencyBinCount);
      audio.binsLow = new Uint8Array(analyserLow.frequencyBinCount);
      audio.tones = buildTones(actx.sampleRate);
    }

    async function startAudio(deviceId) {
      stopAudio();
      if (!mediaAvailable()) {
        audio.status = "error";
        audio.error = "unsupported";
        return;
      }
      audio.session += 1;
      var session = audio.session;
      audio.status = "starting";
      audio.error = "";
      try {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) throw new Error("unsupported");
        var actx = new Ctor();
        if (actx.state === "suspended") {
          try {
            await actx.resume();
          } catch (error) {
            /* 继续 */
          }
        }

        var constraints = {
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        };
        if (deviceId) constraints.audio.deviceId = { exact: deviceId };

        var stream = await navigator.mediaDevices.getUserMedia(constraints);
        var source = actx.createMediaStreamSource(stream);
        wireAnalysers(actx, source);

        /* 麦克风被拔掉/被别的程序抢占时，轨道会 ended */
        try {
          var trackList = stream.getAudioTracks();
          for (var t = 0; t < trackList.length; t += 1) {
            trackList[t].addEventListener("ended", function () {
              handleStreamEnd(session);
            });
          }
        } catch (error) {
          /* 忽略 */
        }

        audio.stream = stream;
        audio.deviceId = deviceId || "";
        audio.status = "running";
        startLoop();
      } catch (error) {
        stopAudio();
        audio.status = "error";
        audio.error = "denied";
      }
      await refreshDevices();
      store.emit();
    }

    async function probeLoopback() {
      for (var i = 0; i < LOOPBACK_PORT_SPAN; i += 1) {
        var port = LOOPBACK_PORT_BASE + i;
        var controller = new AbortController();
        var timer = 0;
        try {
          timer = setTimeout(function () {
            controller.abort();
          }, 400);
          var response = await fetch("http://127.0.0.1:" + port + LOOPBACK_PATH + "?probe=1", {
            signal: controller.signal,
            cache: "no-store"
          });
          if (response.ok && response.headers.get("x-dsh-spectrum")) return port;
        } catch (error) {
          /* 试下一个端口 */
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return 0;
    }

    function scheduleBuffer(actx, bytes, frames, rate, channels) {
      var buffer = actx.createBuffer(channels, frames, rate);
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var peak = 0;
      for (var ch = 0; ch < channels; ch += 1) {
        var lane = new Float32Array(frames);
        for (var i = 0; i < frames; i += 1) {
          var value = view.getFloat32((i * channels + ch) * 4, true);
          lane[i] = value;
          var abs = value < 0 ? -value : value;
          if (abs > peak) peak = abs;
        }
        buffer.copyToChannel(lane, ch);
      }
      var source = actx.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.analyserLow || audio.analyser);
      var now = actx.currentTime;
      var when = Math.max(now + 0.02, audio.lbNext);
      if (when - now > 0.25) when = now + 0.05;
      audio.lbNext = when + frames / rate;
      source.start(when);
      return peak;
    }

    async function pumpLoopback(reader, actx, session) {
      audio.reader = reader;
      var channels = audio.lbChannels;
      var rate = audio.lbRate;
      var frames = 1024;
      var frameBytes = frames * channels * 4;
      var pending = new Uint8Array(0);

      try {
        while (true) {
          var step = await reader.read();
          if (step.done) break;
          if (!audio.abort) return;

          var chunk = step.value;
          if (audio.stats) audio.stats.bytes += chunk.length;
          var merged = new Uint8Array(pending.length + chunk.length);
          merged.set(pending, 0);
          merged.set(chunk, pending.length);
          pending = merged;

          while (pending.length >= frameBytes) {
            var peak = scheduleBuffer(actx, pending.subarray(0, frameBytes), frames, rate, channels);
            if (audio.stats) audio.stats.peak = Math.max(peak, audio.stats.peak * 0.98);
            pending = pending.slice(frameBytes);
          }
        }
      } catch (error) {
        /* abort 或连接断开 */
      }

      /* 正常结束或被断开：交给统一的收尾（用户主动停止时这里会直接返回） */
      handleStreamEnd(session);
    }

    async function startLoopback() {
      stopAudio();
      audio.session += 1;
      var session = audio.session;
      audio.status = "starting";
      audio.error = "";
      store.emit();

      var Ctor = window.AudioContext || window.webkitAudioContext;
      var actx = null;
      try {
        if (!Ctor) throw new Error("unsupported");
        actx = new Ctor();
        var analyser = actx.createAnalyser();
        analyser.fftSize = FFT_FAST;
        analyser.smoothingTimeConstant = SMOOTHING;
        var analyserLow = actx.createAnalyser();
        analyserLow.fftSize = FFT_LOW;
        analyserLow.smoothingTimeConstant = 0.7;
        var mute = actx.createGain();
        mute.gain.value = 0;
        analyserLow.connect(analyser);
        analyser.connect(mute);
        mute.connect(actx.destination);

        if (actx.state === "suspended") {
          try {
            await actx.resume();
          } catch (error) {
            /* 继续 */
          }
        }

        var port = await probeLoopback();
        if (!port) throw new Error("no-helper");

        var abort = new AbortController();
        var response = await fetch("http://127.0.0.1:" + port + LOOPBACK_PATH, {
          signal: abort.signal,
          cache: "no-store"
        });
        if (!response.ok || !response.body) throw new Error("no-stream");

        audio.ctx = actx;
        audio.analyser = analyser;
        audio.analyserLow = analyserLow;
        audio.abort = abort;
        audio.lbRate = Number(response.headers.get("x-sample-rate")) || 48000;
        audio.lbChannels = Math.max(1, Number(response.headers.get("x-channels")) || 2);
        audio.lbNext = actx.currentTime + 0.05;
        audio.bins = new Uint8Array(analyser.frequencyBinCount);
        audio.binsLow = new Uint8Array(analyserLow.frequencyBinCount);
        audio.tones = buildTones(actx.sampleRate);
        audio.deviceId = LOOPBACK_ID;
        audio.stats = { bytes: 0, peak: 0, rate: audio.lbRate, channels: audio.lbChannels };
        audio.status = "running";
        startLoop();
        pumpLoopback(response.body.getReader(), actx, session);
      } catch (error) {
        if (actx && audio.ctx !== actx) {
          try {
            actx.close();
          } catch (ignored) {
            /* 忽略 */
          }
        }
        stopAudio();
        audio.status = "error";
        audio.error = "loopback";
      }
      store.emit();
    }

    /** 在读到的频谱里按频率做线性插值（窄于一个 bin 的频段才不会取出同一个值）。 */
    function sampleAt(bins, pos) {
      if (!bins || bins.length === 0) return 0;
      var index = Math.floor(pos);
      var frac = pos - index;
      var a = bins[Math.max(1, Math.min(index, bins.length - 1))] || 0;
      var b = bins[Math.max(1, Math.min(index + 1, bins.length - 1))] || 0;
      return a + (b - a) * frac;
    }

    function bandPeak(analyser, bins, tone) {
      var binHz = analyser.context.sampleRate / analyser.fftSize;
      var peak = sampleAt(bins, tone.hz / binHz);
      var lo = tone.lo / binHz;
      var hi = tone.hi / binHz;
      if (hi - lo >= 2) {
        var last = Math.min(Math.floor(hi), bins.length - 1);
        for (var b = Math.max(1, Math.ceil(lo)); b <= last; b += 1) {
          if (bins[b] > peak) peak = bins[b];
        }
      }
      return peak;
    }

    function readBands() {
      if (!audio.analyser || !audio.bins || !audio.tones) {
        for (var j = 0; j < CELLS; j += 1) audio.bands[j] *= 0.9;
        return;
      }
      audio.analyser.getByteFrequencyData(audio.bins);

      /* 8192 点长窗每 3 帧算一次：低频本来变化慢，省一半以上的 FFT 开销 */
      audio.frame += 1;
      if (audio.analyserLow && audio.binsLow && (audio.frame % 3 === 0 || !audio.lowReady)) {
        audio.analyserLow.getByteFrequencyData(audio.binsLow);
        audio.lowReady = true;
      }

      for (var i = 0; i < CELLS; i += 1) {
        var tone = audio.tones[i];
        var useLow = audio.analyserLow && tone.hz < CROSSOVER_HZ;
        var peak = bandPeak(
          useLow ? audio.analyserLow : audio.analyser,
          useLow ? audio.binsLow : audio.bins,
          tone
        );
        var shaped = Math.pow(peak / 255, 0.85);
        audio.bands[i] = Math.max(shaped, audio.bands[i] * 0.9);
      }
    }

    function startLoop() {
      if (audio.raf) cancelAnimationFrame(audio.raf);
      var tick = function () {
        if (!audio.analyser) {
          audio.raf = 0;
          return;
        }
        readBands();
        paintBars();
        audio.raf = requestAnimationFrame(tick);
      };
      audio.raf = requestAnimationFrame(tick);
    }

    /* ════════════════════════════ 状态 ════════════════════════════ */

    var listenerSet = new Set();

    var state = {
      buttons: [],
      ph: null,
      menu: null,
      timer: 0
    };

    /** 占位格（补满 42 条）里的 bar 元素，按行顺序。 */
    var phBars = [];

    function paintBars() {
      if (!motionEnabled()) return;

      var buttons = state.buttons;
      for (var i = 0; i < buttons.length; i += 1) {
        var button = buttons[i];
        if (!button || !button.isConnected) continue;
        var band = Number(button.getAttribute(BAND_ATTR));
        if (!Number.isFinite(band) || band < 0) band = 0;
        if (band > CELLS - 1) band = CELLS - 1;
        var value = audio.bands[band] || 0;
        var scale = motionEnabled() ? MIN_SCALE + value * (1 - MIN_SCALE) : 0.3;
        if (scale < 0.02) scale = 0.02;
        button.style.setProperty("--eq-scale", scale.toFixed(3));
      }

      for (var k = 0; k < phBars.length; k += 1) {
        var bar = phBars[k];
        if (!bar || !bar.isConnected) continue;
        var phBand = Number(bar.getAttribute("data-band"));
        if (!Number.isFinite(phBand) || phBand < 0) phBand = 0;
        if (phBand > CELLS - 1) phBand = CELLS - 1;
        var phValue = audio.bands[phBand] || 0;
        var phScale = motionEnabled() ? MIN_SCALE + phValue * (1 - MIN_SCALE) : 0.3;
        if (phScale < 0.02) phScale = 0.02;
        bar.style.setProperty("--eq-scale", phScale.toFixed(3));
      }
    }

    /**
     * 开关动画：关 = 彻底退回原装（去掉标记、恢复 28px 宽、停采集）；
     * 开 = 重新接管，并把之前选过的音源接回来。
     */
    function applyMotionState() {
      var nav = findRail();

      if (!motionEnabled()) {
        if (nav) {
          nav.removeAttribute(RAIL_ATTR);
          var buttons = nav.querySelectorAll("button[data-index]");
          for (var i = 0; i < buttons.length; i += 1) {
            buttons[i].removeAttribute(STATE_ATTR);
            buttons[i].removeAttribute(BAND_ATTR);
            buttons[i].style.removeProperty("--eq-scale");
          }
        }
        state.buttons = [];
        state.ph = null;
        phBars.length = 0;
        stopAudio();
        return;
      }

      store.sync();
      if (audio.deviceId === LOOPBACK_ID) startLoopback();
      else if (audio.deviceId) startAudio(audio.deviceId);
    }

    var store = {
      get: function () {
        return {
          ph: state.ph,
          menu: state.menu,
          devices: audio.devices,
          deviceId: audio.deviceId,
          status: audio.status,
          error: audio.error
        };
      },
      subscribe: function (fn) {
        listenerSet.add(fn);
        return function () {
          listenerSet.delete(fn);
        };
      },
      emit: function () {
        listenerSet.forEach(function (fn) {
          try {
            fn();
          } catch (error) {
            /* 单个订阅者出错不影响其它人 */
          }
        });
      },

      sync: function () {
        state.buttons = layout();
        if (state.buttons.length === 0) {
          if (state.ph) {
            state.ph = null;
            phBars.length = 0;
            store.emit();
          }
          return;
        }

        /* 轮次不足 42 时，在最后一条下面补占位格（不超过可视区） */
        var ph = null;
        var count = state.buttons.length;
        if (count < CELLS) {
          var nav = findRail();
          if (nav) {
            var navRect = nav.getBoundingClientRect();
            var last = state.buttons[count - 1].getBoundingClientRect();
            var limit = window.innerHeight - 140;
            var room = Math.floor((limit - last.bottom) / PITCH);
            var fill = Math.min(CELLS - count, Math.max(0, room));
            if (fill > 0) {
              ph = {
                left: Math.round(navRect.right - RAIL_W),
                top: Math.round(last.bottom),
                count: fill,
                first: count
              };
            }
          }
        }

        var prev = state.ph;
        var changed =
          (prev === null) !== (ph === null) ||
          (ph !== null && prev !== null && (prev.count !== ph.count || prev.top !== ph.top || prev.left !== ph.left));
        if (changed) {
          state.ph = ph;
          phBars.length = ph === null ? 0 : ph.count;
          store.emit();
        }

        paintBars();
      },

      /** 菜单固定贴在轨道左侧、与最上面那条对齐，避免被窗口/输入框裁掉。 */
      openMenu: function () {
        var nav = findRail();
        if (!nav) return;
        var buttons = nav.querySelectorAll("button[data-index]");
        if (buttons.length === 0) return;

        var width = 300;
        var first = buttons[0].getBoundingClientRect();
        var navRect = nav.getBoundingClientRect();

        var left = navRect.left - width - 10;
        if (left < 8) left = Math.max(8, navRect.right - width);

        var top = Math.max(8, first.top - 4);
        /* 下方空间不够就整体上移，保证菜单尽量完整露出 */
        var wanted = 340;
        if (top + wanted > window.innerHeight - 8) {
          top = Math.max(8, window.innerHeight - 8 - wanted);
        }
        var maxHeight = Math.max(160, window.innerHeight - top - 8);

        state.menu = {
          x: Math.round(left),
          y: Math.round(top),
          maxHeight: Math.round(maxHeight)
        };

        refreshDevices().then(function () {
          store.emit();
        });
        store.emit();
      },

      closeMenu: function () {
        if (!state.menu) return;
        state.menu = null;
        store.emit();
      },

      selectDevice: function (deviceId) {
        state.menu = null;

        /* 选设备本身就意味着想看图：动画关着就先打开 */
        if (!motionEnabled()) {
          motionPref = "on";
          try {
            localStorage.setItem(MOTION_KEY, "on");
          } catch (error) {
            /* 忽略 */
          }
          store.sync();
        }

        store.emit();
        if (deviceId === LOOPBACK_ID) startLoopback();
        else startAudio(deviceId);
      },

      refresh: function () {
        refreshDevices().then(function () {
          store.emit();
        });
      },

      dispose: function () {
        if (state.timer) clearInterval(state.timer);
        state.timer = 0;
        var nav = findRail();
        if (nav) {
          nav.removeAttribute(RAIL_ATTR);
          var buttons = nav.querySelectorAll("button[data-index]");
          for (var i = 0; i < buttons.length; i += 1) {
            buttons[i].removeAttribute(STATE_ATTR);
            buttons[i].removeAttribute(BAND_ATTR);
            buttons[i].style.removeProperty("--eq-scale");
          }
        }
        state.buttons = [];
        state.ph = null;
        phBars.length = 0;
        state.menu = null;
        listenerSet.clear();
        stopAudio();

        /* 把样式也撤掉，否则禁用插件后导航条会停留在加宽/重画状态 */
        try {
          var style = document.querySelector('style[data-plugin-css="' + CSS_MARKER + '"]');
          if (style && style.parentNode) style.parentNode.removeChild(style);
        } catch (error) {
          /* 忽略 */
        }
      }
    };

    /* ════════════════════════════ 菜单 ════════════════════════════ */

    function Menu(props) {
      var snapshot = props.snapshot;
      var entries = [{ id: LOOPBACK_ID, label: t("loopback") }].concat(snapshot.devices);
      var items = entries.map(function (device) {
        return h(
          "button",
          {
            key: device.id || device.label,
            className: "dsh-eq-item",
            type: "button",
            "data-on": snapshot.deviceId === device.id ? "1" : "0",
            onClick: function () {
              store.selectDevice(device.id);
            }
          },
          h("i", { className: "dsh-eq-dot" }),
          h("span", null, device.label)
        );
      });

      var status = null;
      if (snapshot.status === "running") {
        var info = "";
        if (audio.stats && audio.stats.bytes > 0) {
          info =
            " · " +
            Math.round(audio.stats.rate / 1000) +
            "kHz · " +
            Math.round(audio.stats.bytes / 1024) +
            "KB · " +
            audio.stats.peak.toFixed(2);
        }
        status = h("div", { className: "dsh-eq-note" }, t("running") + info);
      } else if (snapshot.status === "error") {
        status = h(
          "div",
          { className: "dsh-eq-note" },
          snapshot.error === "unsupported"
            ? t("unsupported")
            : snapshot.error === "loopback"
              ? t("loopbackOff")
              : snapshot.error === "stream"
                ? t("streamLost")
                : t("denied")
        );
      } else if (items.length === 0) {
        status = h("div", { className: "dsh-eq-note" }, t("empty"));
      }

      return h(
        "div",
        {
          className: "dsh-eq-menu",
          role: "menu",
          style: {
            left: snapshot.menu.x + "px",
            top: snapshot.menu.y + "px",
            maxHeight: snapshot.menu.maxHeight + "px"
          }
        },
        h("h4", null, t("choose")),
        items,
        status,
        h("div", { className: "dsh-eq-sep" }),
        h(
          "button",
          {
            className: "dsh-eq-item",
            type: "button",
            onClick: function () {
              motionPref = motionEnabled() ? "off" : "on";
              try {
                localStorage.setItem(MOTION_KEY, motionPref);
              } catch (error) {
                /* 忽略 */
              }
              applyMotionState();
              store.emit();
            }
          },
          h("span", null, t("motion", { state: motionEnabled() ? t("on") : t("off") }))
        ),
        h(
          "button",
          {
            className: "dsh-eq-item",
            type: "button",
            onClick: function () {
              store.refresh();
            }
          },
          h("span", null, t("refresh"))
        ),
        h("div", { className: "dsh-eq-note" }, t("hint"))
      );
    }

    function Overlay() {
      var force = React.useState(0)[1];
      var snapshot = store.get();

      React.useEffect(function () {
        var rerender = function () {
          force(function (n) {
            return n + 1;
          });
        };
        var unsubscribe = store.subscribe(rerender);

        var onPointerDown = function (event) {
          if (!state.menu) return;
          var menu = document.querySelector(".dsh-eq-menu");
          if (menu && menu.contains(event.target)) return;
          store.closeMenu();
        };
        var onKeyDown = function (event) {
          if (event.key === "Escape") store.closeMenu();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);

        /* 右键：只在导航条上生效，其它地方保持原生菜单 */
        var onContextMenu = function (event) {
          var nav = findRail();
          if (!nav || !event.target || !nav.contains(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          store.openMenu();
        };
        document.addEventListener("contextmenu", onContextMenu, true);

        store.sync();
        state.timer = setInterval(store.sync, TICK_MS);

        return function () {
          unsubscribe();
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
          document.removeEventListener("contextmenu", onContextMenu, true);
          store.dispose();
        };
      }, []);

      if (!snapshot.menu && !snapshot.ph) return null;

      var placeholders = null;
      if (snapshot.ph) {
        placeholders = h(
          "div",
          {
            className: "dsh-eq-ph",
            style: { left: snapshot.ph.left + "px", top: snapshot.ph.top + "px" }
          },
          Array.from({ length: snapshot.ph.count }).map(function (ignored, index) {
            var position = snapshot.ph.first + index;
            var band = CELLS - 1 - position;
            return h(
              "div",
              { className: "dsh-eq-ph-row", key: position },
              h("i", {
                className: "dsh-eq-ph-bar",
                "data-band": String(band),
                ref: function (element) {
                  phBars[index] = element || null;
                }
              })
            );
          })
        );
      }

      return h(React.Fragment, null, placeholders, snapshot.menu ? h(Menu, { snapshot: snapshot }) : null);
    }

    /* ════════════════════════════ 接线 ════════════════════════════ */

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register(
            {
              name: "shell.overlay",
              id: "spectrum-rail",
              order: 60,
              label: function () {
                return t("title");
              }
            },
            Overlay
          );
        });
      } catch (error) {
        try {
          console.error("[spectrum-rail] 插槽注册失败：", error);
        } catch (ignored) {
          /* 忽略 */
        }
      }
    }

    return {
      inject: ["slots"],
      apply: apply,
      dispose: function () {
        store.dispose();
      }
    };
  }
});
