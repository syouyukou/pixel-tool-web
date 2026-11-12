'use strict';
(() => {
  // ── Defaults and session state ──
  const $ = id => document.getElementById(id);
  const BLUE = ['#4a9bd6', '#9bc6ea', '#d6e9f6', '#ffffff'];
  const GREEN = ['#2a5839', '#70aa51', '#bdd9ad', '#ffffff'];

  const defaults = () => ({
    width: 45,
    bit: '2',
    count: 4,
    mode: 'custom',
    palette: [...BLUE],
    accents: [],
    rgb: false,
    redBits: 3,
    greenBits: 3,
    blueBits: 2,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    dither: false,
    ditherMethod: 'floyd',
    clean: false,
    outline: false,
    outlineColor: '#17202b',
    grid: false,
    gridColor: '#667085',
    scale: 10,
    exportGrid: false,
    background: false,
    backgroundTolerance: 24
  });

  let state = defaults();
  let source = null;
  let sourceData = null;
  let sourceName = '';
  let result = null;
  let activePalette = [...BLUE];
  let autoBase = [...BLUE];
  let customPresets = [];
  // Image-specific edits stay separate from reusable settings/presets.
  let edits = {};
  let editorTool = 'view';
  let brushColor = BLUE[0];
  let stroke = null;
  let editorPaletteSignature = '';
  let history = [snapshot()];
  let historyIndex = 0;
  let historyTimer;
  let renderTimer;
  let gridCache = null;
  let backgroundGridCache = null;
  let backgroundMaskCache = null;
  let picking = false;
  let holding = false;
  let pressing = false;
  let pressTimer;
  let loadToken = 0;
  let paletteSignature = '';
  const ctx = $('preview').getContext('2d');
  const originalCtx = $('original').getContext('2d');
  // ── Color and state helpers ──
  const clone = x => JSON.parse(JSON.stringify(x));
  const clamp = (v, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, v));
  const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(clamp(v)).toString(16).padStart(2, '0')).join('');
  const unique = a => [...new Set(a.map(x => x.toLowerCase()))];
  const count = () => state.bit === 'free' ? state.count : 2 ** Number(state.bit);
  const height = () => source ? Math.max(1, Math.round(state.width * source.height / source.width)) : 0;

  function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  }

  // ── Preset persistence ──
  function readPresets() {
    try {
      const saved = JSON.parse(localStorage.getItem('pixel-studio-presets') || '[]');

      if (Array.isArray(saved))
        customPresets = saved.filter(p => p && typeof p.name === 'string' && p.settings && Array.isArray(p.settings.palette)).slice(0, 40);
    } catch {
      status('無法讀取已儲存風格；仍可正常創作。');
    }
  }

  function persistPresets() {
    try {
      localStorage.setItem('pixel-studio-presets', JSON.stringify(customPresets));
      return true;
    } catch {
      status('瀏覽器無法儲存風格，請檢查儲存空間或隱私設定。', true);
      return false;
    }
  }

  // ── Undo / redo ──
  function snapshot() {
    return JSON.stringify({ settings: state, edits });
  }

  function historyButtons() {
    $('undo').disabled = historyIndex <= 0;
    $('redo').disabled = historyIndex >= history.length - 1;
  }

  function record() {
    clearTimeout(historyTimer);
    const snap = snapshot();

    if (snap === history[historyIndex])
      return;

    history = history.slice(0, historyIndex + 1);
    history.push(snap);

    if (history.length > 80)
      history.shift();

    historyIndex = history.length - 1;
    historyButtons();
  }

  function change(fn, live = false) {
    finishStroke();
    const previous = clone(state);
    fn();
    if (state.width !== previous.width && Object.keys(edits).length) {
      if (!confirm('變更網格寬度會清除手動修補。要繼續嗎？之後可按復原還原。')) {
        state = previous;
        sync();
        return false;
      }
      // Commit the old settings and edits before the destructive geometry change.
      const next = state;
      state = previous;
      record();
      state = next;
      edits = {};
    }
    sync();
    schedule();
    clearTimeout(historyTimer);

    if (live)
      historyTimer = setTimeout(record, 350);
    else
      record();
  }

  function travel(delta) {
    finishStroke();
    record();
    const next = historyIndex + delta;

    if (next < 0 || next >= history.length)
      return;

    historyIndex = next;
    const saved = JSON.parse(history[next]);
    state = saved.settings;
    edits = saved.edits;
    sync();
    schedule();
    historyButtons();
    status(delta < 0 ? '已復原上一步。' : '已重做上一步。');
  }

  // ── Palette controls ──
  function fitPalette() {
    const n = count();
    state.palette = state.palette.slice(0, n);

    while (state.palette.length < n) {
      const i = state.palette.length;
      state.palette.push(hex([255 * i / (n - 1), 255 * i / (n - 1), 255 * i / (n - 1)]));
    }
  }

  function swatch(color, label, oninput) {
    const el = document.createElement('input');
    el.type = 'color';
    el.value = color;
    el.className = 'swatch';
    el.title = label + ' ' + color;
    el.setAttribute('aria-label', label + ' ' + color);
    el.addEventListener('input', () => oninput(el.value));

    el.addEventListener('blur', () => setTimeout(() => {
      drawPalette();
      drawAccents();
    }, 0));

    return el;
  }

  function drawPalette() {
    const colors = activePalette;
    const box = $('palette');

    if (box.contains(document.activeElement) && document.activeElement.type === 'color')
      return;

    const sig = JSON.stringify([colors, state.mode, state.rgb]);

    if (sig === paletteSignature)
      return;

    paletteSignature = sig;
    box.replaceChildren();
    box.classList.toggle('large', colors.length > 24);

    colors.slice(0, 256).forEach((color, i) => {
      const base = state.rgb ? colors : (state.mode === 'auto' ? autoBase : state.palette);
      const baseIndex = base.indexOf(color);
      const accentIndex = state.accents.indexOf(color);

      box.append(swatch(color, '色盤第 ' + (i + 1) + ' 色', value => {
        change(() => {
          if (state.rgb) {
            state.rgb = false;
            state.palette = colors.slice(0, 256);
            state.mode = 'custom';
            state.bit = 'free';
            state.count = Math.max(2, state.palette.length);
          } else if (state.mode === 'auto') {
            state.palette = [...autoBase];
            state.mode = 'custom';
          }

          if (baseIndex < 0 && accentIndex >= 0) {
            state.accents[accentIndex] = value;
          } else {
            state.palette[Math.max(0, baseIndex)] = value;
          }
        }, true);
      }));
    });

    if (colors.length > 256) {
      const more = document.createElement('span');
      more.className = 'hint';
      more.textContent = '共 ' + colors.length + ' 色，顯示前 256 色';
      box.append(more);
    }
  }

  function drawAccents() {
    const box = $('accents');
    const focused = document.activeElement;

    if (box.contains(focused) && focused.type === 'color')
      return;

    box.replaceChildren();

    state.accents.forEach((color, i) => {
      const chip = document.createElement('div');
      chip.className = 'accent-chip';
      chip.append(swatch(color, '強調色 ' + (i + 1), value => change(() => state.accents[i] = value, true)));
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = '移除強調色 ' + (i + 1);
      remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => change(() => state.accents.splice(i, 1));
      chip.append(remove);
      box.append(chip);
    });

    if (!state.accents.length) {
      const p = document.createElement('span');
      p.className = 'accent-placeholder';
      p.textContent = '尚未加入強調色';
      box.append(p);
    }
  }

  // ── Settings → interface ──
  function sync() {
    for (const key of [
      'width',
      'count',
      'brightness',
      'contrast',
      'saturation',
      'scale',
      'redBits',
      'greenBits',
      'blueBits',
      'ditherMethod',
      'outlineColor',
      'gridColor'
    ])
      $(key).value = state[key];

    for (const key of ['rgb', 'dither', 'clean', 'outline', 'grid', 'exportGrid'])
      $(key).checked = state[key];

    $('widthValue').textContent = state.width + ' 格';
    $('heightValue').textContent = (height() || '—') + ' 格';
    $('countValue').textContent = state.count + ' 色';
    $('scaleValue').textContent = state.scale + ' 倍';

    for (const key of ['brightness', 'contrast', 'saturation'])
      $(key + 'Value').textContent = (state[key] > 0 ? '+' : '') + state[key];

    document.querySelectorAll('[data-bit]').forEach(b => b.classList.toggle('active', b.dataset.bit === state.bit));
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
    $('freeRow').hidden = state.bit !== 'free';
    $('rgbOptions').hidden = !state.rgb;
    $('ditherMethod').hidden = !state.dither;
    $('addColor').disabled = state.rgb || state.palette.length >= 256;
    $('removeColor').disabled = state.rgb || state.palette.length <= 2;
    $('eyedropper').disabled = !source || state.accents.length >= 2;
    $('eyedropper').classList.toggle('active', picking);
    $('eyedropper').textContent = picking ? '取消取色' : '⌖ 從原圖取色';
    $('pickHint').textContent = picking ? '請點選畫布，從原始圖片取色；按 Esc 取消。' : '保留一點與眾不同。強調色不受減色數量限制。';
    $('stage').classList.toggle('picking', picking);
    $('gridInfo').textContent = state.width + ' × ' + (height() || '—') + ' 格';
    $('exportSize').textContent = source ? (state.width * state.scale) + ' × ' + (height() * state.scale) + ' 像素' : '— × — 像素';

    if (state.mode === 'custom' && !state.rgb)
      activePalette = unique([...state.palette, ...state.accents]);

    drawPalette();
    drawAccents();
    syncEditor();
    syncBackground();
  }

  // ── Preset buttons ──
  function drawPresets() {
    const box = $('presets');
    box.replaceChildren();

    const list = [{
      name: '藍白 4 色',
      colors: BLUE,

      run: () => change(() => {
        Object.assign(state, {
          bit: '2',
          count: 4,
          mode: 'custom',
          palette: [...BLUE],
          accents: [],
          rgb: false
        });
      })
    }, {
      name: '綠色卡片',
      colors: GREEN,

      run: () => change(() => {
        Object.assign(state, {
          bit: '2',
          count: 4,
          mode: 'custom',
          palette: [...GREEN],
          accents: ['#68b0cb'],
          rgb: false
        });
      })
    }, ...customPresets.map((p, i) => ({
      name: p.name,
      colors: p.settings.palette,

      run: () => change(() => {
        state = Object.assign(defaults(), clone(p.settings));
      }),

      index: i
    }))];

    list.forEach(p => {
      const wrap = document.createElement('div');
      wrap.className = 'preset-item';
      const b = document.createElement('button');
      b.className = 'preset-button';
      const dots = document.createElement('span');
      dots.className = 'preset-dots';
      dots.setAttribute('aria-hidden', 'true');

      p.colors.slice(0, 4).forEach(c => {
        const d = document.createElement('i');
        d.style.background = c;
        dots.append(d);
      });

      b.append(dots, document.createTextNode(p.name));

      b.onclick = () => {
        picking = false;
        p.run();
        status('已套用「' + p.name + '」。');
      };

      wrap.append(b);

      if (p.index !== undefined) {
        const del = document.createElement('button');
        del.className = 'preset-delete';
        del.textContent = '×';
        del.title = '刪除「' + p.name + '」';
        del.setAttribute('aria-label', del.title);

        del.onclick = () => {
          const old = clone(customPresets);
          customPresets.splice(p.index, 1);

          if (!persistPresets())
            customPresets = old;

          drawPresets();
        };

        wrap.append(del);
      }

      box.append(wrap);
    });
  }

  // ── Conversion pipeline: average → quantize → cleanup → outline ──
  // Exact area integration: RGB is weighted by coverage and source alpha.
  // Cache the small grid so palette, detail, and export changes never rescan the image.
  function averageGrid(adjusted = true) {
    const w = state.width;
    const h = height();
    const key = [w, h, ...(adjusted ? [state.brightness, state.contrast, state.saturation] : [])].join(':');
    const cached = adjusted ? gridCache : backgroundGridCache;
    if (cached?.key === key) return cached.data;

    const sw = source.width;
    const sh = source.height;
    const pixels = sourceData.data;
    const out = new Float32Array(w * h * 4);
    const dx = sw / w;
    const dy = sh / h;
    const bright = state.brightness * 2.55;
    const contrast = state.contrast >= 0 ? 1 + state.contrast / 50 : 1 + state.contrast / 100;
    const sat = 1 + state.saturation / 100;
    const adjust = adjusted && (state.brightness || state.contrast || state.saturation);

    for (let y = 0; y < h; y++) {
      const y0 = y * dy;
      const y1 = (y + 1) * dy;

      for (let x = 0; x < w; x++) {
        const x0 = x * dx;
        const x1 = (x + 1) * dx;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;

        for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
          const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);

          for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
            const i = (sy * sw + sx) * 4;
            const weight = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx)) * pixels[i + 3] / 255;

            if (!weight)
              continue;

            let cr = pixels[i];
            let cg = pixels[i + 1];
            let cb = pixels[i + 2];

            if (adjust) {
              const lum = .2126 * cr + .7152 * cg + .0722 * cb;
              cr = clamp(((lum + (cr - lum) * sat) - 127.5) * contrast + 127.5 + bright);
              cg = clamp(((lum + (cg - lum) * sat) - 127.5) * contrast + 127.5 + bright);
              cb = clamp(((lum + (cb - lum) * sat) - 127.5) * contrast + 127.5 + bright);
            }

            r += cr * weight;
            g += cg * weight;
            b += cb * weight;
            a += weight;
          }
        }

        const j = (y * w + x) * 4;

        if (a) {
          out[j] = r / a;
          out[j + 1] = g / a;
          out[j + 2] = b / a;
          out[j + 3] = clamp(a / (dx * dy) * 255);
        }
      }
    }

    if (adjusted) gridCache = { key, data: out };
    else backgroundGridCache = { key, data: out };

    return out;
  }

  // Weighted median-cut over a compact histogram of the adjusted cell colors.
  function medianCut(data, n) {
    const bins = new Map();

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 1)
        continue;

      const k = (Math.round(data[i]) >> 3) << 10 | (Math.round(data[i + 1]) >> 3) << 5 | (Math.round(data[i + 2]) >> 3);
      const weight = data[i + 3] / 255;
      let v = bins.get(k);

      if (!v) {
        v = [0, 0, 0, 0];
        bins.set(k, v);
      }

      for (let c = 0; c < 3; c++)
        v[c] += data[i + c] * weight;

      v[3] += weight;
    }

    const points = [...bins.values()].map(v => [v[0] / v[3], v[1] / v[3], v[2] / v[3], v[3]]);

    if (!points.length)
      return ['#000000', '#ffffff'].slice(0, n);

    function box(p) {
      let ranges = [0, 1, 2].map(c => {
        let lo = 255;
        let hi = 0;

        for (const v of p) {
          lo = Math.min(lo, v[c]);
          hi = Math.max(hi, v[c]);
        }

        return hi - lo;
      });

      let axis = ranges.indexOf(Math.max(...ranges));

      return {
        p,
        axis,
        score: ranges[axis] * p.reduce((s, v) => s + v[3], 0)
      };
    }

    let boxes = [box(points)];

    while (boxes.length < n) {
      let idx = -1;
      let best = -1;

      boxes.forEach((b, i) => {
        if (b.p.length > 1 && b.score > best) {
          idx = i;
          best = b.score;
        }
      });

      if (idx < 0)
        break;

      const b = boxes[idx];
      b.p.sort((a, c) => a[b.axis] - c[b.axis]);
      const total = b.p.reduce((s, v) => s + v[3], 0);
      let sum = 0;
      let cut = 1;

      for (let i = 0; i < b.p.length - 1; i++) {
        sum += b.p[i][3];
        cut = i + 1;

        if (sum >= total / 2)
          break;
      }

      boxes.splice(idx, 1, box(b.p.slice(0, cut)), box(b.p.slice(cut)));
    }

    return unique(boxes.map(b => {
      const s = [0, 0, 0, 0];

      for (const p of b.p) {
        for (let c = 0; c < 3; c++)
          s[c] += p[c] * p[3];

        s[3] += p[3];
      }

      return hex(s.slice(0, 3).map(v => v / s[3]));
    })).sort((a, b) => rgb(a).reduce((s, v) => s + v, 0) - rgb(b).reduce((s, v) => s + v, 0));
  }

  function quantize(data, w, h) {
    autoBase = state.mode === 'auto' ? medianCut(data, count()) : [...state.palette];
    let colors = unique([...autoBase, ...state.accents]);
    let pal = colors.map(rgb);
    let accents = state.accents.map(rgb);
    let out = new Uint8ClampedArray(data.length);
    let work = new Float32Array(data);
    let used = new Set();
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const levels = [state.redBits, state.greenBits, state.blueBits].map(b => 2 ** b - 1);

    function nearest(r, g, b) {
      let best = Infinity;
      let chosen = pal[0] || [0, 0, 0];
      let accentDistance = Infinity;
      let accentMatch = null;

      for (const a of accents) {
        const d = (r - a[0]) ** 2 + (g - a[1]) ** 2 + (b - a[2]) ** 2;

        if (d < accentDistance) {
          accentDistance = d;
          accentMatch = a;
        }
      }

      if (accentDistance <= 42 ** 2)
        return accentMatch;

      if (state.rgb)
        return [r, g, b].map((v, c) => Math.round(clamp(v) / 255 * levels[c]) * 255 / levels[c]);

      for (const c of pal) {
        const d = .299 * (r - c[0]) ** 2 + .587 * (g - c[1]) ** 2 + .114 * (b - c[2]) ** 2;

        if (d < best) {
          best = d;
          chosen = c;
        }
      }

      return chosen;
    }

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;

      if (data[i + 3] < .5)
        continue;

      let r = work[i];
      let g = work[i + 1];
      let b = work[i + 2];

      if (state.dither && state.ditherMethod === 'bayer') {
        const offset = (bayer[(y % 4) * 4 + x % 4] / 16 - .46875) * (state.rgb ? 48 : 64);
        r += offset;
        g += offset;
        b += offset;
      }

      const c = nearest(r, g, b);
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = data[i + 3];

      if (state.rgb)
        used.add(hex(c));

      if (state.dither && state.ditherMethod === 'floyd') {
        const e = [r - c[0], g - c[1], b - c[2]];

        for (const [ox, oy, k] of [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]) {
          const xx = x + ox;
          const yy = y + oy;

          if (xx < 0 || xx >= w || yy >= h)
            continue;

          const j = (yy * w + xx) * 4;

          if (!data[j + 3])
            continue;

          for (let z = 0; z < 3; z++)
            work[j + z] += e[z] * k;
        }
      }
    }

    activePalette = state.rgb ? unique([...used, ...state.accents]) : colors;
    return out;
  }

  function cleanPixels(data, w, h) {
    const out = new Uint8ClampedArray(data);

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;

      if (!data[i + 3])
        continue;

      let same = false;
      let neighbors = 0;
      const groups = new Map();

      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + ox;
        const yy = y + oy;

        if (xx < 0 || xx >= w || yy < 0 || yy >= h)
          continue;

        const j = (yy * w + xx) * 4;

        if (!data[j + 3])
          continue;

        neighbors++;
        const k = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
        const own = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];

        if (k === own)
          same = true;

        groups.set(k, (groups.get(k) || 0) + 1);
      }

      if (!same && neighbors >= 2) {
        let best = null;
        let n = 0;

        for (const [c, v] of groups) if (v > n) {
          best = c;
          n = v;
        }

        if (n >= Math.ceil(neighbors / 2)) {
          out[i] = best >> 16;
          out[i + 1] = (best >> 8) & 255;
          out[i + 2] = best & 255;
        }
      }
    }

    return out;
  }

  function outlinePixels(data, w, h) {
    const out = new Uint8ClampedArray(data);
    const color = rgb(state.outlineColor);

    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;

      if (!data[i + 3])
        continue;

      let edge = false;
      const lum = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];

      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + ox;
        const yy = y + oy;

        if (xx < 0 || xx >= w || yy < 0 || yy >= h) {
          edge = true;
          break;
        }

        const j = (yy * w + xx) * 4;

        if (data[j + 3] < data[i + 3] * .5) {
          edge = true;
          break;
        }

        const other = .299 * data[j] + .587 * data[j + 1] + .114 * data[j + 2];

        if (lum + 45 < other) {
          edge = true;
          break;
        }
      }

      if (edge) {
        out[i] = color[0];
        out[i + 1] = color[1];
        out[i + 2] = color[2];
      }
    }

    return out;
  }

  // ── Preview layout and grid ──
  function fit() {
    if (!source)
      return;

    const stage = $('stage');
    const style = getComputedStyle(stage);
    const maxW = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const maxH = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const ratio = state.width / height();
    let w = Math.min(maxW, maxH * ratio);
    let h = w / ratio;
    $('canvasWrap').style.width = Math.max(1, w) + 'px';
    $('canvasWrap').style.height = Math.max(1, h) + 'px';
    drawGrid();
  }

  function paintGrid(c, w, h, sizeX, sizeY, color) {
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();

    for (let x = 0; x <= w; x++) {
      const px = Math.min(w * sizeX - .5, Math.max(.5, Math.round(x * sizeX) + .5));
      c.moveTo(px, 0);
      c.lineTo(px, h * sizeY);
    }

    for (let y = 0; y <= h; y++) {
      const py = Math.min(h * sizeY - .5, Math.max(.5, Math.round(y * sizeY) + .5));
      c.moveTo(0, py);
      c.lineTo(w * sizeX, py);
    }

    c.stroke();
  }

  function drawGrid() {
    const canvas = $('gridCanvas');
    canvas.hidden = !state.grid || holding || pressing || !source;

    if (canvas.hidden)
      return;

    const wrap = $('canvasWrap');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));

    paintGrid(
      canvas.getContext('2d'),
      state.width,
      height(),
      canvas.width / state.width,
      canvas.height / height(),
      state.gridColor
    );
  }

  // ── Render scheduling ──
  function schedule() {
    clearTimeout(renderTimer);

    if (!source) {
      sync();
      return;
    }

    $('processing').hidden = false;

    renderTimer = setTimeout(() => {
      try {
        render();
      } catch (e) {
        status('轉換失敗，請嘗試較小的圖片或網格。', true);
        console.error(e);
      } finally {
        $('processing').hidden = true;
      }
    }, 35);
  }

  function render() {
    const w = state.width;
    const h = height();
    const data = maskBackground(averageGrid(), w, h);
    let pixels = quantize(data, w, h);

    if (state.clean)
      pixels = cleanPixels(pixels, w, h);

    if (state.outline)
      pixels = outlinePixels(pixels, w, h);

    applyEdits(pixels);
    result = new ImageData(pixels, w, h);
    $('preview').width = w;
    $('preview').height = h;
    ctx.putImageData(result, 0, 0);
    drawPalette();
    $('colorInfo').textContent = (state.rgb ? 'RGB 格點・' : '') + activePalette.length + ' 色' + (state.outline ? '＋描邊' : '');
    fit();
    $('download').disabled = false;
    $('downloadSVG').disabled = false;
    syncEditor();
    syncBackground();
  }

  function showOriginal() {
    const show = holding || pressing;
    $('original').hidden = !show;
    $('preview').hidden = show;
    $('previewMode').textContent = show ? '原圖對照' : picking ? '原圖取色' : '像素預覽';
    drawGrid();
  }

  // ── Image loading ──
  async function loadFile(file) {
    if (!file)
      return;

    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) {
      status('請選擇 PNG、JPG、WebP 或 GIF 圖片。', true);
      return;
    }

    const token = ++loadToken;
    const url = URL.createObjectURL(file);
    status('正在讀取圖片…');

    try {
      const image = new Image();
      image.src = url;
      await image.decode();

      if (token !== loadToken)
        return;

      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 4000 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

      const c = canvas.getContext('2d', {
        willReadFrequently: true
      });

      c.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = c.getImageData(0, 0, canvas.width, canvas.height);
      if (Object.keys(edits).length && !confirm('載入新圖片會清除目前修補與復原紀錄。請先下載作品；確定換圖嗎？')) {
        status('已取消換圖，保留目前作品。');
        return;
      }
      finishStroke();
      edits = {};
      history = [snapshot()];
      historyIndex = 0;
      historyButtons();
      source = canvas;
      sourceData = pixels;
      sourceName = file.name;
      gridCache = null;
      backgroundGridCache = null;
      backgroundMaskCache = null;
      result = null;
      $('download').disabled = true;
      $('downloadSVG').disabled = true;
      $('original').width = canvas.width;
      $('original').height = canvas.height;
      originalCtx.drawImage(canvas, 0, 0);
      $('filename').textContent = file.name;
      $('imageInfo').textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' 像素';
      $('imageInfo').title = file.name;
      $('empty').hidden = true;
      $('canvasWrap').hidden = false;
      picking = false;
      sync();
      schedule();
      status('已載入「' + file.name + '」。所有調整都會即時預覽。' + (scale < 1 ? ' 大圖已等比例縮至 4000 像素處理。' : ''));
    } catch {
      if (token === loadToken)
        status('無法讀取這張圖片，請選擇其他有效的圖片檔案。', true);
    } finally {
      URL.revokeObjectURL(url);
      $('fileInput').value = '';
    }
  }

  // ── PNG export ──
  function download() {
    if (!source)
      return;

    clearTimeout(renderTimer);

    try {
      render();
      const canvas = document.createElement('canvas');
      canvas.width = result.width * state.scale;
      canvas.height = result.height * state.scale;
      const c = canvas.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.drawImage($('preview'), 0, 0, canvas.width, canvas.height);

      if (state.exportGrid)
        paintGrid(c, result.width, result.height, state.scale, state.scale, state.gridColor);

      canvas.toBlob(blob => {
        if (!blob) {
          status('匯出失敗，請降低倍率再試一次。', true);
          return;
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (sourceName.replace(/\.[^.]+$/, '') || '作品') + '-像素-' + state.width + '格.png';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        status('已匯出 ' + canvas.width + ' × ' + canvas.height + ' 像素 PNG。');
      }, 'image/png');
    } catch {
      status('匯出尺寸過大，請降低網格或倍率。', true);
    } finally {
      $('processing').hidden = true;
    }
  }

  // ── SVG export: horizontal runs, then identical runs merged vertically ──
  function mergeRectangles(image) {
    const { width, height, data } = image;
    const rectangles = [];
    let previous = new Map();
    for (let y = 0; y < height; y++) {
      const current = new Map();
      let x = 0;
      while (x < width) {
        const i = (y * width + x) * 4;
        if (!data[i + 3]) { x++; continue; }
        const start = x;
        const rgba = Array.from(data.slice(i, i + 4));
        x++;
        while (x < width) {
          const j = (y * width + x) * 4;
          if (rgba.some((value, channel) => data[j + channel] !== value)) break;
          x++;
        }
        const runWidth = x - start;
        const key = [start, runWidth, ...rgba].join(':');
        let rect = previous.get(key);
        if (rect) rect.height++;
        else {
          rect = { x: start, y, width: runWidth, height: 1, rgba };
          rectangles.push(rect);
        }
        current.set(key, rect);
      }
      previous = current;
    }
    return rectangles;
  }

  function downloadBlob(blob, extension) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (sourceName.replace(/\.[^.]+$/, '') || '作品') + '-像素-' + state.width + '格.' + extension;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function downloadSVG() {
    if (!source) return;
    finishStroke();
    clearTimeout(renderTimer);
    try {
      render();
      const rectangles = mergeRectangles(result);
      const body = rectangles.map(rect => {
        const opacity = rect.rgba[3] < 255 ? ' fill-opacity="' + rect.rgba[3] / 255 + '"' : '';
        return '<rect x="' + rect.x + '" y="' + rect.y + '" width="' + rect.width +
          '" height="' + rect.height + '" fill="' + hex(rect.rgba) + '"' + opacity + '/>';
      }).join('\n');
      const svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + result.width * state.scale +
        '" height="' + result.height * state.scale + '" viewBox="0 0 ' + result.width + ' ' + result.height +
        '" shape-rendering="crispEdges">\n<title>像素作品</title>\n' + body + '\n</svg>\n';
      downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), 'svg');
      status('已匯出 SVG，共 ' + rectangles.length + ' 個合併方塊，保留透明背景。');
    } catch (error) {
      status('SVG 匯出失敗，請嘗試較小的網格。', true);
      console.error(error);
    } finally {
      $('processing').hidden = true;
    }
  }

  // ── Background removal: flood fill on the unadjusted grid ──
  function backgroundMask(w, h) {
    const key = [w, h, state.backgroundTolerance].join(':');
    if (backgroundMaskCache?.key === key) return backgroundMaskCache;
    const data = averageGrid(false);
    const border = [];
    for (let x = 0; x < w; x++) {
      border.push(x);
      if (h > 1) border.push((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      border.push(y * w);
      if (w > 1) border.push(y * w + w - 1);
    }
    // The largest color bucket resists a small subject touching the border.
    const bins = new Map();
    for (const cell of border) {
      const i = cell * 4;
      if (data[i + 3] < 1) continue;
      const bucket = [data[i], data[i + 1], data[i + 2]].map(v => Math.round(v) >> 4).join(':');
      const bin = bins.get(bucket) || { total: 0, sum: [0, 0, 0] };
      const weight = data[i + 3] / 255;
      bin.total += weight;
      for (let c = 0; c < 3; c++) bin.sum[c] += data[i + c] * weight;
      bins.set(bucket, bin);
    }
    let dominant = null;
    for (const bin of bins.values()) if (!dominant || bin.total > dominant.total) dominant = bin;
    const color = dominant ? dominant.sum.map(v => v / dominant.total) : null;
    const limit = 3 * state.backgroundTolerance ** 2;
    const matches = cell => {
      const i = cell * 4;
      if (data[i + 3] < 1) return true;
      return color && (data[i] - color[0]) ** 2 + (data[i + 1] - color[1]) ** 2 +
        (data[i + 2] - color[2]) ** 2 <= limit;
    };
    const mask = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    let removed = 0;
    function enqueue(cell) {
      if (mask[cell] || !matches(cell)) return;
      mask[cell] = 1;
      queue[tail++] = cell;
      if (data[cell * 4 + 3] >= 1) removed++;
    }
    border.forEach(enqueue);
    while (head < tail) {
      const cell = queue[head++];
      const x = cell % w;
      const y = Math.floor(cell / w);
      if (x > 0) enqueue(cell - 1);
      if (x < w - 1) enqueue(cell + 1);
      if (y > 0) enqueue(cell - w);
      if (y < h - 1) enqueue(cell + w);
    }
    backgroundMaskCache = { key, mask, removed, color };
    return backgroundMaskCache;
  }

  function maskBackground(data, w, h) {
    if (!state.background) return data;
    const { mask } = backgroundMask(w, h);
    const masked = new Float32Array(data);
    for (let cell = 0; cell < mask.length; cell++) {
      if (mask[cell]) masked.fill(0, cell * 4, cell * 4 + 4);
    }
    return masked;
  }

  function syncBackground() {
    $('removeBackground').disabled = !source;
    $('removeBackground').textContent = state.background ? '已啟用去背' : '一鍵去背';
    $('removeBackground').setAttribute('aria-pressed', String(state.background));
    $('restoreBackground').disabled = !source || !state.background;
    $('backgroundTolerance').value = state.backgroundTolerance;
    $('backgroundToleranceValue').textContent = state.backgroundTolerance;
    $('backgroundInfo').textContent = source && state.background && backgroundMaskCache
      ? '已移除 ' + backgroundMaskCache.removed + ' 格背景（不含手動修補）；可復原或還原背景。'
      : '尚未去背';
  }

  function bindBackground() {
    $('removeBackground').onclick = () => change(() => { state.background = true; });
    $('restoreBackground').onclick = () => change(() => { state.background = false; });
    $('backgroundTolerance').oninput = () => change(() => {
      state.backgroundTolerance = Number($('backgroundTolerance').value);
    }, true);
  }

  // ── Manual editing: sparse RGBA overlay, one history entry per stroke ──
  function applyEdits(pixels) {
    for (const [cell, color] of Object.entries(edits)) {
      pixels.set(color, Number(cell) * 4);
    }
  }

  function syncEditor() {
    const colors = activePalette;
    if (!colors.includes(brushColor)) brushColor = colors[0] || '#000000';
    const signature = JSON.stringify([colors, brushColor, !!source]);
    if (signature !== editorPaletteSignature) {
      editorPaletteSignature = signature;
      $('paintPalette').replaceChildren();
      const displayed = unique([...colors.slice(0, 256), brushColor]);
      displayed.forEach(color => {
        const button = document.createElement('button');
        button.className = 'paint-swatch';
        button.style.backgroundColor = color;
        button.title = '繪畫色 ' + color;
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', String(color === brushColor));
        button.disabled = !source;
        button.onclick = () => { brushColor = color; setEditorTool('pencil'); };
        $('paintPalette').append(button);
      });
    }
    document.querySelectorAll('[data-tool]').forEach(button => {
      button.disabled = !source && button.dataset.tool !== 'view';
      button.classList.toggle('active', button.dataset.tool === editorTool);
      button.setAttribute('aria-pressed', String(button.dataset.tool === editorTool));
    });
    $('stage').classList.toggle('editing', editorTool !== 'view');
    $('brushInfo').textContent = '目前繪畫色：' + brushColor + (colors.length > 256 ? '；顯示前 256 色，其餘可用滴管選取。' : '');
    const total = Object.keys(edits).length;
    $('editCount').textContent = total ? '已修補 ' + total + ' 格' : '尚未修補';
    $('clearEdits').disabled = !total;
  }

  function setEditorTool(tool) {
    finishStroke();
    editorTool = tool;
    picking = false;
    pressing = false;
    clearTimeout(pressTimer);
    sync();
    showOriginal();
  }

  function cellAt(event) {
    const rect = $('preview').getBoundingClientRect();
    if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX >= rect.right ||
        event.clientY < rect.top || event.clientY >= rect.bottom) return null;
    return {
      x: Math.floor((event.clientX - rect.left) / rect.width * result.width),
      y: Math.floor((event.clientY - rect.top) / rect.height * result.height)
    };
  }

  function paintCell(x, y) {
    const index = y * result.width + x;
    const color = editorTool === 'eraser' ? [0, 0, 0, 0] : [...rgb(brushColor), 255];
    edits[index] = color;
    result.data.set(color, index * 4);
  }

  function paintLine(from, to) {
    // Interpolate every crossed cell even when pointer events are far apart.
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      paintCell(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t));
    }
    ctx.putImageData(result, 0, 0);
  }

  function finishStroke() {
    if (!stroke) return;
    const pointerId = stroke.pointerId;
    stroke = null;
    if ($('preview').hasPointerCapture(pointerId)) $('preview').releasePointerCapture(pointerId);
    record();
    syncEditor();
  }

  function bindEditor() {
    $('editorTools').onclick = event => {
      const button = event.target.closest('[data-tool]');
      if (button) setEditorTool(button.dataset.tool);
    };
    $('clearEdits').onclick = () => {
      finishStroke();
      record();
      edits = {};
      record();
      syncEditor();
      schedule();
      status('已清除修補；可按復原還原。');
    };
    const canvas = $('preview');
    canvas.addEventListener('pointerdown', event => {
      if (!source || editorTool === 'view' || picking || holding || event.button !== 0 || stroke) return;
      event.preventDefault();
      clearTimeout(renderTimer);
      render();
      $('processing').hidden = true;
      const cell = cellAt(event);
      if (!cell) return;
      if (editorTool === 'picker') {
        const i = (cell.y * result.width + cell.x) * 4;
        if (!result.data[i + 3]) { status('這格是透明的，請選擇有顏色的格子。'); return; }
        const color = hex(Array.from(result.data.slice(i, i + 3)));
        if (!activePalette.includes(color)) {
          status('這格的保留色或描邊色不在目前色盤，請先在色彩區加入此色：' + color);
          return;
        }
        brushColor = color;
        setEditorTool('pencil');
        status('已選取像素色 ' + color + '。');
        return;
      }
      record();
      stroke = { pointerId: event.pointerId, last: cell };
      canvas.setPointerCapture(event.pointerId);
      paintLine(cell, cell);
    });
    canvas.addEventListener('pointermove', event => {
      if (!stroke || event.pointerId !== stroke.pointerId) return;
      const cell = cellAt(event);
      if (!cell) { stroke.last = null; return; }
      paintLine(stroke.last || cell, cell);
      stroke.last = cell;
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(event, finishStroke);
    }
  }

  // ── Event registration: one owner per interaction ──
  function bindSettings() {
    for (const key of ['width', 'count', 'brightness', 'contrast', 'saturation', 'scale']) $(key).addEventListener('input', () => change(() => {
      state[key] = Number($(key).value);

      if (key === 'count' && state.mode === 'custom')
        fitPalette();
    }, true));

    for (const key of ['rgb', 'dither', 'clean', 'outline', 'grid', 'exportGrid'])
      $(key).addEventListener('change', () => change(() => state[key] = $(key).checked));

    for (const key of ['redBits', 'greenBits', 'blueBits', 'ditherMethod', 'outlineColor', 'gridColor']) $(key).addEventListener(
      'input',
      () => change(() => state[key] = key.endsWith('Bits') ? Number($(key).value) : $(key).value, true)
    );

    $('bits').onclick = e => {
      const b = e.target.closest('[data-bit]');

      if (b) change(() => {
        state.bit = b.dataset.bit;

        if (state.bit !== 'free')
          state.count = 2 ** Number(state.bit);

        if (state.mode === 'custom')
          fitPalette();
      });
    };

    $('modes').onclick = e => {
      const b = e.target.closest('[data-mode]');

      if (b) change(() => {
        if (state.mode === 'auto' && b.dataset.mode === 'custom')
          state.palette = [...autoBase];

        state.mode = b.dataset.mode;
      });
    };

    $('addColor').onclick = () => change(() => {
      if (state.mode === 'auto')
        state.palette = [...autoBase];

      state.mode = 'custom';

      if (state.palette.length < 256)
        state.palette.push('#808080');

      state.bit = 'free';
      state.count = state.palette.length;
    });

    $('removeColor').onclick = () => change(() => {
      if (state.mode === 'auto')
        state.palette = [...autoBase];

      state.mode = 'custom';

      if (state.palette.length > 2)
        state.palette.pop();

      while (state.palette.length < 2)
        state.palette.push('#ffffff');

      state.bit = 'free';
      state.count = state.palette.length;
    });
  }

  function bindAccentPicker() {
    $('eyedropper').onclick = () => {
      finishStroke();
      editorTool = 'view';
      picking = !picking;
      sync();
      showOriginal();
    };

    $('stage').onclick = e => {
      if (!picking || !source)
        return;

      const rect = $('canvasWrap').getBoundingClientRect();

      if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom)
        return;

      const x = Math.min(source.width - 1, Math.floor((e.clientX - rect.left) / rect.width * source.width));
      const y = Math.min(source.height - 1, Math.floor((e.clientY - rect.top) / rect.height * source.height));
      const i = (y * source.width + x) * 4;

      if (!sourceData.data[i + 3]) {
        status('這裡是透明背景，請選擇有顏色的區域。');
        return;
      }

      const color = hex([...sourceData.data.slice(i, i + 3)]);

      if (state.accents.includes(color)) {
        status('這個顏色已在強調色中，請選擇其他顏色。');
        return;
      }

      picking = false;

      change(() => {
        if (state.accents.length < 2)
          state.accents.push(color);
      });

      showOriginal();
      status('已從原圖加入強調色 ' + color + '。');
    };
  }

  function bindPreviewInteractions() {
    const textFocused = () => {
      const el = document.activeElement;
      return el && (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || el.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(el.type));
    };

    window.addEventListener('keydown', e => {
      if (textFocused())
        return;

      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        travel(e.shiftKey ? 1 : -1);
      }

      if (e.code === 'Space' && source) {
        e.preventDefault();
        finishStroke();
        holding = true;
        showOriginal();
      }

      if (e.code === 'Escape') {
        picking = false;
        sync();
        showOriginal();
      }
    });

    window.addEventListener('keyup', e => {
      if (e.code === 'Space') {
        holding = false;
        showOriginal();
      }
    });

    window.addEventListener('blur', () => {
      finishStroke();
      holding = false;
      pressing = false;
      clearTimeout(pressTimer);
      showOriginal();
    });

    let pressStart;

    $('stage').addEventListener('pointerdown', e => {
      if (!source || e.button !== 0 || picking || editorTool !== 'view')
        return;

      pressStart = [e.clientX, e.clientY];
      clearTimeout(pressTimer);

      pressTimer = setTimeout(() => {
        pressing = true;
        showOriginal();
      }, 350);
    });

    $('stage').addEventListener('pointermove', e => {
      if (pressStart && Math.hypot(e.clientX - pressStart[0], e.clientY - pressStart[1]) > 10) {
        clearTimeout(pressTimer);
        pressing = false;
        showOriginal();
      }
    });

    for (const event of ['pointerup', 'pointercancel']) window.addEventListener(event, () => {
      clearTimeout(pressTimer);
      pressStart = null;
      pressing = false;
      showOriginal();
    });

    $('stage').addEventListener('contextmenu', e => {
      if (source)
        e.preventDefault();
    });
  }

  function bindUploadAndHistory() {
    $('undo').onclick = () => travel(-1);
    $('redo').onclick = () => travel(1);
    $('upload').onclick = $('emptyUpload').onclick = () => $('fileInput').click();
    $('fileInput').onchange = e => loadFile(e.target.files[0]);
    let dragDepth = 0;
    const stage = $('stage');

    stage.addEventListener('dragenter', e => {
      e.preventDefault();
      dragDepth++;
      stage.classList.add('dragging');
      $('dropHint').hidden = false;
    });

    stage.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    stage.addEventListener('dragleave', e => {
      e.preventDefault();

      if (--dragDepth <= 0) {
        dragDepth = 0;
        stage.classList.remove('dragging');
        $('dropHint').hidden = true;
      }
    });

    stage.addEventListener('drop', e => {
      e.preventDefault();
      dragDepth = 0;
      stage.classList.remove('dragging');
      $('dropHint').hidden = true;
      loadFile(e.dataTransfer.files[0]);
    });

    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());
  }

  function bindPresetEditor() {
    $('savePreset').onclick = () => {
      $('presetForm').hidden = false;
      $('presetName').focus();
    };

    $('cancelPreset').onclick = () => {
      $('presetForm').hidden = true;
    };

    $('presetForm').onsubmit = e => {
      e.preventDefault();
      const name = $('presetName').value.trim();

      if (!name) {
        status('請先輸入風格名稱。', true);
        $('presetName').focus();
        return;
      }

      if (customPresets.length >= 40) {
        status('最多可儲存 40 個風格，請先刪除不需要的風格。', true);
        return;
      }

      customPresets.push({
        name,
        settings: clone(state)
      });

      if (!persistPresets()) {
        customPresets.pop();
        return;
      }

      drawPresets();
      $('presetForm').hidden = true;
      $('presetName').value = '';
      status('已儲存風格「' + name + '」，下次開啟仍可使用。');
    };
  }

  function bindSectionResets() {
    document.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => {
      const d = defaults();

      change(() => {
        const groups = {
          preset: ['bit', 'count', 'mode', 'palette', 'accents', 'rgb'],
          pixel: ['width'],
          color: ['bit', 'count', 'mode', 'palette', 'accents', 'rgb', 'redBits', 'greenBits', 'blueBits'],
          adjust: ['brightness', 'contrast', 'saturation'],
          detail: ['dither', 'ditherMethod', 'clean', 'outline', 'outlineColor', 'grid', 'gridColor'],
          export: ['scale', 'exportGrid']
        };

        for (const k of groups[b.dataset.reset])
          state[k] = d[k];
      });

      status('此區設定已恢復預設值。');
    });

    $('download').onclick = download;
    $('downloadSVG').onclick = downloadSVG;
  }

  // ── Startup (same order as v1) ──
  bindBackground();
  bindEditor();
  bindSettings();
  bindAccentPicker();
  bindPreviewInteractions();
  bindUploadAndHistory();
  bindPresetEditor();
  bindSectionResets();
  new ResizeObserver(fit).observe($('stage'));
  readPresets();
  drawPresets();
  sync();
  historyButtons();
})();
