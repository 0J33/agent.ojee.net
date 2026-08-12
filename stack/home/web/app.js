/* ============================================================
   home.ojee.net — control app
   Views render from one snapshot object; the server pushes deltas
   over SSE. Nothing here knows what a Haier AC is: devices are
   drawn from the capability list the backend reports, so a new
   driver appears in the UI without touching this file.
   ============================================================ */
'use strict';

const VIEWS = [
  { id: 'overview',    label: 'Overview',    icon: 'i-grid',  code: 'A' },
  { id: 'devices',     label: 'Devices',     icon: 'i-ac',    code: 'B' },
  { id: 'scenes',      label: 'Scenes',      icon: 'i-scene', code: 'C' },
  { id: 'automations', label: 'Automate',    icon: 'i-auto',  code: 'D' },
  { id: 'activity',    label: 'Activity',    icon: 'i-log',   code: 'E' },
];

/** Attributes an automation can watch. Numeric readouts only — a state trigger compares. */
const TRIGGER_ATTRS = [
  { value: 'indoor_temperature',  label: 'Indoor temperature' },
  { value: 'outdoor_temperature', label: 'Outdoor temperature' },
  { value: 'target_temperature',  label: 'Setpoint' },
];

const state = {
  snapshot: null, view: 'overview', connected: false,
  pending: new Set(), editor: null,
};

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"></use></svg>`;
const num = (v, dp = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(dp);
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const devices = () => (state.snapshot ? state.snapshot.devices : []);
const deviceById = (id) => devices().find((d) => d.id === id);

function clock() {
  $('#hud-clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function toast(kind, title, detail = '') {
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.setAttribute('role', 'status');
  node.innerHTML = `<b>${esc(title)}</b><span>${esc(detail)}</span>`;
  $('#toasts').appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, 4200);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* body was not json */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- chrome ---------- */
function renderNav() {
  $('#nav-links').innerHTML = VIEWS.map((v) => `
    <a class="nav-link${state.view === v.id ? ' active' : ''}" href="#${v.id}"
       role="tab" aria-selected="${state.view === v.id}">${esc(v.label)}</a>`).join('');
  $('#tabbar').innerHTML = VIEWS.map((v) => `
    <button class="tabitem${state.view === v.id ? ' active' : ''}" data-view="${v.id}"
            aria-current="${state.view === v.id ? 'page' : 'false'}">
      ${icon(v.icon, 'ic ic--lg')}<span>${esc(v.label)}</span></button>`).join('');
  $('#tabbar').querySelectorAll('.tabitem').forEach((b) => {
    b.addEventListener('click', () => { location.hash = b.dataset.view; });
  });
}

function renderChrome() {
  const s = state.snapshot;
  if (!s) return;
  const online = s.devices.filter((d) => d.available).length;
  $('#hud-devices').textContent = `${online}/${s.devices.length}`;
  $('#hud-poll').textContent = `${s.hub.poll_seconds}s`;
  // Any simulated device downgrades the strip: a missing localKey substitutes a simulator
  // without setting hub.demo, and claiming "live" there would imply the real AC is driven.
  const simulated = s.hub.demo || s.devices.some((d) => d.simulated);
  $('#hud-state').textContent = simulated ? 'simulated' : (online ? 'live' : 'degraded');
  $('#sb-conn').textContent = state.connected ? 'stream connected' : 'reconnecting';
  $('#sb-updated').textContent = `updated ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
}

/* ---------- device controls ---------- */
function capOf(device, key) { return device.capabilities.find((c) => c.key === key); }

function labelFor(device, key, value) {
  const cap = capOf(device, key);
  const opt = cap && (cap.options || []).find((o) => o.value === value);
  return opt ? opt.label : (value ?? '—');
}

function dial(device) {
  const st = device.state;
  const cap = capOf(device, 'target_temperature') || { min: 16, max: 30 };
  const value = Number(st.target_temperature ?? cap.min);
  const frac = Math.min(1, Math.max(0, (value - cap.min) / (cap.max - cap.min)));
  const R = 100, CIRC = 2 * Math.PI * R, arc = CIRC * 0.75;   // 270deg, gap at the bottom

  const ticks = Array.from({ length: 15 }, (_, i) => {
    const a = (135 + (270 * i) / 14) * (Math.PI / 180);
    const r1 = R + 10, r2 = R + 16;
    return `<line class="d-tick" x1="${(128 + r1 * Math.cos(a)).toFixed(1)}" y1="${(128 + r1 * Math.sin(a)).toFixed(1)}"
             x2="${(128 + r2 * Math.cos(a)).toFixed(1)}" y2="${(128 + r2 * Math.sin(a)).toFixed(1)}"/>`;
  }).join('');

  return `
  <div class="dialwrap">
    <div class="dial${st.power ? '' : ' is-off'}">
      <svg viewBox="0 0 256 256" role="img"
           aria-label="Setpoint ${value} degrees Celsius, range ${cap.min} to ${cap.max}">
        <g transform="rotate(135 128 128)">
          <circle class="d-track" cx="128" cy="128" r="${R}" stroke-dasharray="${arc} ${CIRC}"/>
          <circle class="d-fill"  cx="128" cy="128" r="${R}" stroke-dasharray="${(arc * frac).toFixed(1)} ${CIRC}"/>
        </g>
        ${ticks}
      </svg>
      <div class="d-center">
        <div class="d-set">${value}<sup>°C</sup></div>
        <div class="meta">${st.power ? esc(labelFor(device, 'mode', st.mode)) : 'standby'}</div>
        <div class="d-range meta">${cap.min}–${cap.max}°C</div>
      </div>
    </div>
    <div class="dialbtns">
      <button class="stepbtn" data-step="-1" aria-label="Decrease setpoint"
              ${!device.available || !st.power || value <= cap.min ? 'disabled' : ''}>${icon('i-minus', 'ic ic--lg')}</button>
      <input class="range" type="range" min="${cap.min}" max="${cap.max}" step="${cap.step || 1}"
             value="${value}" data-set="target_temperature" aria-label="Target temperature"
             ${device.available && st.power ? '' : 'disabled'}>
      <button class="stepbtn" data-step="1" aria-label="Increase setpoint"
              ${!device.available || !st.power || value >= cap.max ? 'disabled' : ''}>${icon('i-plus', 'ic ic--lg')}</button>
    </div>
  </div>`;
}


/* ============================================================
   Visual encoding for controls whose names carry no meaning.
   "Eco 2" and "Swing 3" tell you nothing; a picture of the louvre
   angle and a power-limit meter do. Every glyph still carries an
   aria-label and a tooltip — an icon-only control without an
   accessible name is unusable with a screen reader.
   ============================================================ */

/** Where the air actually goes.
 *
 *  A tilted bar carries no direction, and drawn for both axes it produced two icon sets that
 *  looked identical. These are two different VIEWS instead:
 *    vertical   — side view: the unit is a solid block on the left, air leaves rightward,
 *                 the arrow tilts up (angle 1) to down (angle 5)
 *    horizontal — plan view: the unit sits along the top, air leaves downward, the arrow
 *                 fans left (angle 1) to right (angle 6)
 *  So the two axes fan along different screen axes and cannot be confused.
 *
 *  Fixed and Auto share the position arrow rather than inventing a third language: Fixed runs
 *  into a stop bar, Auto draws both extremes joined by the sweep arc.
 */
function vaneGlyph(axis, token, label) {
  const open = `<svg class="ic vane" viewBox="0 0 32 32" role="img" aria-label="${esc(label)}">`;
  const unit = axis === 'v'
    ? '<rect class="unit" x="3" y="6" width="4" height="20"/>'
    : '<rect class="unit" x="6" y="3" width="20" height="4"/>';
  const pivot = axis === 'v' ? '9 16' : '16 9';
  const arrow = axis === 'v'
    ? 'M9 16h17M22.5 12L26 16l-3.5 4'
    : 'M16 9v17M12 22.5L16 26l4-3.5';

  if (token === 'fixed') {
    const shaft = axis === 'v'
      ? 'M9 16h13M18.5 12.5L22 16l-3.5 3.5'
      : 'M16 9v13M12.5 18.5L16 22l3.5-3.5';
    const stop = axis === 'v' ? 'M25 10v12' : 'M10 25h12';
    return `${open}${unit}<path d="${shaft}"/><path d="${stop}"/></svg>`;
  }
  if (token === 'auto') {
    const ext = axis === 'v' ? 38 : 45;
    const arc = axis === 'v' ? 'M22 8.5A15 15 0 0 1 22 23.5' : 'M8.5 22A15 15 0 0 0 23.5 22';
    return `${open}${unit}` +
      `<g transform="rotate(${-ext} ${pivot})"><path d="${arrow}"/></g>` +
      `<g transform="rotate(${ext} ${pivot})"><path d="${arrow}"/></g>` +
      `<path class="sweep" d="${arc}"/></svg>`;
  }

  const index = Number(token.slice(1));
  const total = axis === 'v' ? 5 : 6;
  const span = axis === 'v' ? 76 : 90;
  const angle = -(span / 2) + (span * (index - 1)) / (total - 1);
  return `${open}${unit}<g transform="rotate(${angle.toFixed(1)} ${pivot})"><path d="${arrow}"/></g></svg>`;
}

/** Eco as what it is: a power cap. Taller bars = harder limit = slower cooling. */
function ecoGlyph(token, label) {
  const level = token === 'off' ? 0 : Number(token.slice(-1));
  const bars = [0, 1, 2].map((i) =>
    `<rect x="${6 + i * 7}" y="${20 - i * 5}" width="4" height="${5 + i * 5}"
       class="ecobar${i < level ? ' on' : ''}"/>`).join('');
  return `<svg class="ic" viewBox="0 0 28 28" role="img" aria-label="${esc(label)}">
    ${bars}${level === 0 ? '<path class="vent" d="M5 23L24 5"/>' : ''}</svg>`;
}

const GLYPHS = {
  swing_vertical: (t, l) => vaneGlyph('v', t, l),
  swing_horizontal: (t, l) => vaneGlyph('h', t, l),
  eco: ecoGlyph,
};

/** Short caption under each glyph, and the accessible name / tooltip.
    The glyph carries the meaning; the caption keeps the precision — five blade angles
    25 degrees apart are not reliably tellable apart from the mark alone. */
const GLYPH_TITLES = {
  swing_vertical: { fixed: 'Fixed — louvre parked, no sweep', auto: 'Auto — sweeps the full range',
    p1: 'Angle 1 — highest', p2: 'Angle 2', p3: 'Angle 3 — straight out', p4: 'Angle 4', p5: 'Angle 5 — lowest' },
  swing_horizontal: { fixed: 'Fixed — vane parked, no sweep', auto: 'Auto — sweeps the full range',
    p1: 'Angle 1 — far left', p2: 'Angle 2', p3: 'Angle 3', p4: 'Angle 4', p5: 'Angle 5', p6: 'Angle 6 — far right' },
  eco: { off: 'Eco off — full power', level1: 'Eco 1 — light power cap',
    level2: 'Eco 2 — medium power cap', level3: 'Eco 3 — hardest cap, slowest cooling' },
};

function segmented(device, key) {
  const cap = capOf(device, key);
  if (!cap || cap.kind !== 'enum') return '';
  const disabled = !device.available || (cap.needs_power && !device.state.power);
  const glyph = GLYPHS[key];
  const titles = GLYPH_TITLES[key] || {};
  return `
  <div class="field">
    <span class="label">${esc(cap.label)}</span>
    <div class="segctl${glyph ? ' segctl--glyph' : ''}" role="group" aria-label="${esc(cap.label)}">
      ${cap.options.map((o) => {
        const title = titles[o.value] || o.label;
        const body = glyph
          ? `${glyph(o.value, title)}<span class="seglabel">${esc(o.label)}</span>`
          : esc(o.label);
        return `<button data-set="${key}" data-value="${esc(o.value)}"
                aria-pressed="${device.state[key] === o.value}"
                ${glyph ? `aria-label="${esc(title)}" data-tip="${esc(title)}"` : ''}
                ${disabled ? 'disabled' : ''}>${body}</button>`;
      }).join('')}
    </div>
  </div>`;
}

function toggles(device) {
  const caps = device.capabilities.filter((c) => c.kind === 'switch' && c.key !== 'power');
  const actions = device.capabilities.filter((c) => c.kind === 'action');
  if (!caps.length && !actions.length) return '';
  return `
  <div class="field">
    <span class="label">Options</span>
    <div class="togglegrid">
      ${caps.map((c) => {
        const on = !!device.state[c.key];
        const disabled = !device.available || (c.needs_power && !device.state.power);
        return `<div class="togrow" data-on="${on ? 1 : 0}" data-toggle="${c.key}"
                     role="switch" tabindex="${disabled ? -1 : 0}" aria-checked="${on}"
                     aria-disabled="${disabled}" aria-label="${esc(c.label)}">
          ${icon(`i-${c.icon || 'mode'}`)}
          <span class="tlabel">${esc(c.label)}</span>
          <!-- Presentational only. A real <label><input> here fires a second, synthetic click
               on the input that bubbles back to this row, sending every command twice — and
               the AC accepts one session at a time, so the duplicate just fails. -->
          <span class="toggle" aria-hidden="true"><span class="track"></span></span>
        </div>`;
      }).join('')}
      ${actions.map((c) => `
        <button class="togrow togrow--action" data-action="${esc(c.key)}" ${device.available ? '' : 'disabled'}"
                aria-label="${esc(c.label)}">
          ${icon(`i-${c.icon || 'mode'}`)}
          <span class="tlabel">${esc(c.label)}</span>
          <span class="meta">run</span>
        </button>`).join('')}
    </div>
  </div>`;
}

function statusBadge(device) {
  // eslint-disable-next-line no-unused-vars
  const map = {
    ok: ['dot--ok', 'online'],
    key_rotated: ['dot--warn', 'key rotated'],
    unconfigured: ['dot--warn', 'needs key'],
    unreachable: ['dot--err', 'unreachable'],
    error: ['dot--err', 'error'],
  };
  const [cls, text] = map[device.status] || ['', device.status];
  return `<span class="badge"><i class="dot ${cls}"></i>${esc(text)}</span>`;
}

function devicePanel(device) {
  const st = device.state;
  const t = device.transport || {};
  return `
  <div class="sheet" data-device="${esc(device.id)}">
    <div class="sheet-inner">
      <div class="sheet-header">
        <span>unit <b>${esc(t.type_id || device.kind)}</b>${
          t.device_id ? ` · <em>${esc(t.device_id)}</em>` : ''}</span>
        <span class="right sheet-actions">
          <span class="hide-sm">${esc(device.room || 'unassigned')}</span>
          <button class="iconbtn" data-refresh="${esc(device.id)}"
                  aria-label="Refresh now" data-tip="Refresh now">${icon('i-refresh')}</button>
          <button class="iconbtn" data-rename="${esc(device.id)}"
                  aria-label="Rename device" data-tip="Rename device">${icon('i-edit')}</button>
        </span>
      </div>

      ${device.simulated ? `<div class="alert alert--warn notice">
        <b>simulated</b><span>No localKey is set, so this is a stand-in — controls here do not
        reach the real unit. Run <code>./fetch-key.sh</code>, set <code>AC_LOCAL_KEY</code>, and
        restart to go live. See SETUP.md.</span></div>` : ''}

      ${device.status === 'key_rotated' ? `<div class="alert alert--warn notice">
        <b>key rotated</b><span>The AC is online and reachable — it just changed its
        encryption key (now version ${esc((device.transport || {}).localkey_version ?? '?')}), so
        the hub can no longer read or command it. Haier rotates this server-side; using the
        official app is enough to trigger it. Run <code>./fetch-key.sh ${esc((device.transport || {}).device_id || '')}</code>,
        put the new value in <code>AC_LOCAL_KEY</code> and restart. Nothing is wrong with the
        unit and no settings are lost.</span>
      </div>` : ''}

      ${(device.status !== 'ok' && device.status !== 'key_rotated') ? `<div class="alert alert--err notice">
        <b>${esc(device.status)}</b><span>${esc(device.status_detail || device.last_error || '')}</span>
      </div>` : ''}

      ${device.stale ? `<div class="alert notice">
        <b>not live</b><span>${device.last_seen
          ? `The readings below are the last successful ones, from ${new Date(device.last_seen * 1000).toLocaleString('en-GB', { hour12: false })}.`
          : 'There has been no successful read since the hub started, so the readings below are placeholders, not the unit\'s actual settings.'
        } Controls stay disabled until the hub can talk to the unit again.</span>
      </div>` : ''}

      ${st.error_code ? `<div class="alert alert--err notice">
        <b>fault</b><span>The unit is reporting error code ${esc(st.error_code)}.</span></div>` : ''}

      <div class="devgrid">
        <div class="climate">
          ${dial(device)}
          <button class="btn powerbtn ${st.power ? '' : 'btn--ghost'}" data-toggle="power"
                  ${device.available ? '' : 'disabled'} aria-pressed="${!!st.power}">
            ${icon('i-power', 'ic ic--lg')} ${st.power ? 'On' : 'Off'}</button>
        </div>
        <div class="controls">
          <div class="ctlpair">
            ${segmented(device, 'mode')}
            ${segmented(device, 'fan')}
          </div>
          <div class="ctlpair">
            ${segmented(device, 'swing_vertical')}
            ${segmented(device, 'swing_horizontal')}
          </div>
          ${device.capabilities.filter((c) => c.kind === 'enum'
              && !['mode', 'fan', 'swing_vertical', 'swing_horizontal'].includes(c.key))
              .map((c) => segmented(device, c.key)).join('')}
          ${toggles(device)}
        </div>
      </div>

      <div class="titleblock" style="margin-top:var(--s-4)">
        <div class="tb"><span class="tb-k">Indoor</span><span class="tb-v tb-v--accent">${num(st.indoor_temperature)}°C</span></div>
        <div class="tb" data-tip="Coil sensor on the outdoor unit — not outside air">
          <span class="tb-k">Outdoor unit</span><span class="tb-v">${num(st.outdoor_temperature)}°C</span></div>
        <div class="tb"><span class="tb-k">Setpoint</span><span class="tb-v">${num(st.target_temperature, 0)}°C</span></div>
        <div class="tb"><span class="tb-k">Mode</span><span class="tb-v">${esc(labelFor(device, 'mode', st.mode))}</span></div>
        <div class="tb"><span class="tb-k">Fan</span><span class="tb-v">${esc(labelFor(device, 'fan', st.fan))}</span></div>
        <div class="tb"><span class="tb-k">Eco</span><span class="tb-v">${esc(labelFor(device, 'eco', st.eco))}</span></div>
        <div class="tb"><span class="tb-k">Changed by</span><span class="tb-v">${esc(st.last_changed_by || '—')}</span></div>
        <div class="tb"><span class="tb-k">Link</span><span class="tb-v">${esc(t.host ? `${t.host}:${t.port}` : 'simulated')}</span></div>
      </div>
    </div>
  </div>`;
}

/* ---------- views ---------- */
function viewOverview() {
  const s = state.snapshot;
  const primary = s.devices[0];
  const online = s.devices.filter((d) => d.available).length;
  return `
  <div class="stack-lg">
    <div class="section-head"><span class="idx">A / OVERVIEW</span><h1 class="h2">Home</h1>
      <span class="spacer"></span><span class="meta">${esc(s.hub.now)}</span></div>

    <div class="tiles">
      <div class="panel corners"><i class="c"></i><div class="stat"><span class="label">Indoor</span>
        <span class="value">${num(primary?.state.indoor_temperature)}<sup style="font-size:1rem">°C</sup></span>
        <span class="meta">${esc(primary?.room || '—')}</span></div></div>
      <div class="panel corners"><i class="c"></i><div class="stat"><span class="label">Setpoint</span>
        <span class="value">${num(primary?.state.target_temperature, 0)}<sup style="font-size:1rem">°C</sup></span>
        <span class="meta">${primary?.state.power ? esc(labelFor(primary, 'mode', primary.state.mode)) : 'standby'}</span></div></div>
      <div class="panel corners"><i class="c"></i><div class="stat"><span class="label">Devices</span>
        <span class="value">${online}<span style="font-size:1rem;color:var(--dim)">/${s.devices.length}</span></span>
        <span class="meta">online</span></div></div>
      <div class="panel corners"><i class="c"></i><div class="stat"><span class="label">Uptime</span>
        <span class="value">${Math.floor(s.hub.uptime / 3600)}<span style="font-size:1rem;color:var(--dim)">h</span></span>
        <span class="meta">${esc(s.hub.timezone)}</span></div></div>
    </div>

    <div>
      <div class="section-head"><span class="idx">A.1</span><h2 class="h2">Quick scenes</h2></div>
      ${(s.scenes || []).length ? `<div class="cardgrid">
        ${s.scenes.map((sc) => `
          <button class="gate" data-scene="${esc(sc.id)}">
            <span class="gate-top"><span>${esc(sc.code || '')}</span><span class="gate-code">run</span></span>
            <span class="gate-name">${icon('i-scene', 'ic ic--lg')}${esc(sc.name)}</span>
          </button>`).join('')}
      </div>` : `<div class="panel"><div class="empty">${icon('i-scene', 'ic ic--xl')}
        <p>No scenes yet. Create one on the Scenes tab.</p></div></div>`}
    </div>

    ${primary ? `<div>
      <div class="section-head"><span class="idx">A.2</span><h2 class="h2">${esc(primary.name)}</h2>
        <span class="spacer"></span>${statusBadge(primary)}</div>
      ${devicePanel(primary)}
    </div>` : ''}
  </div>`;
}

function viewDevices() {
  const s = state.snapshot;
  if (!s.devices.length) return emptyView('B / DEVICES', 'Devices', 'No devices registered yet.');
  return `
  <div class="stack-lg">
    <div class="section-head"><span class="idx">B / DEVICES</span><h1 class="h2">Devices</h1>
      <span class="spacer"></span><span class="meta">${s.devices.length} registered</span></div>
    ${s.devices.map((d) => `
      <div>
        <div class="section-head" style="border:0;margin-bottom:var(--s-2)">
          <span class="idx">${esc(d.kind)}</span><h2 class="h2">${esc(d.name)}</h2>
          <span class="spacer"></span>${statusBadge(d)}
        </div>
        ${devicePanel(d)}
      </div>`).join('')}
  </div>`;
}

function summariseCommand(command) {
  return Object.entries(command || {})
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v === true ? 'on' : v === false ? 'off' : v}`)
    .join(' · ') || 'nothing';
}

function viewScenes() {
  const s = state.snapshot;
  return `
  <div class="stack-lg">
    <div class="section-head"><span class="idx">C / SCENES</span><h1 class="h2">Scenes</h1>
      <span class="spacer"></span>
      <button class="btn btn--sm" data-new-scene>${icon('i-plus')} New scene</button></div>
    ${(s.scenes || []).length ? `<div class="cardgrid">
      ${s.scenes.map((sc) => `
        <div class="panel corners"><i class="c"></i>
          <div class="rule">
            <div class="rulehead">${icon('i-scene', 'ic ic--lg')}<b>${esc(sc.name)}</b>
              <span class="meta">${esc(sc.code || '')}</span></div>
            <p>${esc(sc.description || '')}</p>
            ${(sc.actions || []).map((a) => `<div class="fieldline">
              <span class="fl-k">${esc((deviceById(a.device) || {}).name || a.device)}</span>
              <span class="fl-lead"></span>
              <span class="fl-v">${esc(summariseCommand(a.command))}</span></div>`).join('')}
            <div class="flex">
              <button class="btn btn--sm" data-scene="${esc(sc.id)}">Activate</button>
              <button class="btn btn--ghost btn--sm" data-edit-scene="${esc(sc.id)}">Edit</button>
              <button class="btn btn--danger btn--sm" data-del-scene="${esc(sc.id)}">Delete</button>
            </div>
          </div>
        </div>`).join('')}
    </div>` : `<div class="panel"><div class="empty">${icon('i-scene', 'ic ic--xl')}
      <p>No scenes yet. A scene sets several things at once — "Sleep" might drop the fan to
      low and the setpoint to 24.</p>
      <button class="btn btn--sm" data-new-scene>${icon('i-plus')} New scene</button></div></div>`}
    <div class="alert alert--info"><b>note</b><span>Scenes merge per device, so a scene
      touching one unit several times still sends a single write — the AC only accepts one
      session at a time.</span></div>
  </div>`;
}

function describeTrigger(t) {
  if (!t) return '';
  if (t.type === 'time') return `Every day at ${t.at}`;
  if (t.type === 'state') {
    const dev = deviceById(t.device);
    const attr = (TRIGGER_ATTRS.find((a) => a.value === t.attribute) || {}).label
      || String(t.attribute || '').replace(/_/g, ' ');
    const bound = (t.above !== undefined && t.above !== null) ? `above ${t.above}` : `below ${t.below}`;
    return `When ${dev ? dev.name : t.device} ${attr.toLowerCase()} goes ${bound}`;
  }
  return t.type;
}

function viewAutomations() {
  const s = state.snapshot;
  return `
  <div class="stack-lg">
    <div class="section-head"><span class="idx">D / AUTOMATIONS</span><h1 class="h2">Automations</h1>
      <span class="spacer"></span>
      <button class="btn btn--sm" data-new-auto>${icon('i-plus')} New automation</button></div>
    ${(s.automations || []).length ? `<div class="cardgrid">
      ${s.automations.map((a) => `
        <div class="panel corners"><i class="c"></i>
          <div class="rule">
            <div class="rulehead">${icon('i-auto', 'ic ic--lg')}<b>${esc(a.name)}</b>
              <span class="toggle" data-automation="${esc(a.id)}" role="switch"
                    tabindex="0" aria-checked="${!!a.enabled}" data-on="${a.enabled ? 1 : 0}"
                    aria-label="Enable ${esc(a.name)}"><span class="track"></span></span>
            </div>
            <p>${esc(a.description || '')}</p>
            <div class="fieldline"><span class="fl-k">Trigger</span><span class="fl-lead"></span>
              <span class="fl-v fl-v--accent">${esc(describeTrigger(a.trigger))}</span></div>
            ${(a.actions || []).map((x) => `<div class="fieldline">
              <span class="fl-k">${esc((deviceById(x.device) || {}).name || x.device)}</span>
              <span class="fl-lead"></span>
              <span class="fl-v">${esc(summariseCommand(x.command))}</span></div>`).join('')}
            <div class="flex">
              <button class="btn btn--ghost btn--sm" data-edit-auto="${esc(a.id)}">Edit</button>
              <button class="btn btn--danger btn--sm" data-del-auto="${esc(a.id)}">Delete</button>
            </div>
          </div>
        </div>`).join('')}
    </div>` : `<div class="panel"><div class="empty">${icon('i-auto', 'ic ic--xl')}
      <p>No automations yet. A rule runs on a time of day, or when a reading crosses a
      threshold.</p>
      <button class="btn btn--sm" data-new-auto>${icon('i-plus')} New automation</button></div></div>`}
    <div class="alert alert--info"><b>engine</b><span>Time rules fire on the minute in
      ${esc(s.hub.timezone)}. State rules are edge-triggered — they run on the crossing, not
      on every poll while the condition holds.</span></div>
  </div>`;
}

function viewActivity() {
  const log = state.snapshot.activity || [];
  return `
  <div class="stack-lg">
    <div class="section-head"><span class="idx">E / ACTIVITY</span><h1 class="h2">Activity</h1>
      <span class="spacer"></span>
      ${log.length ? `<span class="meta">${log.length} entries</span>
      <button class="btn btn--danger btn--sm" data-clear-activity>Clear</button>` : ''}</div>
    ${log.length ? `<div class="panel">
      ${log.map((e) => `<div class="logline k-${esc(e.kind)}">
        <i class="ldot"></i>
        <time>${new Date(e.ts * 1000).toLocaleTimeString('en-GB', { hour12: false })}</time>
        <span class="lmsg">${esc(e.message)}${e.detail ? ` — ${esc(e.detail)}` : ''}</span>
      </div>`).join('')}</div>`
      : `<div class="panel"><div class="empty">${icon('i-log', 'ic ic--xl')}
        <p>Nothing logged yet. Commands, scenes and automation runs land here.</p></div></div>`}
  </div>`;
}

function emptyView(idx, title, message) {
  return `<div class="stack-lg">
    <div class="section-head"><span class="idx">${esc(idx)}</span><h1 class="h2">${esc(title)}</h1></div>
    <div class="panel"><div class="empty">${icon('i-log', 'ic ic--xl')}<p>${esc(message)}</p></div></div>
  </div>`;
}

/* ============================================================
   Editor — scenes and automations
   The action builder is generated from each device's capability
   list, so it can only ever produce commands the backend accepts.
   ============================================================ */
function valueControl(device, cap, current) {
  const path = `${device.id}|${cap.key}`;
  if (cap.kind === 'switch' || cap.kind === 'action') {
    return `<div class="segctl" role="group">
      <button data-ev="${esc(path)}" data-v="true"  aria-pressed="${current === true}">On</button>
      <button data-ev="${esc(path)}" data-v="false" aria-pressed="${current === false}">Off</button>
    </div>`;
  }
  if (cap.kind === 'enum') {
    return `<div class="segctl" role="group">
      ${cap.options.map((o) => `<button data-ev="${esc(path)}" data-v="${esc(o.value)}"
        aria-pressed="${current === o.value}">${esc(o.label)}</button>`).join('')}
    </div>`;
  }
  if (cap.kind === 'range') {
    const v = current ?? cap.min;
    return `<div class="flex" style="gap:10px">
      <input class="input" type="number" style="max-width:110px" data-ev="${esc(path)}"
             min="${cap.min}" max="${cap.max}" step="${cap.step || 1}" value="${v}">
      <span class="meta">${cap.min}–${cap.max}${esc(cap.unit || '')}</span>
    </div>`;
  }
  return '';
}

function actionBuilder(draft) {
  const byDevice = {};
  (draft.actions || []).forEach((a) => { byDevice[a.device] = { ...(a.command || {}) }; });
  return devices().map((d) => {
    const cmd = byDevice[d.id] || {};
    const settable = d.capabilities.filter((c) => ['switch', 'enum', 'range', 'action'].includes(c.kind));
    return `
    <div class="edev">
      <div class="label" style="margin-bottom:8px">${esc(d.name)}</div>
      ${settable.map((c) => {
        const included = Object.prototype.hasOwnProperty.call(cmd, c.key);
        return `<div class="erow${included ? ' is-on' : ''}">
          <label class="check">
            <input type="checkbox" data-einc="${esc(d.id)}|${esc(c.key)}" ${included ? 'checked' : ''}>
            <span>${esc(c.label)}</span>
          </label>
          <div class="eval">${included ? valueControl(d, c, cmd[c.key]) : ''}</div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}

function triggerEditor(draft) {
  const t = draft.trigger || { type: 'time', at: '08:00' };
  return `
  <div class="field">
    <span class="label">Trigger</span>
    <div class="segctl" role="group" aria-label="Trigger type">
      <button data-ttype="time"  aria-pressed="${t.type === 'time'}">Time of day</button>
      <button data-ttype="state" aria-pressed="${t.type === 'state'}">Reading crosses</button>
    </div>
  </div>
  ${t.type === 'time' ? `
  <div class="field">
    <label class="label" for="t-at">At</label>
    <input class="input" id="t-at" type="time" value="${esc(t.at || '08:00')}" data-tfield="at">
  </div>` : `
  <div class="field">
    <label class="label" for="t-dev">Device</label>
    <select class="select" id="t-dev" data-tfield="device">
      ${devices().map((d) => `<option value="${esc(d.id)}" ${t.device === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
    </select>
  </div>
  <div class="field">
    <label class="label" for="t-attr">Reading</label>
    <select class="select" id="t-attr" data-tfield="attribute">
      ${TRIGGER_ATTRS.map((a) => `<option value="${esc(a.value)}" ${t.attribute === a.value ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
    </select>
  </div>
  <div class="field">
    <span class="label">Direction</span>
    <div class="segctl" role="group" aria-label="Direction">
      <button data-tdir="above" aria-pressed="${t.above !== undefined && t.above !== null}">Goes above</button>
      <button data-tdir="below" aria-pressed="${t.below !== undefined && t.below !== null}">Goes below</button>
    </div>
  </div>
  <div class="field">
    <label class="label" for="t-val">Threshold (°C)</label>
    <input class="input" id="t-val" type="number" step="0.5" data-tfield="threshold"
           value="${t.above ?? t.below ?? 30}">
  </div>`}`;
}

function renderDeviceEditor(ed) {
  const d = ed.draft;
  $('#modal-root').innerHTML = `
  <div class="modal-backdrop" data-backdrop>
    <div class="modal" role="dialog" aria-modal="true" aria-label="Rename device" style="max-width:440px">
      <div class="modal-head"><span>Rename device</span>
        <button class="btn btn--ghost btn--sm" data-close>Close</button></div>
      <div class="modal-body">
        <div class="stack">
          <div class="field">
            <label class="label" for="e-name">Name</label>
            <input class="input" id="e-name" value="${esc(d.name || '')}" data-efield="name"
                   placeholder="Living Room AC" maxlength="40">
          </div>
          <div class="field">
            <label class="label" for="e-room">Room</label>
            <input class="input" id="e-room" value="${esc(d.room || '')}" data-efield="room"
                   placeholder="Living Room" maxlength="40">
          </div>
          <p class="hint">Stored in the hub, not in the container config — a rename survives
            a redeploy. The device id (<code>${esc(d.id)}</code>) never changes, so scenes and
            automations keep working.</p>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn--ghost" data-close>Cancel</button>
        <button class="btn" data-save>Save</button>
      </div>
    </div>
  </div>`;
  const n = $('#e-name');
  if (n) { n.focus(); n.select(); }
}

function renderEditor() {
  const ed = state.editor;
  if (!ed) { const n = $('#modal-root'); if (n) n.innerHTML = ''; return; }
  if (ed.kind === 'device') { renderDeviceEditor(ed); return; }
  const isScene = ed.kind === 'scene';
  const d = ed.draft;
  $('#modal-root').innerHTML = `
  <div class="modal-backdrop" data-backdrop>
    <div class="modal" role="dialog" aria-modal="true" aria-label="${isScene ? 'Edit scene' : 'Edit automation'}">
      <div class="modal-head">
        <span>${ed.isNew ? 'New' : 'Edit'} ${isScene ? 'scene' : 'automation'}</span>
        <button class="btn btn--ghost btn--sm" data-close>Close</button>
      </div>
      <div class="modal-body">
        <div class="stack">
          <div class="field">
            <label class="label" for="e-name">Name</label>
            <input class="input" id="e-name" value="${esc(d.name || '')}" data-efield="name"
                   placeholder="${isScene ? 'Sleep' : 'Night step-up'}" maxlength="40">
          </div>
          ${isScene ? `<div class="field">
            <label class="label" for="e-code">Code</label>
            <input class="input" id="e-code" value="${esc(d.code || '')}" data-efield="code"
                   placeholder="SC-04" maxlength="8">
          </div>` : ''}
          <div class="field">
            <label class="label" for="e-desc">Description</label>
            <input class="input" id="e-desc" value="${esc(d.description || '')}" data-efield="description"
                   placeholder="What it does" maxlength="120">
          </div>
          ${isScene ? '' : triggerEditor(d)}
          <div class="field">
            <span class="label">Actions</span>
            <p class="meta" style="line-height:1.7">Tick what this ${isScene ? 'scene' : 'rule'}
              should set. Anything unticked is left alone.</p>
            ${actionBuilder(d)}
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn--ghost" data-close>Cancel</button>
        <button class="btn" data-save>Save</button>
      </div>
    </div>
  </div>`;
  const name = $('#e-name');
  if (name && ed.isNew) name.focus();
}

/** In-system replacement for window.confirm — a native dialog is an OS chrome box that
    ignores the design system entirely. Resolves true/false. */
function confirmDialog(title, message, { danger = true, confirmLabel = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="alertdialog" aria-modal="true" style="max-width:420px">
        <div class="modal-head"><span>${esc(title)}</span></div>
        <div class="modal-body"><p style="font-size:0.78rem;line-height:1.7;color:var(--ink-2)">${esc(message)}</p></div>
        <div class="modal-foot">
          <button class="btn btn--ghost" data-no>Cancel</button>
          <button class="btn ${danger ? 'btn--danger' : ''}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>`;
    const done = (value) => { root.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) done(true);
      else if (e.target.closest('[data-no]') || e.target.classList.contains('modal-backdrop')) done(false);
      e.stopPropagation();
    }, true);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    root.querySelector('[data-yes]').focus();
  });
}

function openEditor(kind, item) {
  const isNew = !item;
  const draft = item ? JSON.parse(JSON.stringify(item))
    : (kind === 'scene'
      ? { id: uid('scene'), name: '', code: '', description: '', actions: [] }
      : { id: uid('auto'), name: '', description: '', enabled: false,
          trigger: { type: 'time', at: '08:00' }, actions: [] });
  state.editor = { kind, draft, isNew };
  renderEditor();
}

function closeEditor() { state.editor = null; renderEditor(); }

/** Read the draft's action map, apply a change, and write it back as the actions array. */
function mutateAction(deviceId, key, mutate) {
  const d = state.editor.draft;
  const map = {};
  (d.actions || []).forEach((a) => { map[a.device] = { ...(a.command || {}) }; });
  map[deviceId] = map[deviceId] || {};
  mutate(map[deviceId]);
  if (!Object.keys(map[deviceId]).length) delete map[deviceId];
  d.actions = Object.entries(map).map(([device, command]) => ({ device, command }));
}

async function saveEditor() {
  const ed = state.editor;
  const d = ed.draft;
  if (!d.name || !d.name.trim()) { toast('warn', 'Name required'); return; }

  if (ed.kind === 'device') {
    try {
      const updated = await api(`/devices/${d.id}`, {
        method: 'PATCH', body: JSON.stringify({ name: d.name, room: d.room || '' }),
      });
      const i = state.snapshot.devices.findIndex((x) => x.id === updated.id);
      if (i >= 0) state.snapshot.devices[i] = updated;
      closeEditor(); render();
      toast('ok', 'Renamed', updated.name);
    } catch (err) { toast('err', 'Rename failed', err.message); }
    return;
  }

  if (!d.actions || !d.actions.length) { toast('warn', 'Add at least one action'); return; }

  const key = ed.kind === 'scene' ? 'scenes' : 'automations';
  const list = JSON.parse(JSON.stringify(state.snapshot[key] || []));
  const i = list.findIndex((x) => x.id === d.id);
  if (i >= 0) list[i] = d; else list.push(d);
  try {
    const saved = await api(`/${key}`, { method: 'PUT', body: JSON.stringify(list) });
    state.snapshot[key] = saved;
    closeEditor();
    render();
    toast('ok', ed.isNew ? 'Created' : 'Saved', d.name);
  } catch (err) { toast('err', 'Save failed', err.message); }
}

async function removeItem(kind, id) {
  const key = kind === 'scene' ? 'scenes' : 'automations';
  const list = (state.snapshot[key] || []).filter((x) => x.id !== id);
  try {
    state.snapshot[key] = await api(`/${key}`, { method: 'PUT', body: JSON.stringify(list) });
    render();
    toast('ok', 'Deleted');
  } catch (err) { toast('err', 'Delete failed', err.message); }
}

/* ---------- render ---------- */
function render() {
  if (!state.snapshot) {
    $('#view').innerHTML = `<div class="stack-lg">
      <div class="skel" style="height:30px;width:220px"></div>
      <div class="tiles">${'<div class="panel"><div class="skel" style="height:70px"></div></div>'.repeat(4)}</div>
      <div class="panel"><div class="skel" style="height:260px"></div></div></div>`;
    return;
  }
  const views = { overview: viewOverview, devices: viewDevices, scenes: viewScenes,
                  automations: viewAutomations, activity: viewActivity };
  $('#view').innerHTML = (views[state.view] || viewOverview)();
  renderNav();
  renderChrome();
  renderEditor();
}

/* ---------- interactions ---------- */
function deviceOf(node) {
  const host = node.closest('[data-device]');
  const id = host ? host.dataset.device : (devices()[0] || {}).id;
  return deviceById(id);
}

async function send(device, command) {
  if (!device) return;
  state.pending.add(device.id);
  try {
    const updated = await api(`/devices/${device.id}/command`, {
      method: 'POST', body: JSON.stringify(command),
    });
    const i = state.snapshot.devices.findIndex((x) => x.id === updated.id);
    if (i >= 0) state.snapshot.devices[i] = updated;
    render();
  } catch (err) {
    toast('err', 'Command failed', err.message);
    await refreshSnapshot();
  } finally { state.pending.delete(device.id); }
}

document.addEventListener('click', async (ev) => {
  const t = ev.target;

  // ----- editor -----
  if (state.editor) {
    if (t.closest('[data-close]') || (t.dataset && t.dataset.backdrop !== undefined && t === t.closest('[data-backdrop]'))) {
      closeEditor(); return;
    }
    if (t.closest('[data-save]')) { await saveEditor(); return; }

    const ttype = t.closest('[data-ttype]');
    if (ttype) {
      state.editor.draft.trigger = ttype.dataset.ttype === 'time'
        ? { type: 'time', at: '08:00' }
        : { type: 'state', device: (devices()[0] || {}).id, attribute: 'indoor_temperature', above: 30 };
      renderEditor(); return;
    }
    const tdir = t.closest('[data-tdir]');
    if (tdir) {
      const tr = state.editor.draft.trigger;
      const v = tr.above ?? tr.below ?? 30;
      delete tr.above; delete tr.below;
      tr[tdir.dataset.tdir] = v;
      renderEditor(); return;
    }
    const evb = t.closest('[data-ev]');
    if (evb && evb.tagName === 'BUTTON') {
      const [devId, key] = evb.dataset.ev.split('|');
      const raw = evb.dataset.v;
      const value = raw === 'true' ? true : raw === 'false' ? false : raw;
      mutateAction(devId, key, (cmd) => { cmd[key] = value; });
      renderEditor(); return;
    }
    if (t.closest('.modal')) return;   // clicks inside the dialog do nothing else
  }

  // ----- lists -----
  if (t.closest('[data-new-scene]')) { openEditor('scene', null); return; }
  if (t.closest('[data-new-auto]'))  { openEditor('automation', null); return; }

  const editScene = t.closest('[data-edit-scene]');
  if (editScene) {
    openEditor('scene', (state.snapshot.scenes || []).find((x) => x.id === editScene.dataset.editScene));
    return;
  }
  const editAuto = t.closest('[data-edit-auto]');
  if (editAuto) {
    openEditor('automation', (state.snapshot.automations || []).find((x) => x.id === editAuto.dataset.editAuto));
    return;
  }
  const delScene = t.closest('[data-del-scene]');
  if (delScene) {
    const sc = (state.snapshot.scenes || []).find((x) => x.id === delScene.dataset.delScene);
    if (await confirmDialog('Delete scene', `"${sc ? sc.name : ''}" will be removed. This cannot be undone.`,
        { confirmLabel: 'Delete' })) await removeItem('scene', delScene.dataset.delScene);
    return;
  }
  const delAuto = t.closest('[data-del-auto]');
  if (delAuto) {
    const a = (state.snapshot.automations || []).find((x) => x.id === delAuto.dataset.delAuto);
    if (await confirmDialog('Delete automation', `"${a ? a.name : ''}" will be removed. This cannot be undone.`,
        { confirmLabel: 'Delete' })) await removeItem('automation', delAuto.dataset.delAuto);
    return;
  }
  if (t.closest('[data-clear-activity]')) {
    if (!await confirmDialog('Clear activity',
        'Every logged command, scene run and automation run will be deleted.',
        { confirmLabel: 'Clear' })) return;
    try { await api('/activity', { method: 'DELETE' }); await refreshSnapshot(); toast('ok', 'Activity cleared'); }
    catch (err) { toast('err', 'Clear failed', err.message); }
    return;
  }

  const scene = t.closest('[data-scene]');
  if (scene) {
    try {
      const out = await api(`/scenes/${scene.dataset.scene}/activate`, { method: 'POST' });
      if (out.errors && out.errors.length) toast('warn', 'Scene partly applied', out.errors.join('; '));
      else toast('ok', 'Scene activated');
      await refreshSnapshot();
    } catch (err) { toast('err', 'Scene failed', err.message); }
    return;
  }

  const autoToggle = t.closest('[data-automation]');
  if (autoToggle) {
    try { await api(`/automations/${autoToggle.dataset.automation}/toggle`, { method: 'POST' }); await refreshSnapshot(); }
    catch (err) { toast('err', 'Toggle failed', err.message); }
    return;
  }

  // ----- device controls -----
  const rename = t.closest('[data-rename]');
  if (rename) {
    const dev = deviceById(rename.dataset.rename);
    state.editor = { kind: 'device', isNew: false,
                     draft: { id: dev.id, name: dev.name, room: dev.room } };
    renderEditor();
    return;
  }

  const refresh = t.closest('[data-refresh]');
  if (refresh) {
    try { await api(`/devices/${refresh.dataset.refresh}/refresh`, { method: 'POST' }); await refreshSnapshot(); toast('info', 'Refreshed'); }
    catch (err) { toast('err', 'Refresh failed', err.message); }
    return;
  }
  const step = t.closest('[data-step]');
  if (step) {
    const device = deviceOf(step);
    const cap = capOf(device, 'target_temperature');
    const next = Number(device.state.target_temperature) + Number(step.dataset.step);
    if (next >= cap.min && next <= cap.max) await send(device, { target_temperature: next });
    return;
  }
  const action = t.closest('[data-action]');
  if (action) {
    const device = deviceOf(action);
    const cap = capOf(device, action.dataset.action);
    if (await confirmDialog(cap ? cap.label : action.dataset.action,
        'This runs to completion on the unit and cannot be stopped once started.',
        { danger: false, confirmLabel: 'Start' })) {
      await send(device, { [action.dataset.action]: true });
    }
    return;
  }
  const setter = t.closest('[data-set][data-value]');
  if (setter && !setter.disabled) {
    await send(deviceOf(setter), { [setter.dataset.set]: setter.dataset.value });
    return;
  }
  const toggle = t.closest('[data-toggle]');
  if (toggle && toggle.getAttribute('aria-disabled') !== 'true') {
    const device = deviceOf(toggle);
    const key = toggle.dataset.toggle;
    await send(device, { [key]: !device.state[key] });
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.editor) { closeEditor(); return; }
  if (ev.key !== ' ' && ev.key !== 'Enter') return;
  const row = ev.target.closest('.togrow[role="switch"], [data-automation][role="switch"]');
  if (row && row.getAttribute('aria-disabled') !== 'true') { ev.preventDefault(); row.click(); }
});

document.addEventListener('change', async (ev) => {
  const inc = ev.target.closest('[data-einc]');
  if (inc) {
    const [devId, key] = inc.dataset.einc.split('|');
    const dev = deviceById(devId);
    const cap = capOf(dev, key);
    mutateAction(devId, key, (cmd) => {
      if (inc.checked) {
        cmd[key] = cap.kind === 'range' ? (dev.state[key] ?? cap.min)
          : cap.kind === 'enum' ? (cap.options[0] || {}).value
          : true;
      } else { delete cmd[key]; }
    });
    renderEditor(); return;
  }
  const efield = ev.target.closest('[data-efield]');
  if (efield) { state.editor.draft[efield.dataset.efield] = efield.value; return; }
  const tfield = ev.target.closest('[data-tfield]');
  if (tfield) {
    const tr = state.editor.draft.trigger;
    const f = tfield.dataset.tfield;
    if (f === 'threshold') {
      const v = Number(tfield.value);
      if (tr.above !== undefined && tr.above !== null) tr.above = v; else tr.below = v;
    } else { tr[f] = tfield.value; }
    return;
  }
  const evNum = ev.target.closest('input[data-ev]');
  if (evNum) {
    const [devId, key] = evNum.dataset.ev.split('|');
    const cap = capOf(deviceById(devId), key);
    // HTML min/max do not stop a typed value, and an out-of-range setpoint saved into a
    // scene would only fail later, when the scene is run. Clamp it at entry instead.
    let v = Number(evNum.value);
    if (cap && cap.min !== null && cap.max !== null) {
      v = Math.min(cap.max, Math.max(cap.min, Number.isFinite(v) ? v : cap.min));
      if (String(v) !== evNum.value) evNum.value = v;
    }
    mutateAction(devId, key, (cmd) => { cmd[key] = v; });
    return;
  }
  const range = ev.target.closest('input[type="range"][data-set]');
  if (range) await send(deviceOf(range), { [range.dataset.set]: Number(range.value) });
});

// Commit the slider on release, not on every pixel — each input is a real radio session.
document.addEventListener('input', (ev) => {
  const range = ev.target.closest('input[type="range"][data-set]');
  if (!range) return;
  const readout = range.closest('.dialwrap')?.querySelector('.d-set');
  if (readout) readout.innerHTML = `${range.value}<sup>°C</sup>`;
});

/* ---------- data ---------- */
async function refreshSnapshot() {
  try { state.snapshot = await api('/state'); render(); }
  catch (err) { toast('err', 'Cannot reach hub', err.message); }
}

function connectStream() {
  const source = new EventSource('/api/events');
  source.onopen = () => { state.connected = true; renderChrome(); };
  source.onerror = () => { state.connected = false; renderChrome(); };
  source.onmessage = (ev) => {
    let message;
    try { message = JSON.parse(ev.data); } catch { return; }
    // Never re-render underneath an open dialog — it would discard what is being typed.
    if (state.editor) return;
    if (message.event === 'snapshot') { state.snapshot = message.data; render(); return; }
    if (!state.snapshot) return;
    if (message.event === 'device') {
      const i = state.snapshot.devices.findIndex((d) => d.id === message.data.id);
      if (i >= 0) state.snapshot.devices[i] = message.data;
      render();
    } else if (message.event === 'activity') {
      state.snapshot.activity = [...message.data, ...(state.snapshot.activity || [])].slice(0, 60);
      if (state.view === 'activity' || state.view === 'overview') render();
    } else if (message.event === 'scenes' || message.event === 'automations') {
      state.snapshot[message.event] = message.data;
      render();
    }
  };
}

/* ---------- boot ---------- */
function route() {
  const id = (location.hash || '#overview').slice(1);
  state.view = VIEWS.some((v) => v.id === id) ? id : 'overview';
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('hashchange', route);
clock();
setInterval(clock, 1000);
render();
route();
refreshSnapshot().then(connectStream);
