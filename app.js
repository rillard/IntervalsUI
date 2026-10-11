const API_BASE = 'https://intervals.icu/api/v1';
const STORAGE_KEY = 'stride.intervals.credentials.v1';
const LOCAL_WORKOUTS_KEY = 'stride.local-workouts.v1';
const ACTIVITY_STREAM_CACHE_PREFIX = 'stride.activity-streams.v1:';
const ACTIVITY_STREAM_CACHE_TTL = 24 * 60 * 60 * 1000;
const ACTIVITY_STREAM_CACHE_LIMIT = 8;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthTitle = document.querySelector('#month-title');
const weeksRoot = document.querySelector('#calendar-weeks');
const syncStatus = document.querySelector('#sync-status');
const syncText = document.querySelector('#sync-text');
const connectDialog = document.querySelector('#connect-dialog');
const connectForm = document.querySelector('#connect-form');
const formMessage = document.querySelector('#form-message');
const submitButton = document.querySelector('#dialog-submit');
const submitLabel = document.querySelector('#submit-label');
const workoutDialog = document.querySelector('#workout-dialog');
const workoutDialogContent = document.querySelector('#workout-dialog-content');

const now = new Date();
let visibleMonth = new Date(now.getFullYear(), now.getMonth(), 1);
let events = [];
let wellnessByDate = new Map();
let localWorkouts = readLocalWorkouts();
let viewMode = 'month';
let apiCredentials = readCredentials();
let requestSequence = 0;
let builderBlocks = [];
let builderBlockSequence = 0;
let editingEvent = null;
let editingActivity = null;
let deletingActivity = null;
let activeChartAdjustment = null;
let activeChartBlockDrag = null;
let calendarDraggedEventId = null;
let suppressCalendarClick = false;
let calendarClipboard = null;

const CHART_GEOMETRY = { left: 42, right: 1615, top: 40, bottom: 184, width: 1573, height: 144 };
const POWER_ZONES = [
  { label: 'Z1', max: 55, color: '#808080' },
  { label: 'Z2', max: 75, color: '#438dcc' },
  { label: 'Z3', max: 90, color: '#4eb66a' },
  { label: 'Z4', max: 105, color: '#edc333' },
  { label: 'Z5', max: 120, color: '#e96e3f' },
  { label: 'Z6', max: 200, color: '#c92f28' }
];

function powerZone(power) {
  return POWER_ZONES.find(zone => power <= zone.max) || POWER_ZONES[POWER_ZONES.length - 1];
}

const ZWIFT_ZONE_COLORS = ['#a7a7a7', '#36a9e1', '#35b86b', '#f4d330', '#f18b2b', '#ef3e36', '#a746bd'];
const ACTIVITY_POWER_ZONE_COLORS = [...ZWIFT_ZONE_COLORS.slice(0, 6), '#8f1f1f'];

function decodeSkylineChart(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const fields = new Map();
    let cursor = 0;
    const readVarint = () => {
      let value = 0;
      let shift = 0;
      while (cursor < bytes.length && shift < 35) {
        const byte = bytes[cursor++];
        value |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) return value >>> 0;
        shift += 7;
      }
      throw new Error('Invalid skyline varint');
    };
    while (cursor < bytes.length) {
      const tag = readVarint();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (wire === 0) {
        const value = readVarint();
        if (field === 1 || field === 5) fields.set(field, value);
      } else if (wire === 2) {
        const length = readVarint();
        const end = cursor + length;
        if (end > bytes.length) throw new Error('Invalid skyline length');
        if ([2, 3, 4].includes(field)) {
          const values = [];
          while (cursor < end) values.push(readVarint());
          if (cursor !== end) throw new Error('Invalid packed skyline field');
          fields.set(field, values);
        } else cursor = end;
      } else if (wire === 1) cursor += 8;
      else if (wire === 5) cursor += 4;
      else throw new Error('Unsupported skyline wire type');
      if (cursor > bytes.length) throw new Error('Invalid skyline data');
    }
    const widths = fields.get(2);
    const intensities = fields.get(3);
    const zones = fields.get(4);
    if (!widths?.length || !intensities?.length || !zones?.length) return null;
    const count = Math.min(widths.length, intensities.length, zones.length);
    return { type: fields.get(5), widths: widths.slice(0, count), intensities: intensities.slice(0, count), zones: zones.slice(0, count) };
  } catch {
    return null;
  }
}

function skylineMarkup(event, size = 'small') {
  const chart = decodeSkylineChart(event.skyline_chart_bytes);
  if (!chart) return '';
  const totalWidth = chart.widths.reduce((sum, width) => sum + width, 0) || chart.widths.length;
  let x = 0;
  const bars = chart.widths.map((width, index) => {
    const segmentWidth = (width / totalWidth) * 100;
    const height = Math.max(2, Math.min(100, chart.intensities[index]));
    const zone = Math.max(1, Math.min(7, chart.zones[index]));
    const rect = `<rect x="${x.toFixed(3)}" y="${(100 - height).toFixed(3)}" width="${segmentWidth.toFixed(3)}" height="${height.toFixed(3)}" fill="${ZWIFT_ZONE_COLORS[zone - 1]}"/>`;
    x += segmentWidth;
    return rect;
  }).join('');
  return `<svg class="activity-skyline activity-skyline-${size}" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Activity intensity skyline colored by power zone">${bars}</svg>`;
}

function streamMap(payload) {
  const streams = Array.isArray(payload) ? payload : Array.isArray(payload?.streams) ? payload.streams : [];
  return Object.fromEntries(streams.filter(stream => stream?.type && Array.isArray(stream.data)).map(stream => [stream.type, stream.data]));
}

function readActivityStreamCache(activityId) {
  const key = `${ACTIVITY_STREAM_CACHE_PREFIX}${activityId}`;
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return null;
    const entry = JSON.parse(saved);
    if (!entry?.savedAt || Date.now() - entry.savedAt > ACTIVITY_STREAM_CACHE_TTL || !entry.streams) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.streams;
  } catch {
    return null;
  }
}

function writeActivityStreamCache(activityId, streams) {
  const key = `${ACTIVITY_STREAM_CACHE_PREFIX}${activityId}`;
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), streams }));
    const entries = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const storedKey = localStorage.key(index);
      if (!storedKey?.startsWith(ACTIVITY_STREAM_CACHE_PREFIX)) continue;
      try {
        entries.push({ key: storedKey, savedAt: JSON.parse(localStorage.getItem(storedKey) || '{}').savedAt || 0 });
      } catch {
        localStorage.removeItem(storedKey);
      }
    }
    entries.sort((a, b) => b.savedAt - a.savedAt);
    entries.slice(ACTIVITY_STREAM_CACHE_LIMIT).forEach(entry => localStorage.removeItem(entry.key));
  } catch {
    // Storage may be unavailable or full; the stream view still works for this opening.
  }
}

function activityAnalysisMarkup(streams, activity) {
  const time = streams.time || [];
  const watts = streams.watts || [];
  const heartrate = streams.heartrate || [];
  const cadence = streams.cadence || [];
  const length = Math.min(time.length, watts.length, heartrate.length || Infinity);
  if (!length) return '<p class="activity-analysis-message">Power and heart-rate streams are not available for this activity.</p>';

  const width = 920, traceHeight = 230, histogramHeight = 180, gap = 24, readoutHeight = 32;
  const usableSamples = Math.min(length, 1800);
  const samples = [];
  for (let i = 0; i < usableSamples; i += 1) {
    const start = Math.floor(i * length / usableSamples);
    const end = Math.max(start + 1, Math.floor((i + 1) * length / usableSamples));
    const average = values => {
      const valid = values.slice(start, end).map(Number).filter(Number.isFinite);
      return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
    };
    samples.push({ t: Number(time[Math.min(end - 1, time.length - 1)]) || i, watts: average(watts), hr: average(heartrate), cadence: average(cadence) });
  }
  const maxWatts = Math.max(100, ...watts.map(Number).filter(Number.isFinite));
  const minHr = 60;
  const maxHr = Math.max(180, ...heartrate.map(Number).filter(Number.isFinite));
  const startTime = samples[0].t;
  const endTime = samples[samples.length - 1].t || startTime + 1;
  const xFor = t => 46 + ((t - startTime) / Math.max(1, endTime - startTime)) * (width - 62);
  const yForPower = value => traceHeight - 22 - (Math.max(0, value) / maxWatts) * (traceHeight - 45);
  const yForHr = value => 18 + ((maxHr - value) / (maxHr - minHr)) * (traceHeight - 42);
  const zoneBounds = Array.isArray(activity.icu_power_zones) ? activity.icu_power_zones : [55,75,90,105,120,150,999];
  const ftp = Number(activity.icu_ftp) || 250;
  const zoneFor = value => {
    const percent = value / ftp * 100;
    return Math.min(6, zoneBounds.findIndex(bound => percent <= bound) < 0 ? 6 : zoneBounds.findIndex(bound => percent <= bound));
  };
  const barWidth = (width - 62) / samples.length;
  const powerBars = samples.map((sample, i) => sample.watts == null ? '' : `<rect x="${(46 + i * barWidth).toFixed(2)}" y="${yForPower(sample.watts).toFixed(2)}" width="${Math.max(.8, barWidth).toFixed(2)}" height="${(traceHeight - 22 - yForPower(sample.watts)).toFixed(2)}" fill="${ACTIVITY_POWER_ZONE_COLORS[zoneFor(sample.watts)]}"/>`).join('');
  const hrPoints = samples.filter(sample => sample.hr != null).map(sample => `${xFor(sample.t).toFixed(2)},${yForHr(sample.hr).toFixed(2)}`).join(' ');
  const cadencePoints = samples.filter(sample => sample.cadence != null).map(sample => `${xFor(sample.t).toFixed(2)},${(traceHeight - 22 - Math.min(100, sample.cadence) / 100 * 60).toFixed(2)}`).join(' ');

  const powerBins = Array(24).fill(0), hrBins = Array(28).fill(0);
  watts.forEach(value => { const n = Number(value); if (Number.isFinite(n) && n >= 0) powerBins[Math.min(powerBins.length - 1, Math.floor(n / 25))] += 1; });
  heartrate.forEach(value => { const n = Number(value); if (Number.isFinite(n)) hrBins[Math.max(0, Math.min(hrBins.length - 1, Math.floor((n - minHr) / 5)))] += 1; });
  const hist = (bins, left, top, chartWidth, chartHeight, colors) => {
    const maxBin = Math.max(1, ...bins);
    const bw = chartWidth / bins.length;
    return bins.map((n, i) => {
      const h = n / maxBin * (chartHeight - 22);
      return `<rect x="${(left + i * bw).toFixed(2)}" y="${(top + chartHeight - h).toFixed(2)}" width="${Math.max(1, bw - 1).toFixed(2)}" height="${h.toFixed(2)}" fill="${colors(i)}"/>`;
    }).join('');
  };
  const powerHistLeft = 0, hrHistLeft = 480, histTop = traceHeight + gap + readoutHeight;
  const svg = `<svg class="activity-analysis-chart" viewBox="0 0 ${width} ${histTop + histogramHeight}" role="img" aria-label="Activity power, cadence, heart rate and zone distributions">
    <rect x="0" y="0" width="${width}" height="${traceHeight}" rx="8" fill="#292929"/>${powerBars}
    ${hrPoints ? `<polyline points="${hrPoints}" fill="none" stroke="#f04438" stroke-width="2" vector-effect="non-scaling-stroke"/>` : ''}
    ${cadencePoints ? `<polyline points="${cadencePoints}" fill="none" stroke="#f2f2f2" stroke-width="1" opacity=".8" vector-effect="non-scaling-stroke"/>` : ''}
    <line class="activity-tracer" x1="46" x2="46" y1="0" y2="208" visibility="hidden"/>
    <g class="activity-chart-legend"><circle cx="16" cy="214" r="5" fill="#ef6543"/><text x="27" y="218">Power</text><circle cx="112" cy="214" r="5" fill="#f2f2f2"/><text x="123" y="218">Cadence</text><circle cx="222" cy="214" r="5" fill="#f04438"/><text x="233" y="218">Heart rate</text></g>
    <rect x="0" y="${traceHeight + gap}" width="${width}" height="${readoutHeight}" fill="#f2f4f5"/>
    <text class="activity-readout-label" x="16" y="${traceHeight + gap + 21}">Power <tspan id="tracer-power-value">—</tspan></text>
    <text class="activity-readout-label" x="190" y="${traceHeight + gap + 21}">Heart rate <tspan id="tracer-hr-value">—</tspan></text>
    <text class="activity-readout-hint" x="904" y="${traceHeight + gap + 21}" text-anchor="end">Move over profile to inspect</text>
    <rect x="0" y="${histTop}" width="444" height="${histogramHeight}" rx="8" fill="#292929"/><rect x="476" y="${histTop}" width="444" height="${histogramHeight}" rx="8" fill="#292929"/>
    <text class="activity-chart-heading" x="222" y="${histTop + 17}" text-anchor="middle">Power distribution</text><text class="activity-chart-heading" x="698" y="${histTop + 17}" text-anchor="middle">Heart rate distribution</text>
    ${hist(powerBins, powerHistLeft + 16, histTop + 28, 412, histogramHeight - 38, i => ACTIVITY_POWER_ZONE_COLORS[zoneFor(i * 25 + 12)])}
    ${hist(hrBins, hrHistLeft + 16, histTop + 28, 412, histogramHeight - 38, i => i < 8 ? '#3988f5' : i < 12 ? '#58bd5d' : i < 17 ? '#f2d23c' : i < 22 ? '#f58a29' : '#ed4336')}
    <text class="activity-chart-axis" x="16" y="${histTop + histogramHeight - 5}">0 W</text><text class="activity-chart-axis" x="425" y="${histTop + histogramHeight - 5}" text-anchor="end">600 W</text>
    <text class="activity-chart-axis" x="492" y="${histTop + histogramHeight - 5}">60 bpm</text><text class="activity-chart-axis" x="904" y="${histTop + histogramHeight - 5}" text-anchor="end">200 bpm</text>
  </svg>`;
  return `<section class="activity-analysis"><h3>Activity profile</h3>${svg}</section>`;
}

