const historyData = window.__TOKEN_HISTORY__ || {};
let activeRange = '1d';
const hiddenModels = new Set();
// Geometry of the last render, kept so mousemove can map to buckets.
let lastRender = null;

function formatNum(n) {
  const v = Number(n || 0);
  if (!v) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 10_000 ? 0 : 1) + 'K';
  return String(Math.round(v));
}

function formatFull(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function hexWithAlpha(hex, alpha) {
  if (!hex) return `rgba(148,163,184,${alpha})`;
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map((ch) => ch + ch).join('');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / pow;
  let nice;
  if (n <= 1) nice = 1;
  else if (n <= 2) nice = 2;
  else if (n <= 2.5) nice = 2.5;
  else if (n <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

function drawSmoothPath(ctx, pts, tension = 0.5) {
  if (!pts.length) return;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], 1.5, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
  ctx.stroke();
}

function fillUnderSmoothPath(ctx, pts, baseY, tension = 0.5) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], baseY);
  ctx.lineTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
  ctx.lineTo(pts[pts.length - 1][0], baseY);
  ctx.closePath();
  ctx.fill();
}

function drawTokenChart(range, hoverIndex = -1) {
  const chart = document.getElementById('tokenChart');
  if (!chart) return;
  const data = historyData[range] || historyData['7d'];
  if (!data) return;

  const rect = chart.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(300, Math.floor(rect.width));
  const cssH = Math.max(180, Math.floor(rect.height));
  chart.width = cssW * dpr;
  chart.height = cssH * dpr;
  const ctx = chart.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const w = cssW;
  const h = cssH;
  ctx.clearRect(0, 0, w, h);

  const pad = { left: 56, right: 20, top: 14, bottom: 30 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const allModels = Array.isArray(data.models) ? data.models : [];
  const visibleModels = allModels.filter((m) => !hiddenModels.has(m.name));
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  const bucketCount = buckets.length;

  if (!bucketCount || !visibleModels.length) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const msg = !bucketCount ? 'No data in range' : 'All series hidden';
    ctx.fillText(msg, pad.left + plotW / 2, pad.top + plotH / 2);
    lastRender = null;
    return;
  }

  // Scale based on the highest per-bucket total across VISIBLE models.
  let rawMax = 0;
  for (const m of visibleModels) {
    for (const b of m.buckets) {
      if ((b.total || 0) > rawMax) rawMax = b.total || 0;
    }
  }
  const max = niceCeil(rawMax || 1);

  // Horizontal grid + y-axis labels (5 ticks).
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#64748b';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    const value = max - (max / 4) * i;
    ctx.fillText(formatNum(value), pad.left - 8, y);
  }

  const xAt = (i) => pad.left + (bucketCount <= 1 ? plotW / 2 : (plotW / (bucketCount - 1)) * i);
  const yAt = (v) => pad.top + plotH - ((Number(v || 0) / max) * plotH);

  // Vertical hover crosshair.
  if (hoverIndex >= 0 && hoverIndex < bucketCount) {
    const hx = xAt(hoverIndex);
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, pad.top);
    ctx.lineTo(hx, pad.top + plotH);
    ctx.stroke();
    ctx.restore();
  }

  // Draw one smooth line per visible model (with fill under the curve).
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const m of visibleModels) {
    const pts = m.buckets.map((b, i) => [xAt(i), yAt(b.total)]);

    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, hexWithAlpha(m.color, 0.26));
    grad.addColorStop(1, hexWithAlpha(m.color, 0));
    ctx.fillStyle = grad;
    fillUnderSmoothPath(ctx, pts, pad.top + plotH, 0.5);

    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2;
    drawSmoothPath(ctx, pts, 0.5);
  }

  // Hovered data points per model.
  if (hoverIndex >= 0 && hoverIndex < bucketCount) {
    for (const m of visibleModels) {
      const x = xAt(hoverIndex);
      const y = yAt(m.buckets[hoverIndex].total);
      ctx.beginPath();
      ctx.fillStyle = '#0a0f17';
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // X-axis tick labels.
  ctx.fillStyle = '#64748b';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  const labelEvery = Math.max(1, Math.ceil(bucketCount / 8));
  buckets.forEach((b, i) => {
    if (i !== 0 && i !== bucketCount - 1 && i % labelEvery !== 0) return;
    const x = xAt(i);
    const label = (b && b.label) || '';
    const clampedX = Math.max(pad.left + 6, Math.min(w - pad.right - 6, x));
    ctx.fillText(label, clampedX, h - 10);
  });

  lastRender = {
    range,
    xAt,
    yAt,
    pad,
    plotW,
    plotH,
    w,
    h,
    bucketCount,
    visibleModels,
    buckets,
  };
}

function renderLegend(range) {
  const legend = document.getElementById('tokenLegend');
  if (!legend) return;
  const data = historyData[range] || historyData['7d'];
  const models = (data && data.models) || [];
  if (!models.length) {
    legend.innerHTML = '<span class="text-slate-500">No model activity in this range.</span>';
    return;
  }
  legend.innerHTML = models.map((m) => {
    const total = m.totals ? m.totals.total : 0;
    const hidden = hiddenModels.has(m.name);
    return `
      <button type="button" class="legend-chip ${hidden ? 'is-hidden' : ''}" data-model="${escapeHtml(m.name)}">
        <span class="legend-dot" style="background:${m.color}"></span>
        <span class="legend-name">${escapeHtml(m.name)}</span>
        <span class="legend-total-val">${formatNum(total)}</span>
      </button>
    `;
  }).join('');

  legend.querySelectorAll('.legend-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.model;
      if (hiddenModels.has(name)) hiddenModels.delete(name);
      else hiddenModels.add(name);
      renderLegend(activeRange);
      drawTokenChart(activeRange);
      hideTooltip();
    });
  });
}