function attachActivityTracer(streams) {
  const svg = workoutDialogContent.querySelector('.activity-analysis-chart');
  if (!svg) return;
  const line = svg.querySelector('.activity-tracer');
  const powerOutput = svg.querySelector('#tracer-power-value');
  const hrOutput = svg.querySelector('#tracer-hr-value');
  const time = streams.time || [];
  const watts = streams.watts || [];
  const heartrate = streams.heartrate || [];
  const sampleCount = Math.min(time.length, watts.length);
  if (!sampleCount) return;
  svg.addEventListener('pointermove', event => {
    const bounds = svg.getBoundingClientRect();
    const viewX = (event.clientX - bounds.left) / bounds.width * 920;
    const viewY = (event.clientY - bounds.top) / bounds.height * Number(svg.viewBox.baseVal.height);
    if (viewY > 230) return;
    const progress = Math.max(0, Math.min(1, (viewX - 46) / (920 - 62)));
    const x = 46 + progress * (920 - 62);
    const index = Math.round(progress * (sampleCount - 1));
    line.setAttribute('x1', x.toFixed(2));
    line.setAttribute('x2', x.toFixed(2));
    line.setAttribute('visibility', 'visible');
    const power = Number(watts[index]);
    const hr = Number(heartrate[Math.min(index, heartrate.length - 1)]);
    powerOutput.textContent = Number.isFinite(power) ? `${Math.round(power)} W` : '—';
    hrOutput.textContent = Number.isFinite(hr) ? `${Math.round(hr)} bpm` : '—';
  });
  svg.addEventListener('pointerleave', () => {
    line.setAttribute('visibility', 'hidden');
    powerOutput.textContent = '—';
    hrOutput.textContent = '—';
  });
}

const BLOCK_PRESETS = [
  { key: 'warmup', label: 'Warmup', description: '20 min · 45% FTP', steps: [{ seconds: 1200, power: 45, intensity: 'warmup' }] },
  { key: 'active', label: 'Active', description: '10 min · 75% FTP', steps: [{ seconds: 600, power: 75, intensity: 'active' }] },
  { key: 'recovery', label: 'Recovery', description: '5 min · 55% FTP', steps: [{ seconds: 300, power: 55, intensity: 'recovery' }] },
  { key: 'cooldown', label: 'Cooldown', description: '10 min · 45% FTP', steps: [{ seconds: 600, power: 45, intensity: 'cooldown' }] },
  { key: 'two-step', label: '2 Step Repeat', description: '4 × (6 min 90% + 3 min 55%)', reps: 4, steps: [{ seconds: 360, power: 90, intensity: 'active' }, { seconds: 180, power: 55, intensity: 'recovery' }] },
  { key: 'three-step', label: '3 Step Repeat', description: '3 × (3 min 80% + 1 min 95% + 1 min 55%)', reps: 3, steps: [{ seconds: 180, power: 80, intensity: 'active' }, { seconds: 60, power: 95, intensity: 'active' }, { seconds: 60, power: 55, intensity: 'recovery' }] },
  { key: 'ramp-up', label: 'Ramp up', description: '2 min each · 60 → 90% FTP', steps: [60, 70, 80, 90].map(power => ({ seconds: 120, power, intensity: 'active' })) },
  { key: 'ramp-down', label: 'Ramp down', description: '2 min each · 90 → 60% FTP', steps: [90, 80, 70, 60].map(power => ({ seconds: 120, power, intensity: 'active' })) }
];

function readCredentials() {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function readLocalWorkouts() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_WORKOUTS_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveCredentials(credentials) {
  apiCredentials = credentials;
  try {
    if (credentials) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // The app still works for this page view if browser storage is disabled.
  }
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function mondayOf(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - weekday);
  return result;
}

function getVisibleWeeks() {
  const first = mondayOf(visibleMonth);
  const lastOfMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0);
  const last = mondayOf(lastOfMonth);
  const weeks = [];
  for (let cursor = new Date(first); cursor <= last; cursor.setDate(cursor.getDate() + 7)) {
    weeks.push(Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + offset);
      return date;
    }));
  }
  return weeks;
}

function formatMonth(date) {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '';
  if (Number(seconds) < 60) return `${Math.round(Number(seconds))}s`;
  const minutes = Math.round(Number(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours}h ${rest}m`;
  if (hours) return `${hours}h`;
  return `${rest}m`;
}

function formatCompactDuration(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '0:00';
  const minutes = Math.round(Number(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const rest = String(minutes % 60).padStart(2, '0');
  return hours ? `${hours}:${rest}` : `${minutes}m`;
}

function formatDistance(meters) {
  if (!Number.isFinite(Number(meters)) || Number(meters) <= 0) return '';
  const km = Number(meters) / 1000;
  const decimals = km < 10 ? 1 : 0;
  return `${km.toFixed(decimals)} km`;
}

function eventDuration(event) {
  return [event.moving_time, event.workout_doc?.duration, event.duration].find(value => Number(value) > 0) ?? 0;
}

function eventDistance(event) {
  return [event.distance, event.workout_doc?.distance].find(value => Number(value) > 0) ?? 0;
}

function sportClass(type = '') {
  const normalized = String(type).toLowerCase();
  if (normalized.includes('ride') || normalized.includes('cycl')) return 'ride';
  if (normalized.includes('run')) return 'run';
  if (normalized.includes('strength') || normalized.includes('weight') || normalized.includes('gym')) return 'strength';
  if (normalized.includes('swim')) return 'swim';
  return 'other';
}

function isStrengthType(type = '') {
  return ['strength', 'weighttraining', 'weight training'].includes(String(type).toLowerCase());
}

function displaySportType(type = '') {
  return isStrengthType(type) ? 'Strength' : type;
}

function sportIconMarkup(type = '') {
  const kind = sportClass(type);
  const imageIcons = {
    ride: 'bike.png',
    run: 'runner.png',
    strength: 'dumbbell.png'
  };
  if (imageIcons[kind]) return `<img src="assets/session-icons/${imageIcons[kind]}" alt="" draggable="false">`;
  const icons = {
    swim: '<path d="M2 8c1.3-1 2.7-1 4 0s2.7 1 4 0 2.7-1 4 0M2 11c1.3-1 2.7-1 4 0s2.7 1 4 0 2.7-1 4 0"/><circle cx="10.8" cy="3.5" r="1.1"/>',
    other: '<circle cx="7" cy="7" r="4.3"/><path d="M7 4.8v4.4M4.8 7h4.4"/>'
  }[kind];
  return `<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">${icons}</svg>`;
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function sampleEvents() {
  const offsets = [-8, -6, -4, -2, 0, 1, 3, 5, 7, 9, 11, 13];
  const samples = [
    ['Ride', 'Endurance ride', '1h 30m endurance · steady Z2', 5400, 41000, 68],
    ['Run', 'Easy aerobic run', 'Relaxed pace, keep it conversational', 3000, 7200, 42],
    ['Ride', 'Sweet spot intervals', '3 × 12m at sweet spot · 5m recovery', 5400, 36000, 96],
    ['Strength', 'Strength & mobility', 'Hips, glutes and trunk stability', 2700, 0, 24],
    ['Run', 'Tempo progression', '10m easy · 20m comfortably hard · cool down', 3600, 9000, 62],
    ['Ride', 'Recovery spin', 'Light legs · stay below endurance pace', 2700, 22000, 28],
    ['Run', 'Hill repetitions', '6 × 2m uphill · jog back recovery', 3300, 6800, 58],
    ['Ride', 'Long aerobic ride', 'Build gradually · fuel every 30 minutes', 9000, 70000, 112],
    ['Strength', 'Strength session', 'Full body · moderate effort', 3000, 0, 30],
    ['Run', 'Easy run', 'Keep effort low and even', 3300, 8000, 45],
    ['Ride', 'Threshold intervals', '4 × 8m threshold · 4m easy', 4800, 33000, 91],
    ['Run', 'Long run', 'Easy effort · finish feeling strong', 5400, 12500, 76]
  ];
  return offsets.map((offset, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0);
    const [type, name, description, moving_time, distance, icu_training_load] = samples[index];
    return {
      id: `sample-${index}`,
      category: 'WORKOUT',
      start_date_local: `${dateKey(date)}T00:00:00`,
      type, name, description, moving_time, distance, icu_training_load,
      _sample: true
    };
  });
}

function getEventsByDate() {
  const grouped = new Map();
  for (const event of events) {
    if (event._source === 'planned' && event.category && event.category !== 'WORKOUT') continue;
    const date = parseLocalDate(event.start_date_local);
    if (!date) continue;
    const key = dateKey(date);
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));
  }
  return grouped;
}

function wellnessMetrics(record) {
  if (!record) return [];
  const metrics = [];
  const sleepSeconds = Number(record.sleepSecs);
  const hrv = Number(record.hrv);
  const restingHR = Number(record.restingHR);
  if (Number.isFinite(sleepSeconds) && sleepSeconds > 0) {
    const hours = sleepSeconds / 3600;
    metrics.push(['Sleep', `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`]);
  }
  if (Number.isFinite(hrv) && hrv > 0) metrics.push(['HRV', `${Math.round(hrv)} ms`]);
  if (Number.isFinite(restingHR) && restingHR > 0) metrics.push(['Rest HR', `${Math.round(restingHR)} bpm`]);
  return metrics;
}

function wellnessMarkup(record, detailed = false) {
  const metrics = wellnessMetrics(record);
  if (!metrics.length) return '';
  if (detailed) {
    return `<section class="wellness-detail" aria-label="Daily health metrics"><h3>Daily health</h3><div class="wellness-detail-metrics">${metrics.map(([label, value]) => `<span>${label}<strong>${escapeHTML(value)}</strong></span>`).join('')}</div></section>`;
  }
  return `<div class="wellness-summary" aria-label="Daily health: ${escapeHTML(metrics.map(([label, value]) => `${label} ${value}`).join(', '))}">${metrics.map(([label, value]) => `<span><b>${label}</b> ${escapeHTML(value)}</span>`).join('')}</div>`;
}

function summaryMarkup(weekEvents) {
  const totalSeconds = weekEvents.reduce((sum, event) => sum + Number(eventDuration(event) || 0), 0);
  const totalLoad = weekEvents.reduce((sum, event) => sum + Number(event.icu_training_load || 0), 0);
  const ctlEvent = [...weekEvents].reverse().find(event => Number.isFinite(Number(event.icu_ctl)) && event.icu_ctl !== null);
  const atlEvent = [...weekEvents].reverse().find(event => Number.isFinite(Number(event.icu_atl)) && event.icu_atl !== null);
  const ctl = ctlEvent ? Number(ctlEvent.icu_ctl) : null;
  const atl = atlEvent ? Number(atlEvent.icu_atl) : null;
  const form = ctl !== null && atl !== null ? ctl - atl : null;
  const workouts = weekEvents.length;
  const display = value => value === null ? '—' : Math.round(value);
  return `<aside class="summary-card" aria-label="Weekly training summary">
    <div class="summary-stats">
      <div class="summary-stat"><span>Fitness</span><strong>${display(ctl)}<small>CTL</small></strong></div>
      <div class="summary-stat"><span>Fatigue</span><strong>${display(atl)}<small>ATL</small></strong></div>
      <div class="summary-stat"><span>Form</span><strong>${display(form)}<small>TSB</small></strong></div>
    </div>
    <div class="summary-metric"><span>Total duration</span><strong>${formatCompactDuration(totalSeconds)}</strong></div>
    <div class="summary-meter"><span style="width:${Math.min(100, (totalSeconds / 21600) * 100)}%"></span></div>
    <div class="summary-metric"><span>Total TSS</span><strong>${Math.round(totalLoad)}</strong></div>
    <div class="summary-meter load"><span style="width:${Math.min(100, (totalLoad / 700) * 100)}%"></span></div>
    <div class="summary-empty">${workouts ? `${workouts} calendar ${workouts === 1 ? 'entry' : 'entries'} this week` : 'No workouts this week'}</div>
  </aside>`;
}

function workoutMarkup(event, index) {
  const isRestricted = Boolean(event._note) && String(event.source).toUpperCase() === 'STRAVA';
  const kind = sportClass(event.type);
  const duration = formatDuration(eventDuration(event));
  const distance = formatDistance(eventDistance(event));
  const load = Number(event.icu_training_load);
  const details = [duration, distance, Number.isFinite(load) && load > 0 ? `${Math.round(load)} TSS` : ''].filter(Boolean);
  const meta = details.map(item => `<span>${escapeHTML(item)}</span>`).join('');
  const name = event.name || (isRestricted ? 'Activity details unavailable' : event.type || 'Workout');
  const note = event.description || event._note;
  const description = note ? `<div class="workout-description">${escapeHTML(note.split('\n')[0])}</div>` : '';
  const showType = event.type ? displaySportType(event.type) : (isRestricted ? 'Strava activity' : 'Workout');
  const sourceClass = event._source === 'activity' ? 'activity' : 'planned';
  const restrictedClass = isRestricted ? 'restricted' : '';
  const fallbackMeta = isRestricted ? 'Details unavailable via API' : sourceClass === 'planned' ? 'Planned' : 'Activity';
  const skyline = sourceClass === 'activity' ? skylineMarkup(event) : '';
  const canDelete = (event._source === 'planned' || event._source === 'activity') && Boolean(event.id) && !event._sample && !event._local;
  const canDrag = event._source === 'planned' && Boolean(event.id) && !event._sample && !event._local;
  const isPaired = event._source === 'activity'
    ? Boolean(event.paired_event_id)
    : event._source === 'planned' && events.some(item => item._source === 'activity' && String(item.paired_event_id) === String(event.id));
  const paired = isPaired ? ' paired' : '';
  return `<div class="workout-card-wrap"><button class="workout-card ${kind} ${sourceClass} ${restrictedClass}${paired}" type="button" data-event-index="${index}"${canDrag ? ' draggable="true" title="Drag to another day or onto a completed activity to pair"' : ''} aria-label="${escapeHTML(showType)}: ${escapeHTML(name)}">
    <span class="workout-type"><i class="sport-icon" aria-hidden="true">${sportIconMarkup(showType)}</i>${escapeHTML(showType)}</span>
    <span class="workout-title">${escapeHTML(name)}</span>
    ${skyline}
    <span class="workout-meta">${meta || `<span>${escapeHTML(fallbackMeta)}</span>`}</span>
    ${description}${paired ? '<span class="paired-indicator" title="This workout is paired with a completed activity">Paired</span>' : ''}
  </button>${canDelete ? `<button class="calendar-delete" type="button" data-calendar-delete="${index}" aria-label="Delete ${escapeHTML(name)}" title="Delete workout or activity">×</button>` : ''}</div>`;
}

function renderCalendar() {
  monthTitle.textContent = formatMonth(visibleMonth);
  const weeks = getVisibleWeeks();
  const grouped = getEventsByDate();
  for (const event of localWorkouts) {
    const date = parseLocalDate(event.start_date_local);
    if (!date) continue;
    const key = dateKey(date);
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    bucket.sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));
    grouped.set(key, bucket);
  }
  const flatEvents = [];
  const todayKey = dateKey(new Date());
  const visibleMonthNumber = visibleMonth.getMonth();
  weeksRoot.innerHTML = weeks.map((week, weekIndex) => {
    const daysMarkup = week.map(date => {
      const key = dateKey(date);
      const dayEvents = grouped.get(key) ?? [];
      const wellness = wellnessByDate.get(key);
      const isToday = key === todayKey;
      const outsideMonth = date.getMonth() !== visibleMonthNumber;
      const displayMonth = date.getDate() === 1 || (outsideMonth && weekIndex === weeks.length - 1 && date.getDay() === 1);
      const cards = dayEvents.map(event => {
        const eventIndex = flatEvents.push(event) - 1;
        return workoutMarkup(event, eventIndex);
      }).join('');
      const dayWorkoutEvents = dayEvents.filter(item => item._source === 'planned' && !item._sample && !item._local || item._local);
      const dayDeleteCount = dayEvents.filter(item => (item._source === 'planned' || item._source === 'activity') && !item._sample && !item._local).length + dayEvents.filter(item => item._local).length;
      return `<section class="day-cell${outsideMonth ? ' outside-month' : ''}${isToday ? ' is-today' : ''}" role="gridcell" data-day-key="${key}" aria-label="${escapeHTML(new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(date))}">
        <div class="day-head"><span class="day-number">${date.getDate()}${displayMonth ? `<span class="day-label-month">${new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date)}</span>` : ''}</span><button type="button" class="day-menu-button" data-day-menu aria-label="Actions for ${escapeHTML(new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(date))}" aria-haspopup="menu" aria-expanded="false"><span class="day-menu-icon" aria-hidden="true"><i></i><i></i><i></i></span></button><div class="day-menu-popover" role="menu" hidden>
          <button type="button" role="menuitem" data-day-action="add" data-day-key="${key}">Add workout</button>
          <button type="button" role="menuitem" data-day-action="copy" data-day-key="${key}"${dayWorkoutEvents.length ? '' : ' disabled'}>Copy</button>
          <button type="button" role="menuitem" data-day-action="cut" data-day-key="${key}"${dayWorkoutEvents.length ? '' : ' disabled'}>Cut</button>
          ${calendarClipboard?.length ? `<button type="button" role="menuitem" data-day-action="paste" data-day-key="${key}">Paste ${calendarClipboard.length} workout${calendarClipboard.length === 1 ? '' : 's'}</button>` : ''}
          <span class="day-menu-separator" role="separator"></span>
          <button type="button" role="menuitem" class="day-menu-delete" data-day-action="delete" data-day-key="${key}"${dayDeleteCount ? '' : ' disabled'}>Delete day</button>
        </div></div>
        <div class="workout-list">${cards}${wellnessMarkup(wellness)}<button class="add-workout" type="button" data-add-workout="${key}" aria-label="Create workout on ${escapeHTML(new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(date))}" title="Create workout"><span aria-hidden="true">＋</span></button></div>
      </section>`;
    }).join('');
    const weekStart = week[0];
    const weekEnd = week[6];
    const weekEvents = week.flatMap(date => grouped.get(dateKey(date)) ?? []);
    return `<section class="week-row${week.some(date => dateKey(date) === todayKey) ? ' is-current' : ''}" aria-label="Week of ${escapeHTML(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(weekStart))} to ${escapeHTML(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(weekEnd))}">
      <div class="week-days" role="row">${daysMarkup}</div>${summaryMarkup(weekEvents)}
    </section>`;
  }).join('');
  weeksRoot.dataset.events = JSON.stringify(flatEvents);
}

function setConnectionState(connected, label = '') {
  document.querySelector('#connection-dot').classList.toggle('connected', connected);
  document.querySelector('#connection-label').textContent = connected ? 'Connected' : 'Connect Intervals.icu';
  syncStatus.classList.toggle('connected', connected);
  document.querySelector('#calendar-footnote').textContent = connected
    ? events.length || localWorkouts.length
      ? `Showing ${events.length} synced entr${events.length === 1 ? 'y' : 'ies'}${localWorkouts.length ? ` · ${localWorkouts.length} local plan${localWorkouts.length === 1 ? '' : 's'}` : ''} · Intervals.icu`
      : 'Connected to Intervals.icu · No workouts or activities returned for these dates'
    : localWorkouts.length
      ? `Sample calendar · ${localWorkouts.length} local plan${localWorkouts.length === 1 ? '' : 's'} saved in this browser`
      : 'Sample workouts · Connect Intervals.icu to load your calendar';
  if (label) syncText.textContent = label;
}

function setLoading(loading, label = '') {
  syncStatus.classList.toggle('loading', loading);
  if (loading) syncText.textContent = label || 'Loading calendar…';
  else if (apiCredentials) {
    syncStatus.classList.add('connected');
    syncText.textContent = 'Intervals.icu';
  } else {
    syncText.textContent = 'Sample calendar';
  }
}

function apiBasicAuth(apiKey) {
  const bytes = new TextEncoder().encode(`API_KEY:${apiKey}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function loadCalendar(credentials, { openOnError = false } = {}) {
  const sequence = ++requestSequence;
  const weeks = getVisibleWeeks();
  const oldest = dateKey(weeks[0][0]);
  const newest = dateKey(weeks[weeks.length - 1][6]);
  const athlete = encodeURIComponent(credentials.athleteId || '0');
  const eventQuery = new URLSearchParams({ oldest, newest, category: 'WORKOUT' });
  const activityQuery = new URLSearchParams({ oldest, newest });
  const wellnessQuery = new URLSearchParams({ oldest, newest });
  const eventsUrl = `${API_BASE}/athlete/${athlete}/events?${eventQuery}`;
  const activitiesUrl = `${API_BASE}/athlete/${athlete}/activities?${activityQuery}`;
  const wellnessUrl = `${API_BASE}/athlete/${athlete}/wellness?${wellnessQuery}`;
  setLoading(true);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const fetchList = async url => {
      const response = await fetch(url, {
        headers: { Authorization: apiBasicAuth(credentials.apiKey), Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store'
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('Intervals.icu rejected this athlete ID or API key. Check both and try again.');
        if (response.status === 429) throw new Error('Intervals.icu rate limit reached. Wait a little, then try again.');
        throw new Error(`Intervals.icu returned an error (${response.status}). Please try again.`);
      }
      const responseBody = await response.text();
      let payload;
      try {
        payload = responseBody.trim() ? JSON.parse(responseBody) : [];
      } catch {
        throw new Error('Intervals.icu returned a successful response that was not valid JSON.');
      }
      if (!Array.isArray(payload)) throw new Error('The API response was not a list of calendar entries.');
      return payload;
    };
    const [plannedWorkouts, completedActivities, wellnessRecords] = await Promise.all([
      fetchList(eventsUrl),
      fetchList(activitiesUrl),
      fetchList(wellnessUrl).catch(() => [])
    ]);
    if (sequence !== requestSequence) return;
    events = [
      ...plannedWorkouts
        .filter(event => !event.category || event.category === 'WORKOUT')
        .map(event => ({ ...event, _source: 'planned' })),
      ...completedActivities.map(activity => ({ ...activity, _source: 'activity' }))
    ];
    wellnessByDate = new Map(wellnessRecords.filter(record => record?.id).map(record => [String(record.id), record]));
    saveCredentials(credentials);
    renderCalendar();
    setConnectionState(true, 'Intervals.icu');
    if (connectDialog.open) {
      formMessage.textContent = `Connected. Loaded ${events.length} calendar entr${events.length === 1 ? 'y' : 'ies'}.`;
      formMessage.classList.add('success');
      setTimeout(() => { if (connectDialog.open) connectDialog.close(); }, 850);
    }
  } catch (error) {
    if (sequence !== requestSequence) return;
    setLoading(false);
    if (openOnError) {
      formMessage.textContent = error.name === 'AbortError' ? 'The request timed out. Check your connection and try again.' : error.message;
      if (error instanceof TypeError) formMessage.textContent = 'Could not reach the API. Check your connection and confirm the app is opened from a local web server.';
      formMessage.classList.remove('success');
      submitButton.disabled = false;
      submitLabel.textContent = 'Connect and load calendar';
    } else {
      syncText.textContent = 'Sync failed';
      setConnectionState(false, 'Sync failed');
      openConnectionDialog(error.message);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function updateCalendarEntry(url, body, action) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: apiBasicAuth(apiCredentials.apiKey),
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Intervals.icu rejected this API key or athlete ID. Check your connection settings.');
    throw new Error(`Intervals.icu could not ${action} (${response.status}).`);
  }
  const text = await response.text();
  if (!text.trim()) return body;
  try {
    const result = JSON.parse(text);
    return result && typeof result === 'object' && !Array.isArray(result) ? { ...body, ...result } : body;
  } catch {
    return body;
  }
}

async function reschedulePlannedWorkout(event, dayKey) {
  const athlete = encodeURIComponent(apiCredentials?.athleteId || '0');
  const url = `${API_BASE}/athlete/${athlete}/events/${encodeURIComponent(event.id)}`;
  const body = { ...event, start_date_local: `${dayKey}T00:00:00` };
  delete body._source;
  delete body._sample;
  delete body._local;
  try {
    const updated = await updateCalendarEntry(url, body, 'move this workout');
    events = events.map(item => String(item.id) === String(event.id) ? { ...updated, _source: 'planned' } : item);
    renderCalendar();
    setConnectionState(true, 'Workout rescheduled');
  } catch (error) {
    syncText.textContent = error.message;
  }
}

async function pairPlannedWorkout(event, activity) {
  const athlete = encodeURIComponent(apiCredentials?.athleteId || '0');
  const url = `${API_BASE}/activity/${encodeURIComponent(activity.id)}`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: apiBasicAuth(apiCredentials.apiKey), Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Intervals.icu could not load the activity details (${response.status}).`);
    const fullActivity = await response.json();
    const updated = await updateCalendarEntry(url, { ...fullActivity, paired_event_id: Number(event.id) }, 'pair this workout with the activity');
    events = events.map(item => String(item.id) === String(activity.id) ? { ...item, ...updated, _source: 'activity' } : item);
    renderCalendar();
    setConnectionState(true, 'Workout paired with activity');
  } catch (error) {
    syncText.textContent = error.message;
  }
}

weeksRoot.addEventListener('dragstart', event => {
  const card = event.target.closest('[data-event-index][draggable="true"]');
  if (!card || !event.dataTransfer) return;
  const selected = JSON.parse(weeksRoot.dataset.events || '[]')[Number(card.dataset.eventIndex)];
  if (!selected || selected._source !== 'planned') return;
  calendarDraggedEventId = String(selected.id);
  event.dataTransfer.setData('application/x-intervals-planned-event', calendarDraggedEventId);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('calendar-dragging');
});

weeksRoot.addEventListener('dragover', event => {
  if (!calendarDraggedEventId) return;
  const targetDay = event.target.closest('.day-cell');
  const targetCard = event.target.closest('[data-event-index]');
  if (!targetDay && !targetCard) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  weeksRoot.querySelectorAll('.calendar-drop-target').forEach(node => node.classList.remove('calendar-drop-target'));
  (targetCard || targetDay).classList.add('calendar-drop-target');
});