function showTooltip(ev, bucketIdx) {
  if (!lastRender) return;
  const tip = document.getElementById('tokenTooltip');
  const wrap = document.getElementById('tokenChartWrap');
  if (!tip || !wrap) return;

  const bucket = lastRender.buckets[bucketIdx];
  const rows = lastRender.visibleModels
    .map((m) => ({ name: m.name, color: m.color, b: m.buckets[bucketIdx] }))
    .filter((r) => r.b && (r.b.total || r.b.prompt || r.b.completion))
    .sort((a, b) => (b.b.total || 0) - (a.b.total || 0));

  if (!rows.length) {
    tip.innerHTML = `
      <div class="token-tip-head"><span>${escapeHtml(bucket.label || '')}</span></div>
      <div class="token-tip-empty">no tokens</div>
    `;
  } else {
    const total = rows.reduce((a, r) => a + (r.b.total || 0), 0);
    const prompt = rows.reduce((a, r) => a + (r.b.prompt || 0), 0);
    const completion = rows.reduce((a, r) => a + (r.b.completion || 0), 0);
    tip.innerHTML = `
      <div class="token-tip-head">
        <span>${escapeHtml(bucket.label || '')}</span>
        <span class="token-tip-total">${formatFull(total)}</span>
      </div>
      <div class="token-tip-sub">
        <span>in <strong>${formatFull(prompt)}</strong></span>
        <span>out <strong>${formatFull(completion)}</strong></span>
      </div>
      <div class="token-tip-rows">
        ${rows.map((r) => `
          <div class="token-tip-row">
            <span class="legend-dot" style="background:${r.color}"></span>
            <span class="token-tip-name">${escapeHtml(r.name)}</span>
            <span class="token-tip-val">${formatFull(r.b.total || 0)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  tip.classList.remove('hidden');

  // Position tooltip: prefer right side of the hovered x, flip if near the right edge.
  const wrapRect = wrap.getBoundingClientRect();
  const hx = lastRender.xAt(bucketIdx);
  const tipRect = tip.getBoundingClientRect();
  const margin = 10;
  let left = hx + 14;
  if (left + tipRect.width + margin > wrapRect.width) {
    left = hx - tipRect.width - 14;
  }
  left = Math.max(margin, Math.min(wrapRect.width - tipRect.width - margin, left));
  const mouseY = ev.clientY - wrapRect.top;
  let top = mouseY - tipRect.height / 2;
  top = Math.max(margin, Math.min(wrapRect.height - tipRect.height - margin, top));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTooltip() {
  const tip = document.getElementById('tokenTooltip');
  if (tip) tip.classList.add('hidden');
  drawTokenChart(activeRange);
}

function handleMouseMove(ev) {
  if (!lastRender) return;
  const chart = document.getElementById('tokenChart');
  if (!chart) return;
  const rect = chart.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const { pad, plotW, bucketCount } = lastRender;
  if (x < pad.left - 4 || x > rect.width - pad.right + 4) {
    hideTooltip();
    return;
  }
  const step = bucketCount <= 1 ? plotW : plotW / (bucketCount - 1);
  const rel = x - pad.left;
  let idx = step > 0 ? Math.round(rel / step) : 0;
  idx = Math.max(0, Math.min(bucketCount - 1, idx));
  drawTokenChart(activeRange, idx);
  showTooltip(ev, idx);
}

function setRange(range) {
  activeRange = range;
  document.querySelectorAll('.chart-range-btn').forEach((btn) => {
    const active = btn.dataset.range === range;
    btn.classList.toggle('bg-brand-500', active);
    btn.classList.toggle('text-white', active);
  });
  drawTokenChart(range);
  renderLegend(range);
  hideTooltip();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.chart-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => setRange(btn.dataset.range));
  });

  const chart = document.getElementById('tokenChart');
  if (chart) {
    chart.addEventListener('mousemove', handleMouseMove);
    chart.addEventListener('mouseleave', hideTooltip);
  }

  setRange(activeRange);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawTokenChart(activeRange), 100);
  });
});