weeksRoot.addEventListener('drop', event => {
  if (!calendarDraggedEventId || !event.dataTransfer) return;
  const id = event.dataTransfer.getData('application/x-intervals-planned-event') || calendarDraggedEventId;
  const planned = events.find(item => item._source === 'planned' && String(item.id) === id);
  if (!planned) return;
  const targetCard = event.target.closest('[data-event-index]');
  const allEvents = JSON.parse(weeksRoot.dataset.events || '[]');
  const targetEvent = targetCard ? allEvents[Number(targetCard.dataset.eventIndex)] : null;
  if (targetEvent?._source === 'activity') {
    event.preventDefault();
    if (!targetEvent.paired_event_id || String(targetEvent.paired_event_id) !== String(planned.id)) pairPlannedWorkout(planned, targetEvent);
  } else {
    const targetDay = event.target.closest('.day-cell');
    if (targetDay?.dataset.dayKey) {
      event.preventDefault();
      const currentDate = parseLocalDate(planned.start_date_local);
      if (!currentDate || dateKey(currentDate) !== targetDay.dataset.dayKey) reschedulePlannedWorkout(planned, targetDay.dataset.dayKey);
    }
  }
  calendarDraggedEventId = null;
  suppressCalendarClick = true;
  setTimeout(() => { suppressCalendarClick = false; }, 0);
  weeksRoot.querySelectorAll('.calendar-drop-target, .calendar-dragging').forEach(node => node.classList.remove('calendar-drop-target', 'calendar-dragging'));
});

weeksRoot.addEventListener('dragend', () => {
  calendarDraggedEventId = null;
  weeksRoot.querySelectorAll('.calendar-drop-target, .calendar-dragging').forEach(node => node.classList.remove('calendar-drop-target', 'calendar-dragging'));
});

function openConnectionDialog(message = '') {
  formMessage.textContent = message;
  formMessage.classList.remove('success');
  document.querySelector('#athlete-id').value = apiCredentials?.athleteId ?? '0';
  document.querySelector('#api-key').value = apiCredentials?.apiKey ?? '';
  submitButton.disabled = false;
  submitLabel.textContent = apiCredentials ? 'Reconnect and refresh' : 'Connect and load calendar';
  document.querySelector('#disconnect-button').hidden = !apiCredentials;
  if (!connectDialog.open) connectDialog.showModal();
}

function openWorkout(event) {
  const kind = sportClass(event.type);
  const isRestricted = Boolean(event._note) && String(event.source).toUpperCase() === 'STRAVA';
  const date = parseLocalDate(event.start_date_local);
  const dateText = date ? new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date) : '';
  const metrics = [
    ['DURATION', formatDuration(eventDuration(event))],
    ['DISTANCE', formatDistance(eventDistance(event))],
    [event._source === 'activity' ? 'TSS' : 'PLANNED TSS', Number(event.icu_training_load) > 0 ? Math.round(event.icu_training_load) : '—']
  ].filter(([, value]) => value !== '');
  const sportLabel = event.type ? displaySportType(event.type) : (isRestricted ? 'Strava activity' : 'Workout');
  const title = event.name || (isRestricted ? 'Activity details unavailable' : event.type || 'Workout');
  const description = event.description || event._note;
  const canManage = event._source === 'planned' && Boolean(event.id) && !event._sample && !event._local;
  const canManageActivity = event._source === 'activity' && Boolean(event.id) && !event._sample && !event._local;
  const wellness = wellnessMarkup(wellnessByDate.get(date ? dateKey(date) : ''), true);
  const analysis = event._source === 'activity' ? '<div class="activity-analysis-placeholder" role="status">Loading activity streams…</div>' : '';
  workoutDialogContent.innerHTML = `<div class="workout-detail-top"><span class="workout-detail-sport" style="--sport-color:var(--${kind})"><i></i>${escapeHTML(sportLabel)}</span><button class="dialog-close" type="button" data-close-workout aria-label="Close">×</button></div>
    <div class="workout-detail-date">${escapeHTML(dateText)}</div>
    <h2 id="workout-dialog-title">${escapeHTML(title)}</h2>
    <div class="workout-detail-metrics">${metrics.map(([label, value]) => `<span>${label}<strong>${escapeHTML(value)}</strong></span>`).join('')}</div>
    ${wellness}
    ${analysis}
    ${description ? `<div class="workout-description-full">${escapeHTML(description)}</div>` : '<div class="workout-description-full">No workout notes.</div>'}
    <p class="builder-note error" id="workout-action-message" role="status"></p>
    ${event._local ? '<p class="builder-note">Saved in this browser only · Not synced to Intervals.icu</p>' : ''}
    <div class="workout-dialog-actions">${event._sample || event._local ? '' : '<a class="icu-link" href="https://intervals.icu" target="_blank" rel="noreferrer">Open Intervals.icu ↗</a>'}${canManage ? `<span class="workout-manage-actions"><button type="button" data-edit-event="${escapeHTML(String(event.id))}">Edit</button><button type="button" class="delete-workout" data-delete-event="${escapeHTML(String(event.id))}">Delete</button></span>` : ''}${canManageActivity ? `<span class="workout-manage-actions"><button type="button" data-edit-activity="${escapeHTML(String(event.id))}">Edit name</button><button type="button" class="delete-workout" data-delete-activity="${escapeHTML(String(event.id))}">Delete</button></span>` : ''}<button type="button" data-close-workout>Done</button></div>`;
  if (!workoutDialog.open) workoutDialog.showModal();
  if (event._source === 'activity') loadActivityAnalysis(event);
}

async function deletePlannedWorkout(event, button) {
  const name = event.name || 'this planned workout';
  if (!window.confirm(`Delete “${name}” from your Intervals.icu calendar? This cannot be undone.`)) return;
  const athlete = encodeURIComponent(apiCredentials?.athleteId || '0');
  const url = `${API_BASE}/athlete/${athlete}/events/${encodeURIComponent(event.id)}`;
  button.disabled = true;
  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: apiBasicAuth(apiCredentials.apiKey), Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Intervals.icu rejected this API key or athlete ID. Check your connection settings.');
      throw new Error(`Intervals.icu could not delete this workout (${response.status}).`);
    }
    events = events.filter(item => String(item.id) !== String(event.id));
    renderCalendar();
    if (workoutDialog.open) workoutDialog.close();
  } catch (error) {
    const message = workoutDialogContent.querySelector('#workout-action-message');
    if (message) message.textContent = error instanceof TypeError ? 'Could not reach Intervals.icu. Check your connection and try again.' : error.message;
    else syncText.textContent = error instanceof TypeError ? 'Could not reach Intervals.icu. Check your connection and try again.' : error.message;
    button.disabled = false;
  }
}

function openActivityNameEditor(activity) {
  editingActivity = activity;
  editingEvent = null;
  workoutDialogContent.innerHTML = `<form class="activity-name-form" id="activity-name-form" aria-labelledby="activity-name-title">
    <div class="workout-detail-top"><span class="workout-detail-sport">EDIT COMPLETED ACTIVITY</span><button class="dialog-close" type="button" data-close-workout aria-label="Close">×</button></div>
    <h2 id="activity-name-title">Edit activity name</h2>
    <label class="builder-field">Name<input name="name" maxlength="120" value="${escapeHTML(activity.name || '')}" required></label>
    <p class="builder-note error" id="activity-action-message" role="status"></p>
    <div class="builder-actions"><button type="button" data-close-workout>Cancel</button><button class="builder-save" type="submit">Save name</button></div>
  </form>`;
  if (!workoutDialog.open) workoutDialog.showModal();
  workoutDialogContent.querySelector('[name="name"]').focus();
}

function openActivityDeleteConfirm(activity) {
  deletingActivity = activity;
  workoutDialogContent.innerHTML = `<section class="activity-delete-confirm" role="alertdialog" aria-labelledby="activity-delete-title" aria-describedby="activity-delete-description">
    <div class="workout-detail-top"><span class="workout-detail-sport">DELETE COMPLETED ACTIVITY</span></div>
    <h2 id="activity-delete-title">Delete this activity?</h2>
    <p id="activity-delete-description">“${escapeHTML(activity.name || activity.type || 'Completed activity')}” will be deleted from Intervals.icu. This cannot be undone.</p>
    <p class="builder-note error" id="activity-action-message" role="status"></p>
    <div class="builder-actions"><button type="button" data-cancel-activity-delete>Cancel</button><button type="button" class="delete-workout" data-confirm-delete-activity>Delete activity</button></div>
  </section>`;
  if (!workoutDialog.open) workoutDialog.showModal();
  workoutDialogContent.querySelector('[data-cancel-activity-delete]').focus();
}

async function saveActivityName(activity, name, button) {
  const message = workoutDialogContent.querySelector('#activity-action-message');
  if (!apiCredentials) {
    message.textContent = 'Connect your Intervals.icu account before editing this activity.';
    return;
  }
  const trimmedName = name.trim();
  if (!trimmedName) return;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const response = await fetch(`${API_BASE}/activity/${encodeURIComponent(activity.id)}`, {
      method: 'PUT',
      headers: {
        Authorization: apiBasicAuth(apiCredentials.apiKey),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: trimmedName }),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Intervals.icu could not update this activity (${response.status}).`);
    const responseBody = await response.text();
    let updated = { ...activity, name: trimmedName };
    if (responseBody.trim()) {
      try {
        const payload = JSON.parse(responseBody);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) updated = { ...updated, ...payload, name: payload.name || trimmedName };
      } catch { /* A successful update may return an empty body. */ }
    }
    events = events.map(item => String(item.id) === String(activity.id) ? { ...updated, _source: 'activity' } : item);
    renderCalendar();
    editingActivity = null;
    workoutDialog.close();
    openWorkout(events.find(item => String(item.id) === String(activity.id)) || updated);
  } catch (error) {
    message.textContent = error instanceof TypeError ? 'Could not reach Intervals.icu. Check your connection and try again.' : error.message;
    button.disabled = false;
    button.textContent = 'Save name';
  }
}

async function deleteCompletedActivity(activity, button) {
  const message = workoutDialogContent.querySelector('#activity-action-message');
  if (!apiCredentials) {
    message.textContent = 'Connect your Intervals.icu account before deleting this activity.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Deleting…';
  try {
    const response = await fetch(`${API_BASE}/activity/${encodeURIComponent(activity.id)}`, {
      method: 'DELETE',
      headers: { Authorization: apiBasicAuth(apiCredentials.apiKey), Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Intervals.icu could not delete this activity (${response.status}).`);
    events = events.filter(item => String(item.id) !== String(activity.id));
    renderCalendar();
    deletingActivity = null;
    workoutDialog.close();
  } catch (error) {
    message.textContent = error instanceof TypeError ? 'Could not reach Intervals.icu. Check your connection and try again.' : error.message;
    button.disabled = false;
    button.textContent = 'Delete activity';
  }
}

async function loadActivityAnalysis(activity) {
  const id = String(activity.id || '');
  const credentials = apiCredentials;
  if (!id || !credentials?.apiKey) {
    const placeholder = workoutDialogContent.querySelector('.activity-analysis-placeholder');
    if (placeholder) placeholder.textContent = 'Connect to Intervals.icu to load the power and heart-rate streams.';
    return;
  }
  const target = workoutDialogContent.querySelector('.activity-analysis-placeholder');
  if (!target) return;
  try {
    let streams = readActivityStreamCache(id);
    if (!streams) {
      const query = new URLSearchParams({ types: 'time,watts,heartrate,cadence' });
      const response = await fetch(`${API_BASE}/activity/${encodeURIComponent(id)}/streams.json?${query}`, {
        headers: { Authorization: apiBasicAuth(credentials.apiKey), Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`Could not load activity streams (${response.status}).`);
      streams = streamMap(await response.json());
      writeActivityStreamCache(id, streams);
    }
    if (!workoutDialog.open || workoutDialogContent.querySelector('.activity-analysis-placeholder') !== target) return;
    target.outerHTML = activityAnalysisMarkup(streams, activity);
    attachActivityTracer(streams);
  } catch (error) {
    if (!workoutDialog.open || workoutDialogContent.querySelector('.activity-analysis-placeholder') !== target) return;
    target.textContent = `${error.message} The activity summary and calendar thumbnail are still available.`;
    target.classList.add('activity-analysis-error');
  }
}

function cloneBlockPreset(key) {
  const preset = BLOCK_PRESETS.find(item => item.key === key);
  if (!preset) return null;
  builderBlockSequence += 1;
  return { ...preset, repeatable: Boolean(preset.reps), id: `builder-block-${builderBlockSequence}`, steps: preset.steps.map(step => ({ ...step })) };
}

function blockDuration(block) {
  return block.steps.reduce((sum, step) => sum + step.seconds, 0) * (block.reps || 1);
}

function builderTotalDuration() {
  return builderBlocks.reduce((sum, block) => sum + blockDuration(block), 0);
}

function formatWorkoutDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  return parts.join(' ') || '0 min';
}

function formatStepDuration(seconds) {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatInputTime(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function parseInputTime(value) {
  const text = String(value).trim();
  const clock = text.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);
  let total;
  if (clock) {
    total = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  } else {
    const fast = text.match(/^(\d+(?:\.\d+)?)\s*([smh])$/i);
    if (!fast) return null;
    const factor = fast[2].toLowerCase() === 'h' ? 3600 : fast[2].toLowerCase() === 'm' ? 60 : 1;
    total = Math.round(Number(fast[1]) * factor);
  }
  return total > 0 && total <= 36000 ? total : null;
}

function workoutSyntaxDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes ? `${minutes}m` : ''}${remainingSeconds ? `${remainingSeconds}s` : ''}`;
}

function blockSummary(block) {
  const stepSummary = block.steps.map(step => `${formatStepDuration(step.seconds)} ${step.power}%`).join(' · ');
  return block.repeatable ? `${block.reps} × (${stepSummary})` : stepSummary;
}

function workoutEstimates() {
  const totalSeconds = builderTotalDuration();
  if (!totalSeconds) return { totalSeconds: 0, intensityFactor: 0, tss: 0 };
  const fourthPowerSeconds = builderBlocks.reduce((sum, block) => {
    const oneRep = block.steps.reduce((repSum, step) => repSum + step.seconds * Math.pow(step.power / 100, 4), 0);
    return sum + oneRep * (block.reps || 1);
  }, 0);
  const intensityFactor = Math.pow(fourthPowerSeconds / totalSeconds, 0.25);
  const tss = (totalSeconds / 3600) * Math.pow(intensityFactor, 2) * 100;
  return { totalSeconds, intensityFactor, tss };
}

function workoutTimelineMarkup() {
  const total = builderTotalDuration();
  if (!total) return '<div class="builder-chart-empty">Add blocks to preview your workout profile.</div>';
  const { left, right, top, bottom, width, height: plotHeight } = CHART_GEOMETRY;
  const naturalScale = Math.max(900, Math.ceil(total / 900) * 900);
  const scale = activeChartAdjustment?.mode === 'duration'
    ? Math.max(activeChartAdjustment.scaleSeconds, naturalScale)
    : naturalScale;
  const maxPower = Math.max(100, Math.ceil(Math.max(...builderBlocks.flatMap(block => block.steps.map(step => step.power))) / 25) * 25);
  const expanded = [];
  const blockBands = [];
  let elapsed = 0;
  for (const block of builderBlocks) {
    const blockStart = elapsed;
    for (let rep = 0; rep < (block.reps || 1); rep += 1) {
      for (let stepIndex = 0; stepIndex < block.steps.length; stepIndex += 1) {
        const step = block.steps[stepIndex];
        expanded.push({ ...step, block, blockLabel: block.label, blockId: block.id, stepIndex, rep: rep + 1, start: elapsed, end: elapsed + step.seconds });
        elapsed += step.seconds;
      }
    }
    blockBands.push({ block, start: blockStart, end: elapsed, peak: Math.max(...block.steps.map(step => step.power)) });
  }
  const bars = expanded.map(step => {
    const x = left + (step.start / scale) * width;
    const stepWidth = (step.seconds / scale) * width;
    const y = bottom - (step.power / maxPower) * plotHeight;
    const barWidth = Math.max(1, stepWidth);
    const barHeight = Math.max(0, bottom - y);
    const corner = Math.min(12, barWidth / 2, barHeight / 2);
    const barPath = `M ${x.toFixed(2)} ${bottom} L ${x.toFixed(2)} ${(y + corner).toFixed(2)} Q ${x.toFixed(2)} ${y.toFixed(2)} ${(x + corner).toFixed(2)} ${y.toFixed(2)} H ${(x + barWidth - corner).toFixed(2)} Q ${(x + barWidth).toFixed(2)} ${y.toFixed(2)} ${(x + barWidth).toFixed(2)} ${(y + corner).toFixed(2)} L ${(x + barWidth).toFixed(2)} ${bottom} Z`;
    const hitY = Math.min(y, bottom - 12);
    const hitHeight = Math.max(12, bottom - y);
    const isRepeated = step.block.repeatable;
    const powerLabel = `${step.blockLabel}${isRepeated ? `, repetition ${step.rep}` : ''}, step ${step.stepIndex + 1} power`;
    const durationLabel = `${step.blockLabel}${isRepeated ? `, repetition ${step.rep}` : ''}, step ${step.stepIndex + 1} duration`;
    return `<path d="${barPath}" fill="${powerZone(step.power).color}" stroke="#fff" stroke-width=".7"><title>${escapeHTML(step.blockLabel)} · ${formatStepDuration(step.seconds)} at ${step.power}% FTP · ${powerZone(step.power).label}</title></path><rect class="chart-power-hit" x="${x.toFixed(2)}" y="${hitY.toFixed(2)}" width="${Math.max(1, stepWidth - 7).toFixed(2)}" height="${hitHeight.toFixed(2)}" fill="transparent" pointer-events="all" data-chart-adjust="power" data-block-id="${step.blockId}" data-step-index="${step.stepIndex}" role="slider" tabindex="0" aria-label="${escapeHTML(powerLabel)}" aria-valuemin="0" aria-valuemax="200" aria-valuenow="${step.power}"/><rect class="chart-duration-hit" x="${(x + Math.max(0, stepWidth - 9)).toFixed(2)}" y="${hitY.toFixed(2)}" width="${Math.min(12, Math.max(8, stepWidth)).toFixed(2)}" height="${hitHeight.toFixed(2)}" fill="transparent" pointer-events="all" data-chart-adjust="duration" data-block-id="${step.blockId}" data-step-index="${step.stepIndex}" role="slider" tabindex="0" aria-label="${escapeHTML(durationLabel)}" aria-valuemin="5" aria-valuemax="36000" aria-valuenow="${step.seconds}"/>`;
  }).join('');
  const grid = Array.from({ length: Math.floor(maxPower / 25) + 1 }, (_, index) => index * 25).map(value => {
    const y = bottom - (value / maxPower) * plotHeight;
    return `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="#e9eef3"/><text x="${left - 8}" y="${y + 3}" text-anchor="end" class="chart-axis-label" style="fill:${powerZone(value).color}">${value}%</text>`;
  }).join('');
  const labels = blockBands.map(({ block, start, end, peak }) => {
    const x = left + (start / scale) * width + 3;
    const y = Math.max(12, bottom - (peak / maxPower) * plotHeight - 7);
    const description = block.repeatable
      ? `${block.reps} × ${block.steps.map(step => `${formatStepDuration(step.seconds)} @ ${step.power}% FTP`).join(', ')}`
      : `${block.label}: ${block.steps.map(step => `${formatStepDuration(step.seconds)} @ ${step.power}% FTP`).join(', ')}`;
    const dragHint = '<tspan class="chart-block-grip-glyph">⠿ </tspan>';
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" class="chart-block-label" data-chart-block-drag="${block.id}" role="button" tabindex="0" aria-label="Drag to reorder ${escapeHTML(block.label)}"><title>Drag to reorder ${escapeHTML(block.label)} · ${formatWorkoutDuration(end - start)}</title>${dragHint}${escapeHTML(description)}</text>`;
  }).join('');
  const repeatControls = blockBands.filter(({ block }) => block.repeatable).map(({ block, start }) => {
    const blockX = left + (start / scale) * width;
    const x = Math.min(right - 62, Math.max(left + 4, blockX + 12));
    const y = 6;
    return `<g class="chart-repeat-control" aria-label="${escapeHTML(block.label)} repetitions"><rect class="chart-repeat-control-bg" x="${x}" y="${y}" width="62" height="29" rx="8"/><rect class="chart-repeat-button" x="${x + 1}" y="${y + 1}" width="30" height="27" rx="7" data-adjust-reps="1" data-block-id="${block.id}" role="button" tabindex="0" aria-label="Add repetition to ${escapeHTML(block.label)}"/><rect class="chart-repeat-button" x="${x + 31}" y="${y + 1}" width="30" height="27" rx="7" data-adjust-reps="-1" data-block-id="${block.id}" role="button" tabindex="0" aria-label="Remove repetition from ${escapeHTML(block.label)}"/><path d="M ${x + 31} ${y + 5} V ${y + 25}" class="chart-repeat-divider"/><text x="${x + 16}" y="${y + 19}" text-anchor="middle" class="chart-repeat-symbol" pointer-events="none">+</text><text x="${x + 46}" y="${y + 19}" text-anchor="middle" class="chart-repeat-symbol" pointer-events="none">−</text></g>`;
  }).join('');
  const chartBlockGrips = blockBands.map(({ block, start, peak }) => {
    const x = Math.min(right - 24, left + (start / scale) * width + 6);
    const y = Math.min(bottom - 23, Math.max(top + 8, bottom - (peak / maxPower) * plotHeight + 7));
    return `<g class="chart-block-grip" data-chart-block-drag="${block.id}" role="button" tabindex="0" aria-label="Drag to reorder ${escapeHTML(block.label)}"><title>Drag to reorder ${escapeHTML(block.label)}</title><rect x="${x}" y="${y}" width="19" height="17" rx="4" class="chart-block-grip-bg"/><text x="${x + 9.5}" y="${y + 12}" text-anchor="middle" class="chart-block-grip-symbol" pointer-events="none">⠿</text></g>`;
  }).join('');
  const timeTicks = Array.from({ length: Math.floor(scale / 900) + 1 }, (_, index) => index * 900).map(seconds => {
    const x = left + (seconds / scale) * width;
    const hours = Math.floor(seconds / 3600);
    const remainingMinutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const label = `${hours}:${remainingMinutes}:00`;
    return `<line x1="${x}" y1="${bottom}" x2="${x}" y2="${bottom + 4}" stroke="#9caab5"/><text x="${x}" y="${bottom + 17}" text-anchor="middle" class="chart-axis-label">${label}</text>`;
  }).join('');
  return `<svg class="builder-chart" viewBox="0 0 1640 220" data-scale-seconds="${scale}" data-power-max="${maxPower}" role="group" aria-label="Adjustable workout profile: drag block handles or labels to reorder blocks, bar bodies to change power by 1%, or right edges to change time by 5 seconds">${grid}<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#9caab5"/>${bars}${labels}${chartBlockGrips}${repeatControls}${timeTicks}</svg>`;
}

function renderWorkoutBuilderState() {
  const list = workoutDialogContent.querySelector('#builder-block-list');
  if (!list) return;
  const inputList = workoutDialogContent.querySelector('#builder-input-list');
  const estimates = workoutEstimates();
  workoutDialogContent.querySelector('#builder-total').textContent = formatInputTime(estimates.totalSeconds);
  workoutDialogContent.querySelector('#builder-tss').textContent = estimates.totalSeconds ? Math.round(estimates.tss) : '—';
  workoutDialogContent.querySelector('#builder-if').textContent = estimates.totalSeconds ? estimates.intensityFactor.toFixed(2) : '—';
  list.innerHTML = builderBlocks.length ? builderBlocks.map((block, index) => `<article class="builder-block" draggable="true" data-block-id="${block.id}">
    <div class="builder-block-main"><span class="builder-block-drag" draggable="true" data-block-drag="true" data-block-id="${block.id}" aria-label="Drag to reorder ${escapeHTML(block.label)}">⠿</span><span class="builder-block-index">${String(index + 1).padStart(2, '0')}</span>
      <div class="builder-block-copy"><strong>${escapeHTML(block.label)}</strong><span>${escapeHTML(blockSummary(block))}</span></div>
      <div class="builder-block-controls">${block.repeatable ? `<span class="builder-repeat-control"><button type="button" data-adjust-reps="-1" data-block-index="${index}" aria-label="Remove repetition from ${escapeHTML(block.label)}">−</button><span>${block.reps}×</span><button type="button" data-adjust-reps="1" data-block-index="${index}" aria-label="Add repetition to ${escapeHTML(block.label)}">+</button></span>` : ''}<button type="button" data-move-block="${index - 1}" aria-label="Move ${escapeHTML(block.label)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move-block="${index + 1}" aria-label="Move ${escapeHTML(block.label)} down" ${index === builderBlocks.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="remove-block" data-remove-block="${index}" aria-label="Remove ${escapeHTML(block.label)}">×</button></div>
    </div>
  </article>`).join('') : '<div class="builder-empty">Choose a block above to start building.</div>';
  if (inputList) inputList.innerHTML = builderBlocks.length ? builderBlocks.map((block, index) => `<fieldset class="builder-input-block"><legend>${String(index + 1).padStart(2, '0')} · ${escapeHTML(block.label)}</legend>
    <div class="builder-input-block-heading"><strong>${escapeHTML(block.label)}</strong>${block.repeatable ? `<div class="builder-repeat-editor"><span>Repeats</span><button type="button" data-adjust-reps="-1" data-block-index="${index}" aria-label="Remove repetition from ${escapeHTML(block.label)}">−</button><input type="number" min="1" max="20" step="1" value="${block.reps}" data-edit-reps="${index}" aria-label="${escapeHTML(block.label)} repeat count"><button type="button" data-adjust-reps="1" data-block-index="${index}" aria-label="Add repetition to ${escapeHTML(block.label)}">+</button><span>×</span></div>` : ''}</div>
    <div class="builder-step-inputs">${block.steps.map((step, stepIndex) => `<div class="builder-step-input-row"><span class="builder-step-number">Step ${stepIndex + 1}</span><label>Time<input type="text" inputmode="text" maxlength="16" title="Enter HH:MM:SS or a fast time such as 10s, 1m, or 1.5h" value="${formatInputTime(step.seconds)}" data-edit-duration="${stepIndex}" data-block-index="${index}" aria-label="${escapeHTML(block.label)} step ${stepIndex + 1} time"></label><label>Power<input type="number" min="0" max="200" step="1" value="${step.power}" data-edit-power="${stepIndex}" data-block-index="${index}" aria-label="${escapeHTML(block.label)} step ${stepIndex + 1} power percent FTP"><span>% FTP</span></label></div>`).join('')}</div>
  </fieldset>`).join('') : '<div class="builder-empty">Add a block to edit its intervals here.</div>';
  workoutDialogContent.querySelector('#builder-chart-wrap').innerHTML = workoutTimelineMarkup();
}

function builderStepFor(blockId, stepIndex) {
  const block = builderBlocks.find(item => item.id === blockId);
  return block?.steps[Number(stepIndex)] ?? null;
}

function chartPoint(event, svg) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function chartDropInsertionIndex(event, chartWrap) {
  const svg = chartWrap.querySelector('.builder-chart');
  if (!svg || !builderBlocks.length) return builderBlocks.length;
  const point = chartPoint(event, svg);
  const { left, width } = CHART_GEOMETRY;
  const scale = Number(svg.dataset.scaleSeconds) || builderTotalDuration();
  const timelinePosition = Math.max(0, Math.min(1, (point.x - left) / width)) * scale;
  let elapsed = 0;
  for (let index = 0; index < builderBlocks.length; index += 1) {
    const duration = blockDuration(builderBlocks[index]);
    if (timelinePosition < elapsed + duration / 2) return index;
    elapsed += duration;
  }
  return builderBlocks.length;
}

function changeBuilderStep(blockId, stepIndex, mode, value) {
  const step = builderStepFor(blockId, stepIndex);
  if (!step) return false;
  if (mode === 'power') step.power = Math.max(0, Math.min(200, value));
  else step.seconds = Math.max(5, Math.min(36000, value));
  renderWorkoutBuilderState();
  return true;
}

function workoutDescriptionFromBlocks(notes) {
  const sections = [];
  for (const block of builderBlocks) {
    const lines = [];
    if (block.repeatable) lines.push(`${block.label} ${block.reps}x`);
    else lines.push(block.label);
    for (const step of block.steps) {
      lines.push(`- ${workoutSyntaxDuration(step.seconds)} ${step.power}% FTP${step.intensity ? ` intensity=${step.intensity}` : ''}`);
    }
    sections.push(lines.join('\n'));
  }
  const workoutText = sections.join('\n\n');
  return notes.trim() ? `${notes.trim()}\n\n${workoutText}` : workoutText;
}

function openWorkoutBuilder(dateValue, eventToEdit = null) {
  const date = parseLocalDate(dateValue) || new Date();
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  editingEvent = eventToEdit;
  builderBlocks = [];
  workoutDialogContent.innerHTML = `<form class="builder-form" id="workout-builder-form" data-edit-mode="${eventToEdit ? 'true' : 'false'}">
    <input type="hidden" name="date" value="${escapeHTML(dateKey(date))}">
    <header class="builder-heading"><div class="builder-date-lockup"><h2 class="sr-only" id="workout-dialog-title">${eventToEdit ? 'Edit planned workout' : 'Create planned workout'}</h2><span class="builder-date">${escapeHTML(dateLabel)}</span><span class="builder-heading-caption">${eventToEdit ? 'EDIT PLANNED WORKOUT' : 'PLANNED WORKOUT'}</span></div><button class="dialog-close" type="button" data-close-workout aria-label="Close">×</button></header>
    <div class="builder-toolbar">
      <label class="builder-name-field"><span class="sr-only">Workout name</span><input name="name" maxlength="80" placeholder="Untitled workout" required></label>
      <label class="builder-sport-field"><span>Sport</span><select name="type"><option>Ride</option><option value="Run">Running</option><option>Swim</option><option value="WeightTraining">Strength</option><option>Other</option></select></label>
      <label class="builder-distance-field"><span>Distance</span><span class="builder-distance-input"><input name="distance" type="number" min="0" step="0.1" placeholder="—" aria-label="Distance in kilometres"><small>km</small></span></label>
      <label class="builder-time-field" hidden><span>Time</span><input name="simple-duration" type="text" inputmode="text" maxlength="16" title="Enter HH:MM:SS or a fast time such as 10s, 1m, or 1.5h" placeholder="e.g. 1.5h" aria-label="Workout time"></label>
      <section class="builder-summary" aria-label="Workout summary"><div><span>Total time</span><strong id="builder-total">0:00:00</strong></div><div><span>TSS</span><strong id="builder-tss">—</strong></div><div><span>IF</span><strong id="builder-if">—</strong></div></section>
    </div>
    <section class="builder-section chart-section" aria-labelledby="chart-title"><div class="builder-section-heading"><h3 id="chart-title">Workout profile</h3><span>Drag the ⠿ handles to reorder · drag bars to adjust power or duration</span></div><div id="builder-chart-wrap" class="builder-chart-wrap" data-dropzone="true"></div></section>
    <section class="builder-section builder-palette-section" aria-labelledby="block-palette-title"><div class="builder-section-heading"><h3 id="block-palette-title">Add block</h3><span>Click or drag into the workout</span></div>
      <div class="builder-palette">${BLOCK_PRESETS.map(block => `<button type="button" class="builder-preset" draggable="true" data-add-block="${block.key}" title="Drag or click to add ${escapeHTML(block.label)}"><span class="preset-glyph" aria-hidden="true">${block.steps.slice(0, 3).map(step => `<i style="--zone-color:${powerZone(step.power).color};--bar-height:${Math.max(5, Math.round((step.power / 100) * 18))}px"></i>`).join('')}</span><strong>${escapeHTML(block.label)}</strong></button>`).join('')}</div>
    </section>
    <section class="builder-section workout-sequence" aria-labelledby="sequence-title"><div class="builder-section-heading"><h3 id="sequence-title">Workout blocks</h3><span>Drag to reorder</span></div><div id="builder-block-list" data-dropzone="true"></div></section>
    <section class="builder-section builder-input-section" aria-labelledby="input-title"><div class="builder-section-heading"><h3 id="input-title">Block editor</h3><span>Time accepts HH:MM:SS or 10s / 1m / 1.5h · duration snaps to 5 sec · power snaps to 1%</span></div><div id="builder-input-list"></div></section>
    <label class="builder-field builder-notes-field">${eventToEdit ? 'Description' : 'Notes'}<textarea name="description" rows="2" maxlength="5000" placeholder="Optional instructions or coaching notes"></textarea></label>
    <p class="builder-note" id="builder-message">${eventToEdit ? 'Edit the planned workout in your Intervals.icu calendar.' : 'This creates a planned workout directly in your Intervals.icu calendar. Connect first if needed.'}</p>
    <div class="builder-actions"><button type="button" class="builder-cancel" data-close-workout>Cancel</button><button class="builder-save" type="submit">${eventToEdit ? 'Save changes' : 'Create workout'}</button></div>
  </form>`;
  if (!workoutDialog.open) workoutDialog.showModal();
  if (eventToEdit) {
    const form = workoutDialogContent.querySelector('#workout-builder-form');
    form.elements.name.value = eventToEdit.name || '';
    const typeSelect = form.elements.type;
    if (![...typeSelect.options].some(option => option.value === eventToEdit.type)) {
      typeSelect.add(new Option(eventToEdit.type || 'Other', eventToEdit.type || 'Other'));
    }
    typeSelect.value = eventToEdit.type || 'Other';
    form.elements.distance.value = Number(eventDistance(eventToEdit)) > 0 ? (Number(eventDistance(eventToEdit)) / 1000).toString() : '';
    form.elements['simple-duration'].value = Number(eventDuration(eventToEdit)) > 0 ? formatInputTime(Number(eventDuration(eventToEdit))) : '';
    form.elements.description.value = eventToEdit.description || '';
  }
  updateBuilderSportFields();
  workoutDialogContent.querySelector('[name="name"]').focus();
  renderWorkoutBuilderState();
}

function updateBuilderSportFields() {
  const form = workoutDialogContent.querySelector('#workout-builder-form');
  if (!form) return;
  const type = form.elements.type.value;
  const basicMode = Boolean(editingEvent) || type === 'Run' || isStrengthType(type);
  form.dataset.basicMode = String(basicMode);
  form.dataset.sport = type;
  form.querySelector('.builder-distance-field').hidden = isStrengthType(type);
  form.querySelector('.builder-time-field').hidden = !basicMode;
}

document.querySelector('#previous-month').addEventListener('click', () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
  if (apiCredentials) loadCalendar(apiCredentials);
  else { events = sampleEvents(); renderCalendar(); setConnectionState(false); }
});
document.querySelector('#next-month').addEventListener('click', () => {
  visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
  if (apiCredentials) loadCalendar(apiCredentials);
  else { events = sampleEvents(); renderCalendar(); setConnectionState(false); }
});
document.querySelector('#today-button').addEventListener('click', () => {
  const today = new Date();
  visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  if (apiCredentials) loadCalendar(apiCredentials);
  else { events = sampleEvents(); renderCalendar(); setConnectionState(false); }
});
document.querySelector('#connect-button').addEventListener('click', () => openConnectionDialog());
document.querySelector('#settings-button').addEventListener('click', () => openConnectionDialog());
document.querySelector('#close-dialog').addEventListener('click', () => connectDialog.close());
document.querySelector('#disconnect-button').addEventListener('click', () => {
  requestSequence += 1;
  saveCredentials(null);
  events = sampleEvents();
  wellnessByDate = new Map();
  renderCalendar();
  setConnectionState(false, 'Sample calendar');
  connectDialog.close();
});
connectDialog.addEventListener('click', event => {
  if (event.target === connectDialog) connectDialog.close();
});
connectForm.addEventListener('submit', event => {
  event.preventDefault();
  const athleteId = document.querySelector('#athlete-id').value.trim() || '0';
  const apiKey = document.querySelector('#api-key').value.trim();
  if (!apiKey) {
    formMessage.textContent = 'Enter your personal API key to continue.';
    return;
  }
  formMessage.textContent = '';
  formMessage.classList.remove('success');
  submitButton.disabled = true;
  submitLabel.textContent = 'Connecting…';
  loadCalendar({ athleteId, apiKey }, { openOnError: true }).finally(() => {
    if (connectDialog.open && submitButton.disabled) {
      submitButton.disabled = false;
      submitLabel.textContent = 'Connect and load calendar';
    }
  });
});
function dayItems(dayKey) {
  const belongsToDay = item => dateKey(parseLocalDate(item.start_date_local) || new Date(0)) === dayKey;
  return [...events.filter(item => (item._source === 'planned' || item._source === 'activity') && !item._sample && belongsToDay(item)), ...localWorkouts.filter(belongsToDay)];
}

function closeDayMenus() {
  weeksRoot.querySelectorAll('.day-menu-popover:not([hidden])').forEach(menu => {
    menu.hidden = true;
    menu.parentElement.querySelector('[data-day-menu]')?.setAttribute('aria-expanded', 'false');
  });
}

document.addEventListener('click', event => {
  if (!event.target.closest('.day-cell')) closeDayMenus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const openMenu = weeksRoot.querySelector('.day-menu-popover:not([hidden])');
  if (!openMenu) return;
  const trigger = openMenu.parentElement.querySelector('[data-day-menu]');
  closeDayMenus();
  trigger?.focus();
});

function copyDayWorkouts(dayKey, cut = false) {
  const selected = dayItems(dayKey).filter(item => item._source === 'planned' || item._local);
  calendarClipboard = selected.map(item => ({ source: item._local ? 'local' : 'planned', event: { ...item } }));
  if (cut) {
    cutDayWorkouts(selected);
    return;
  }
  renderCalendar();
  setConnectionState(Boolean(apiCredentials), `${selected.length} workout${selected.length === 1 ? '' : 's'} copied`);
}

async function cutDayWorkouts(selected) {
  const athlete = encodeURIComponent(apiCredentials?.athleteId || '0');
  const results = await Promise.allSettled(selected.map(item => item._local ? Promise.resolve(item) : fetch(
    `${API_BASE}/athlete/${athlete}/events/${encodeURIComponent(item.id)}`,
    { method: 'DELETE', headers: { Authorization: apiBasicAuth(apiCredentials.apiKey), Accept: 'application/json' }, cache: 'no-store' }
  ).then(response => { if (!response.ok) throw new Error(`${response.status}`); return item; })));
  const removed = new Set(results.filter(result => result.status === 'fulfilled').map(result => result.value));
  events = events.filter(item => !removed.has(item));
  localWorkouts = localWorkouts.filter(item => !removed.has(item));
  try { localStorage.setItem(LOCAL_WORKOUTS_KEY, JSON.stringify(localWorkouts)); } catch { /* Storage is optional for this view. */ }
  renderCalendar();
  const failed = results.filter(result => result.status === 'rejected').length;
  setConnectionState(Boolean(apiCredentials), failed ? `Cut ${removed.size}; ${failed} could not be removed` : `${removed.size} workout${removed.size === 1 ? '' : 's'} cut`);
}

async function pasteDayWorkouts(dayKey) {
  if (!calendarClipboard?.length) return;
  const athlete = encodeURIComponent(apiCredentials?.athleteId || '0');
  const pasted = [];
  try {
    for (const entry of calendarClipboard) {
      if (entry.source === 'local') {
        pasted.push({ ...entry.event, id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, start_date_local: `${dayKey}T00:00:00`, _local: true, _source: 'planned' });
        continue;
      }
      if (!apiCredentials) throw new Error('Connect Intervals.icu to paste synced workouts.');
      const source = entry.event;
      const body = {
        category: 'WORKOUT', start_date_local: `${dayKey}T00:00:00`, type: source.type,
        name: source.name || source.type || 'Workout',
        ...(source.description ? { description: source.description } : {}),
        ...(Number(source.moving_time) > 0 ? { moving_time: Number(source.moving_time) } : {}),
        ...(Number(eventDistance(source)) > 0 ? { distance: Number(eventDistance(source)) } : {})
      };
      const response = await fetch(`${API_BASE}/athlete/${athlete}/events`, {
        method: 'POST', headers: { Authorization: apiBasicAuth(apiCredentials.apiKey), Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store'
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`Intervals.icu could not paste “${body.name}” (${response.status})${responseText ? `: ${responseText.slice(0, 240)}` : ''}.`);
      let created = body;
      try { const payload = JSON.parse(responseText); if (payload && !Array.isArray(payload)) created = { ...body, ...payload }; } catch { /* An empty success body is valid. */ }
      pasted.push({ ...created, _source: 'planned' });
    }
    events.push(...pasted.filter(item => !item._local));
    localWorkouts.push(...pasted.filter(item => item._local));
    try { localStorage.setItem(LOCAL_WORKOUTS_KEY, JSON.stringify(localWorkouts)); } catch { /* Keep the current session visible. */ }
    renderCalendar();
    setConnectionState(Boolean(apiCredentials), `${pasted.length} workout${pasted.length === 1 ? '' : 's'} pasted`);
  } catch (error) {
    events.push(...pasted.filter(item => !item._local));
    localWorkouts.push(...pasted.filter(item => item._local));
    renderCalendar();
    syncText.textContent = error.message;
  }
}

async function deleteDayWorkouts(dayKey) {
  const selected = dayItems(dayKey);
  if (!selected.length) return;
  const label = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(parseLocalDate(dayKey));
  if (!window.confirm(`Delete all ${selected.length} workout${selected.length === 1 ? '' : 's'} on ${label}? Completed activities will also be deleted. This cannot be undone.`)) return;
  const athlete = encodeURIComponent(apiCredentials?.athleteId || '0');
  const results = await Promise.allSettled(selected.map(item => {
    if (item._local) return Promise.resolve(item);
    const url = item._source === 'activity' ? `${API_BASE}/activity/${encodeURIComponent(item.id)}` : `${API_BASE}/athlete/${athlete}/events/${encodeURIComponent(item.id)}`;
    return fetch(url, { method: 'DELETE', headers: { Authorization: apiBasicAuth(apiCredentials.apiKey), Accept: 'application/json' }, cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error(`${response.status}`);
      return item;
    });
  }));
  const removed = new Set(results.filter(result => result.status === 'fulfilled').map(result => result.value));
  events = events.filter(item => !removed.has(item));
  localWorkouts = localWorkouts.filter(item => !removed.has(item));
  try { localStorage.setItem(LOCAL_WORKOUTS_KEY, JSON.stringify(localWorkouts)); } catch { /* Storage is optional for this view. */ }
  renderCalendar();
  const failed = results.filter(result => result.status === 'rejected').length;
  setConnectionState(Boolean(apiCredentials), failed ? `Deleted ${removed.size}; ${failed} could not be deleted` : `${removed.size} day entr${removed.size === 1 ? 'y' : 'ies'} deleted`);
}

weeksRoot.addEventListener('click', event => {
  if (suppressCalendarClick) {
    suppressCalendarClick = false;
    return;
  }
  const menuButton = event.target.closest('[data-day-menu]');
  if (menuButton) {
    const menu = menuButton.parentElement.querySelector('.day-menu-popover');
    const opening = menu.hidden;
    closeDayMenus();
    menu.hidden = !opening;
    menuButton.setAttribute('aria-expanded', String(opening));
    if (opening) menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    return;
  }
  const actionButton = event.target.closest('[data-day-action]');
  if (actionButton) {
    const { dayAction: action, dayKey } = actionButton.dataset;
    closeDayMenus();
    if (action === 'add') openWorkoutBuilder(dayKey);
    else if (action === 'copy') copyDayWorkouts(dayKey);
    else if (action === 'cut') copyDayWorkouts(dayKey, true);
    else if (action === 'paste') pasteDayWorkouts(dayKey);
    else if (action === 'delete') deleteDayWorkouts(dayKey);
    return;
  }
  if (!event.target.closest('.day-menu-popover')) closeDayMenus();
  const addButton = event.target.closest('[data-add-workout]');
  if (addButton) {
    openWorkoutBuilder(addButton.dataset.addWorkout);
    return;
  }
  const deleteButton = event.target.closest('[data-calendar-delete]');
  if (deleteButton) {
    const allEvents = JSON.parse(weeksRoot.dataset.events || '[]');
    const selected = allEvents[Number(deleteButton.dataset.calendarDelete)];
    if (!selected) return;
    if (selected._source === 'activity') openActivityDeleteConfirm(selected);
    else deletePlannedWorkout(selected, deleteButton);
    return;
  }
  const card = event.target.closest('[data-event-index]');
  if (!card) return;
  const allEvents = JSON.parse(weeksRoot.dataset.events || '[]');
  const selected = allEvents[Number(card.dataset.eventIndex)];
  if (selected) openWorkout(selected);
});
workoutDialogContent.addEventListener('input', event => {
  if (event.target.matches('[data-edit-duration], [name="simple-duration"]')) event.target.setCustomValidity('');
});
workoutDialogContent.addEventListener('change', event => {
  const input = event.target;
  if (input.matches('[name="type"]')) {
    updateBuilderSportFields();
    return;
  }
  const durationInput = input.closest('[data-edit-duration]');
  const powerInput = input.closest('[data-edit-power]');
  const repeatsInput = input.closest('[data-edit-reps]');
  if (!durationInput && !powerInput && !repeatsInput) return;
  const keepFocus = document.activeElement === input;
  let selector = '';
  if (durationInput || powerInput) {
    const stepIndex = Number((durationInput || powerInput).dataset.editDuration ?? (durationInput || powerInput).dataset.editPower);
    const blockIndex = Number((durationInput || powerInput).dataset.blockIndex);
    const step = builderBlocks[blockIndex]?.steps[stepIndex];
    let value = Number(input.value);
    if (!step) return;
    if (durationInput) {
      const parsedTime = parseInputTime(input.value);
      if (parsedTime === null) {
        input.setCustomValidity('Enter HH:MM:SS or a fast time such as 10s, 1m, or 1.5h.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      step.seconds = Math.max(5, Math.min(36000, Math.round(parsedTime / 5) * 5));
      selector = `[data-edit-duration="${stepIndex}"][data-block-index="${blockIndex}"]`;
    } else {
      if (!Number.isFinite(value)) return;
      step.power = Math.max(0, Math.min(200, Math.round(value)));
      selector = `[data-edit-power="${stepIndex}"][data-block-index="${blockIndex}"]`;
    }
  } else {
    const blockIndex = Number(repeatsInput.dataset.editReps);
    const block = builderBlocks[blockIndex];
    const value = Number(input.value);
    if (!block || !Number.isFinite(value)) return;
    block.reps = Math.max(1, Math.min(20, Math.round(value)));
    selector = `[data-edit-reps="${blockIndex}"]`;
  }
  renderWorkoutBuilderState();
  if (keepFocus) workoutDialogContent.querySelector(selector)?.focus();
});
workoutDialogContent.addEventListener('pointerdown', event => {
  const blockGrip = event.target.closest('[data-chart-block-drag]');
  if (blockGrip) {
    const svg = blockGrip.ownerSVGElement;
    const point = chartPoint(event, svg);
    event.preventDefault();
    activeChartBlockDrag = {
      pointerId: event.pointerId,
      blockId: blockGrip.dataset.chartBlockDrag,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: point.x,
      startY: point.y,
      started: false
    };
    workoutDialogContent.querySelector('#builder-chart-wrap')?.classList.add('is-grabbing-block');
    try { workoutDialogContent.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable in older browsers. */ }
    return;
  }
  const handle = event.target.closest('[data-chart-adjust]');
  if (!handle) return;
  const svg = handle.ownerSVGElement;
  const point = chartPoint(event, svg);
  const step = builderStepFor(handle.dataset.blockId, handle.dataset.stepIndex);
  if (!step) return;
  event.preventDefault();
  handle.focus();
  activeChartAdjustment = {
    pointerId: event.pointerId,
    blockId: handle.dataset.blockId,
    stepIndex: Number(handle.dataset.stepIndex),
    mode: handle.dataset.chartAdjust,
    startX: point.x,
    startY: point.y,
    initialValue: handle.dataset.chartAdjust === 'power' ? step.power : step.seconds,
    scaleSeconds: Number(svg.dataset.scaleSeconds),
    powerMax: Number(svg.dataset.powerMax)
  };
  try { workoutDialogContent.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable in older browsers. */ }
});
workoutDialogContent.addEventListener('pointermove', event => {
  const blockDrag = activeChartBlockDrag;
  if (blockDrag && blockDrag.pointerId === event.pointerId) {
    if (!blockDrag.started && Math.hypot(event.clientX - blockDrag.startClientX, event.clientY - blockDrag.startClientY) >= 5) {
      blockDrag.started = true;
      workoutDialogContent.querySelector('#builder-chart-wrap')?.classList.add('is-moving-block');
    }
    return;
  }
  const drag = activeChartAdjustment;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const svg = workoutDialogContent.querySelector('.builder-chart');
  if (!svg) return;
  const point = chartPoint(event, svg);
  const { width, height } = CHART_GEOMETRY;
  const value = drag.mode === 'power'
    ? Math.round(drag.initialValue + ((drag.startY - point.y) / height) * drag.powerMax)
    : Math.round((drag.initialValue + ((point.x - drag.startX) / width) * drag.scaleSeconds) / 5) * 5;
  changeBuilderStep(drag.blockId, drag.stepIndex, drag.mode, value);
});
const finishChartAdjustment = event => {
  if (activeChartBlockDrag?.pointerId === event.pointerId) {
    const drag = activeChartBlockDrag;
    activeChartBlockDrag = null;
    const chartWrap = workoutDialogContent.querySelector('#builder-chart-wrap');
    chartWrap?.classList.remove('is-grabbing-block', 'is-moving-block');
    if (drag.started && chartWrap) {
      const from = builderBlocks.findIndex(block => block.id === drag.blockId);
      let to = chartDropInsertionIndex(event, chartWrap);
      if (from >= 0) {
        const [block] = builderBlocks.splice(from, 1);
        if (from < to) to -= 1;
        to = Math.max(0, Math.min(builderBlocks.length, to));
        builderBlocks.splice(to, 0, block);
        renderWorkoutBuilderState();
      }
    }
    try { workoutDialogContent.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    return;
  }
  if (!activeChartAdjustment || activeChartAdjustment.pointerId !== event.pointerId) return;
  activeChartAdjustment = null;
  try { workoutDialogContent.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
  renderWorkoutBuilderState();
};
workoutDialogContent.addEventListener('pointerup', finishChartAdjustment);
workoutDialogContent.addEventListener('pointercancel', finishChartAdjustment);
workoutDialogContent.addEventListener('keydown', event => {
  const repeatControl = event.target.closest('.chart-repeat-button');
  if (repeatControl && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    const block = builderBlocks.find(item => item.id === repeatControl.dataset.blockId);
    if (block) block.reps = Math.max(1, Math.min(20, block.reps + Number(repeatControl.dataset.adjustReps)));
    renderWorkoutBuilderState();
    workoutDialogContent.querySelector(`.chart-repeat-button[data-block-id="${repeatControl.dataset.blockId}"][data-adjust-reps="${repeatControl.dataset.adjustReps}"]`)?.focus();
    return;
  }
  const blockHandle = event.target.closest('[data-chart-block-drag]');
  if (blockHandle && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const from = builderBlocks.findIndex(block => block.id === blockHandle.dataset.chartBlockDrag);
    const to = from + (event.key === 'ArrowLeft' ? -1 : 1);
    if (from < 0 || to < 0 || to >= builderBlocks.length) return;
    event.preventDefault();
    [builderBlocks[from], builderBlocks[to]] = [builderBlocks[to], builderBlocks[from]];
    renderWorkoutBuilderState();
    workoutDialogContent.querySelector(`.chart-block-grip[data-chart-block-drag="${blockHandle.dataset.chartBlockDrag}"]`)?.focus();
    return;
  }
  const handle = event.target.closest('[data-chart-adjust]');
  if (!handle) return;
  const mode = handle.dataset.chartAdjust;
  const step = builderStepFor(handle.dataset.blockId, handle.dataset.stepIndex);
  if (!step) return;
  let value;
  if (mode === 'power' && event.key === 'ArrowUp') value = step.power + 1;
  else if (mode === 'power' && event.key === 'ArrowDown') value = step.power - 1;
  else if (mode === 'duration' && event.key === 'ArrowRight') value = step.seconds + 5;
  else if (mode === 'duration' && event.key === 'ArrowLeft') value = step.seconds - 5;
  else return;
  event.preventDefault();
  const blockId = handle.dataset.blockId;
  const stepIndex = handle.dataset.stepIndex;
  changeBuilderStep(blockId, stepIndex, mode, value);
  workoutDialogContent.querySelector(`[data-chart-adjust="${mode}"][data-block-id="${blockId}"][data-step-index="${stepIndex}"]`)?.focus();
});
workoutDialogContent.addEventListener('click', event => {
  const editActivityButton = event.target.closest('[data-edit-activity]');
  if (editActivityButton) {
    const selected = events.find(item => item._source === 'activity' && String(item.id) === editActivityButton.dataset.editActivity);
    if (selected) openActivityNameEditor(selected);
    return;
  }
  const deleteActivityButton = event.target.closest('[data-delete-activity]');
  if (deleteActivityButton) {
    const selected = events.find(item => item._source === 'activity' && String(item.id) === deleteActivityButton.dataset.deleteActivity);
    if (selected) openActivityDeleteConfirm(selected);
    return;
  }
  if (event.target.closest('[data-cancel-activity-delete]')) {
    deletingActivity = null;
    workoutDialog.close();
    return;
  }
  const confirmActivityDelete = event.target.closest('[data-confirm-delete-activity]');
  if (confirmActivityDelete && deletingActivity) {
    deleteCompletedActivity(deletingActivity, confirmActivityDelete);
    return;
  }
  const editEventButton = event.target.closest('[data-edit-event]');
  if (editEventButton) {
    const selected = events.find(item => String(item.id) === editEventButton.dataset.editEvent);
    if (selected) openWorkoutBuilder(selected.start_date_local, selected);
    return;
  }
  const deleteEventButton = event.target.closest('[data-delete-event]');
  if (deleteEventButton) {
    const selected = events.find(item => String(item.id) === deleteEventButton.dataset.deleteEvent);
    if (selected) deletePlannedWorkout(selected, deleteEventButton);
    return;
  }
  const addButton = event.target.closest('[data-add-block]');
  if (addButton) {
    const block = cloneBlockPreset(addButton.dataset.addBlock);
    if (block) builderBlocks.push(block);
    renderWorkoutBuilderState();
    return;
  }
  const removeButton = event.target.closest('[data-remove-block]');
  if (removeButton) {
    builderBlocks.splice(Number(removeButton.dataset.removeBlock), 1);
    renderWorkoutBuilderState();
    return;
  }
  const repeatButton = event.target.closest('[data-adjust-reps]');
  if (repeatButton) {
    const block = repeatButton.dataset.blockId
      ? builderBlocks.find(item => item.id === repeatButton.dataset.blockId)
      : builderBlocks[Number(repeatButton.dataset.blockIndex)];
    if (block) block.reps = Math.max(1, Math.min(20, block.reps + Number(repeatButton.dataset.adjustReps)));
    renderWorkoutBuilderState();
    return;
  }
  const moveButton = event.target.closest('[data-move-block]');
  if (moveButton && !moveButton.disabled) {
    const currentIndex = Number(moveButton.closest('.builder-block-controls').querySelector('[data-remove-block]').dataset.removeBlock);
    const nextIndex = Number(moveButton.dataset.moveBlock);
    if (nextIndex >= 0 && nextIndex < builderBlocks.length) {
      [builderBlocks[currentIndex], builderBlocks[nextIndex]] = [builderBlocks[nextIndex], builderBlocks[currentIndex]];
      renderWorkoutBuilderState();
    }
  }
});

workoutDialogContent.addEventListener('dragstart', event => {
  const presetButton = event.target.closest('[data-add-block]');
  const blockDragHandle = event.target.closest('[data-block-drag]');
  const blockRow = event.target.closest('.builder-block[draggable="true"]');
  const canDragWholeBlock = blockRow && (!event.target.closest('button, input') || blockDragHandle);
  if (!presetButton && !blockDragHandle && !canDragWholeBlock) return;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  if (presetButton) {
    transfer.setData('application/x-stride-preset', presetButton.dataset.addBlock);
    transfer.setData('text/plain', `preset:${presetButton.dataset.addBlock}`);
    transfer.effectAllowed = 'copy';
  } else {
    transfer.setData('application/x-stride-block', blockRow.dataset.blockId);
    transfer.setData('text/plain', `block:${blockRow.dataset.blockId}`);
    transfer.effectAllowed = 'move';
    blockRow.classList.add('dragging');
  }
});

workoutDialogContent.addEventListener('dragover', event => {
  const dropZone = event.target.closest('#builder-block-list, #builder-chart-wrap');
  if (!dropZone) return;
  event.preventDefault();
  if (event.dataTransfer) {
    const draggingBlock = Array.from(event.dataTransfer.types || []).includes('application/x-stride-block');
    event.dataTransfer.dropEffect = draggingBlock ? 'move' : 'copy';
  }
  dropZone.classList.add('is-drop-target');
  const hoveredBlock = event.target.closest('.builder-block');
  workoutDialogContent.querySelectorAll('.builder-block.drag-over-before, .builder-block.drag-over-after').forEach(row => row.classList.remove('drag-over-before', 'drag-over-after'));
  if (hoveredBlock) hoveredBlock.classList.add(event.clientY < hoveredBlock.getBoundingClientRect().top + hoveredBlock.offsetHeight / 2 ? 'drag-over-before' : 'drag-over-after');
});

workoutDialogContent.addEventListener('dragleave', event => {
  const dropZone = event.target.closest('#builder-block-list, #builder-chart-wrap');
  if (dropZone && !dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-drop-target');
});

workoutDialogContent.addEventListener('drop', event => {
  const dropZone = event.target.closest('#builder-block-list, #builder-chart-wrap');
  if (!dropZone || !event.dataTransfer) return;
  event.preventDefault();
  const transfer = event.dataTransfer;
  const presetKey = transfer.getData('application/x-stride-preset') || transfer.getData('text/plain').replace(/^preset:/, '');
  const blockId = transfer.getData('application/x-stride-block') || (transfer.getData('text/plain').startsWith('block:') ? transfer.getData('text/plain').slice(6) : '');
  const list = workoutDialogContent.querySelector('#builder-block-list');
  const rows = [...list.querySelectorAll('.builder-block')];
  const hoveredBlock = event.target.closest('.builder-block');
  let insertAt = rows.length;
  if (dropZone === list && hoveredBlock) {
    const rowIndex = rows.indexOf(hoveredBlock);
    insertAt = rowIndex + (event.clientY >= hoveredBlock.getBoundingClientRect().top + hoveredBlock.offsetHeight / 2 ? 1 : 0);
  } else if (dropZone.id === 'builder-chart-wrap') {
    insertAt = chartDropInsertionIndex(event, dropZone);
  }
  if (presetKey && presetKey !== transfer.getData('text/plain')) {
    const block = cloneBlockPreset(presetKey);
    if (block) builderBlocks.splice(insertAt, 0, block);
  } else if (blockId) {
    const currentIndex = builderBlocks.findIndex(block => block.id === blockId);
    if (currentIndex >= 0) {
      const [block] = builderBlocks.splice(currentIndex, 1);
      if (currentIndex < insertAt) insertAt -= 1;
      builderBlocks.splice(Math.max(0, Math.min(insertAt, builderBlocks.length)), 0, block);
    }
  }
  workoutDialogContent.querySelectorAll('.is-drop-target, .dragging, .drag-over-before, .drag-over-after').forEach(element => element.classList.remove('is-drop-target', 'dragging', 'drag-over-before', 'drag-over-after'));
  renderWorkoutBuilderState();
});

workoutDialogContent.addEventListener('dragend', () => {
  workoutDialogContent.querySelectorAll('.is-drop-target, .dragging, .drag-over-before, .drag-over-after').forEach(element => element.classList.remove('is-drop-target', 'dragging', 'drag-over-before', 'drag-over-after'));
});

workoutDialogContent.addEventListener('submit', async event => {
  if (event.target.id === 'activity-name-form') {
    event.preventDefault();
    if (editingActivity) {
      const formData = new FormData(event.target);
      await saveActivityName(editingActivity, String(formData.get('name') || ''), event.target.querySelector('[type="submit"]'));
    }
    return;
  }
  if (event.target.id !== 'workout-builder-form') return;
  event.preventDefault();
  const formData = new FormData(event.target);
  const selectedWorkoutType = String(formData.get('type'));
  const isStrength = isStrengthType(selectedWorkoutType);
  const workoutType = isStrength ? 'WeightTraining' : selectedWorkoutType;
  const basicMode = Boolean(editingEvent) || workoutType === 'Run' || isStrength;
  const simpleDurationText = String(formData.get('simple-duration') || '').trim();
  const simpleDuration = basicMode && simpleDurationText ? parseInputTime(simpleDurationText) : null;
  const durationSeconds = basicMode ? (simpleDuration || 0) : builderTotalDuration();
  const distanceKm = Number(formData.get('distance'));
  const hasDistance = Number.isFinite(distanceKm) && distanceKm > 0 && (editingEvent ? !isStrength : workoutType === 'Run');
  const date = String(formData.get('date'));
  const message = workoutDialogContent.querySelector('#builder-message');
  const saveButton = workoutDialogContent.querySelector('.builder-save');
  if (!apiCredentials) {
    message.textContent = 'Connect your Intervals.icu account before creating this workout.';
    message.classList.add('error');
    return;
  }
  if (basicMode && simpleDurationText && simpleDuration === null) {
    const durationInput = workoutDialogContent.querySelector('[name="simple-duration"]');
    durationInput.setCustomValidity('Enter HH:MM:SS or a fast time such as 10s, 1m, or 1.5h.');
    durationInput.reportValidity();
    return;
  }
  if (workoutType === 'Run' && !hasDistance && simpleDuration === null) {
    message.textContent = 'Enter a running distance, a time, or both.';
    message.classList.add('error');
    return;
  }
  if (isStrength && simpleDuration === null) {
    const durationInput = workoutDialogContent.querySelector('[name="simple-duration"]');
    durationInput.setCustomValidity('Enter a time, such as 45m or 1.5h.');
    durationInput.reportValidity();
    return;
  }
  if (!editingEvent && !basicMode && !builderBlocks.length) {
    message.textContent = 'Add at least one workout block before creating this workout.';
    message.classList.add('error');
    return;
  }
  const athlete = encodeURIComponent(apiCredentials.athleteId || '0');
  const url = editingEvent
    ? `${API_BASE}/athlete/${athlete}/events/${encodeURIComponent(editingEvent.id)}`
    : `${API_BASE}/athlete/${athlete}/events`;
  const workout = {
    category: 'WORKOUT',
    start_date_local: `${date}T00:00:00`,
    type: workoutType,
    name: String(formData.get('name')).trim(),
    ...((editingEvent || basicMode)
      ? (editingEvent ? { description: String(formData.get('description') || '').trim() } : (String(formData.get('description') || '').trim() ? { description: String(formData.get('description') || '').trim() } : {}))
      : (workoutDescriptionFromBlocks(String(formData.get('description') || '')) ? { description: workoutDescriptionFromBlocks(String(formData.get('description') || '')) } : {}))
  };
  if (editingEvent) {
    workout.moving_time = simpleDuration ?? 0;
    workout.distance = hasDistance ? Math.round(distanceKm * 1000) : 0;
  } else {
    if (!basicMode || simpleDuration !== null) workout.moving_time = durationSeconds;
    if (hasDistance) workout.distance = Math.round(distanceKm * 1000);
  }
  saveButton.disabled = true;
  const action = editingEvent ? 'Updating' : 'Creating';
  saveButton.textContent = editingEvent ? 'Saving…' : 'Creating…';
  message.textContent = `${action} workout in Intervals.icu…`;
  message.classList.remove('error');
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(url, {
        method: editingEvent ? 'PUT' : 'POST',
        headers: {
          Authorization: apiBasicAuth(apiCredentials.apiKey),
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(workout),
        signal: controller.signal,
        cache: 'no-store'
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const responseBody = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Intervals.icu rejected this API key or athlete ID. Check your connection settings.');
      if (response.status === 429) throw new Error('Intervals.icu rate limit reached. Wait a little, then try again.');
      let details = '';
      if (response.status === 422 && responseBody.trim()) {
        try {
          const payload = JSON.parse(responseBody);
          details = payload.message || payload.error || JSON.stringify(payload);
        } catch {
          details = responseBody;
        }
        details = String(details).trim().slice(0, 320);
      }
      throw new Error(`Intervals.icu could not ${editingEvent ? 'update' : 'create'} the workout (${response.status})${details ? `: ${details}` : ''}. Your calendar was not changed.`);
    }
    let created = editingEvent ? {
      ...editingEvent,
      ...workout,
      workout_doc: {
        ...(editingEvent.workout_doc || {}),
        duration: workout.moving_time,
        distance: workout.distance
      }
    } : workout;
    if (responseBody.trim()) {
      try {
        const payload = JSON.parse(responseBody);
        if (payload && !Array.isArray(payload) && typeof payload === 'object') {
          created = { ...created, ...payload };
          if (workout.moving_time && !(Number(payload.moving_time) > 0)) created.moving_time = workout.moving_time;
          if (workout.distance && !(Number(payload.distance) > 0)) created.distance = workout.distance;
        }
      } catch {
        // A successful create may return no JSON; the submitted event is enough to refresh the calendar.
      }
    }
    events = events.filter(item => !(item.id && created.id && String(item.id) === String(created.id)));
    events.push({ ...created, _source: 'planned' });
    editingEvent = null;
    renderCalendar();
    setConnectionState(true, 'Intervals.icu');
    workoutDialog.close();
  } catch (error) {
    message.textContent = error.name === 'AbortError'
      ? 'The request timed out. Check Intervals.icu before retrying in case the workout was created.'
      : error instanceof TypeError
        ? 'Could not reach Intervals.icu. Check your connection and try again.'
        : error.message;
    message.classList.add('error');
  } finally {
    if (workoutDialog.open && saveButton.isConnected) {
      saveButton.disabled = false;
      saveButton.textContent = editingEvent ? 'Save changes' : 'Create workout';
    }
  }
});
workoutDialog.addEventListener('click', event => {
  if (event.target === workoutDialog || event.target.closest('[data-close-workout]')) {
    editingActivity = null;
    deletingActivity = null;
    editingEvent = null;
    workoutDialog.close();
  }
});
workoutDialog.addEventListener('close', () => {
  editingActivity = null;
  deletingActivity = null;
  editingEvent = null;
});

events = apiCredentials ? [] : sampleEvents();
renderCalendar();
if (apiCredentials) loadCalendar(apiCredentials);
else setConnectionState(false);
