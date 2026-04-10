/* ============================================
   Scale Picker — script.js
   ============================================ */

'use strict';

// ── Data ──────────────────────────────────────────────────────────────────────

const ROOT_NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Semitone offset from C for each root note
const ROOT_SEMITONE = {
  C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5,
  'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
};

const QUALITIES       = ['Major', 'Minor'];
const CAGED_POSITIONS = ['C', 'A', 'G', 'E', 'D'];

// Scale intervals in semitones from root (7 degrees)
const SCALE_INTERVALS = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
};

// Base MIDI note for each register (octave root)
const REGISTER_MIDI_BASE = {
  'high register': 72,  // C5
  'default':       60,  // C4
  'low register':  48,  // C3
};

// Scale degrees that can start / end a custom order
const CHORD_TONES = [1, 3, 5, 7];

// Human-readable bar count words (index = bar count)
const BAR_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

// ── Scheduler constants ───────────────────────────────────────────────────────

const LOOKAHEAD_S            = 0.12;  // Web Audio look-ahead window (seconds)
const SCHEDULER_INTERVAL_MS  = 25;    // Audio scheduler poll interval
const VISUAL_INTERVAL_MS     = 40;    // Visual tick interval
const BEATS_PER_BAR          = 4;     // 4/4 time
const PLAY_BARS              = 2;     // Default length of the play section (bars)
// Small offset so the first scheduled audio beat is slightly in the future.
// The visual (wall-clock) timer uses the same value so both timelines start together.
const AUDIO_START_OFFSET_MS  = 50;

// ── State ─────────────────────────────────────────────────────────────────────

let currentSelection = null;
let audioCtx         = null;
let scheduledNodes   = [];   // audio nodes queued, for early cancellation

// Global metronome state — runs continuously during a session
const metro = {
  running:       false,
  bpm:           120,
  beatCount:     0,         // next audio beat index to schedule
  nextBeatTime:  0,         // AudioContext time for the next beat
  schedulerTimer: null,
  startWallTime: 0,         // Date.now() when metro started (visual reference)
  visualTimer:   null,
};

// Active session (one press of Play = one session)
const session = {
  state:             'idle',   // 'idle' | 'count-in' | 'playing'
  selection:         null,
  notePitches:       [],
  countInBars:       2,
  countInStart:      0,        // absolute beat where count-in begins
  notePlayBeat:      0,        // absolute beat where the count-in reference note plays
  playStartBeat:     0,        // absolute beat where play section begins
  playEndBeat:       0,        // absolute beat where play section ends
  rootMidi:          60,
  firstNoteMidi:     60,
  chordMidis:        [],
  chordMidisDefault: [],       // chord using default (C4) register, for 'chord' playback mode
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ── Scale Order Generator ─────────────────────────────────────────────────────

function generateScaleOrder() {
  const startEnd = pickRandom(CHORD_TONES);
  const middle   = shuffle([1, 2, 3, 4, 5, 6, 7].filter(n => n !== startEnd));
  return [startEnd, ...middle, startEnd];
}

// ── Core: Generate Selection ──────────────────────────────────────────────────

/**
 * Picks a new random selection and updates currentSelection + DOM.
 * Does NOT stop any running session (call stopSession() first when needed).
 * Returns true on success, false on validation error.
 */
function generateCore() {
  const randomRoot    = document.getElementById('randomRoot').checked;
  const randomQuality = document.getElementById('randomQuality').checked;

  if (!randomRoot && !randomQuality) {
    showError('Please enable randomisation for Root Note or Quality (or both).');
    return false;
  }
  clearError();

  const root      = randomRoot    ? pickRandom(ROOT_NOTES) : document.getElementById('rootNote').value;
  const quality   = randomQuality ? pickRandom(QUALITIES)  : document.getElementById('quality').value;
  const caged     = document.getElementById('enableCaged').checked     ? pickRandom(CAGED_POSITIONS) : null;
  const direction = document.getElementById('enableDirection').checked ? pickRandom(getDirectionPool()) : null;
  const register  = document.getElementById('enableRegister').checked  ? pickRandom(getRegisterPool())  : null;
  const order     = document.getElementById('enableOrder').checked     ? generateScaleOrder()         : null;

  currentSelection = { root, quality, caged, direction, register, order };
  renderOutput();
  document.getElementById('playBtn').disabled = false;
  return true;
}

/** Called by the "Next Scale" button and output-area click. */
function generate() {
  if (session.state !== 'idle') stopSession();
  generateCore();
}

// ── Render: CAGED display ─────────────────────────────────────────────────────

function renderCaged(selected) {
  return CAGED_POSITIONS.map(letter => {
    const cls = letter === selected ? 'caged-letter caged-selected' : 'caged-letter';
    return `<span class="${cls}">${letter}</span>`;
  }).join('');
}

// ── Render: Output area ───────────────────────────────────────────────────────

function renderOutput() {
  if (!currentSelection) return;
  const { root, quality, caged, direction, register, order } = currentSelection;

  const html = [];
  html.push(`<div class="output-line output-root-quality">${escHtml(root)} ${escHtml(quality)}</div>`);
  if (caged)     html.push(`<div class="output-line output-caged-row">${renderCaged(caged)}</div>`);
  if (direction) html.push(`<div class="output-line output-direction-line">${escHtml(direction)}</div>`);
  if (register)  html.push(`<div class="output-line output-register-line">${escHtml(register)}</div>`);
  if (order)     html.push(`<div class="output-line output-order-line">${escHtml(order.join('\u2013'))}</div>`);
  html.push(renderStaffGraphic(currentSelection));

  document.getElementById('output').innerHTML = html.join('');
}

/**
 * Returns an inline SVG string representing a mini music staff that encodes
 * register (coloured region), direction (arrow), and CAGED position at a glance.
 * Only the settings that were actually selected are shown.
 */
function renderStaffGraphic(selection) {
  const { root, quality, caged, direction, register } = selection;

  const w = 240;
  // Height accommodates an extra row for the CAGED label beneath the staff
  const h = caged ? 94 : 76;
  // Staff: 5 lines at these y positions
  const lines = [26, 34, 42, 50, 58];
  const staffTop = lines[0];
  const staffBot = lines[lines.length - 1];
  const midY     = lines[2]; // middle (3rd) line — y=42
  const x1 = 14, x2 = 226;

  const parts = [];

  // Background card
  parts.push(`<rect width="${w}" height="${h}" rx="7" fill="#1a1d27"/>`);

  // Scale name
  parts.push(`<text x="${w / 2}" y="16" text-anchor="middle" ` +
    `font-family="'Segoe UI',system-ui,sans-serif" font-size="14" font-weight="700" fill="#f0f1f6">` +
    `${escHtml(root)} ${escHtml(quality)}</text>`);

  // Register fill region (behind staff lines so lines overlay the fill)
  if (register) {
    let ry, rh, rfill;
    if (register === 'high register') {
      ry = staffTop - 4; rh = midY - staffTop + 4;
      rfill = 'rgba(108,99,255,0.38)';
    } else if (register === 'low register') {
      ry = midY; rh = staffBot - midY + 4;
      rfill = 'rgba(245,166,35,0.38)';
    } else { // both registers
      ry = staffTop - 4; rh = staffBot - staffTop + 8;
      rfill = 'rgba(74,222,128,0.25)';
    }
    parts.push(`<rect x="${x1}" y="${ry}" width="${x2 - x1}" height="${rh}" rx="3" fill="${rfill}"/>`);
  }

  // Staff lines
  lines.forEach(y => {
    parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="rgba(124,130,160,0.65)" stroke-width="1.5"/>`);
  });

  // Direction arrow — centred vertically in the staff area
  if (direction) {
    let sym = direction === 'ascending' ? '↑' : direction === 'descending' ? '↓' : '↕';
    const arrowY = Math.round((staffTop + staffBot) / 2) + 7; // +7 aligns text baseline to visual centre
    parts.push(`<text x="${w / 2}" y="${arrowY}" text-anchor="middle" ` +
      `font-family="'Segoe UI',system-ui,sans-serif" font-size="22" font-weight="700" fill="#f0f1f6" opacity="0.88">` +
      `${sym}</text>`);
  }

  // CAGED shape label below the staff
  if (caged) {
    parts.push(`<text x="${w / 2}" y="${staffBot + 20}" text-anchor="middle" ` +
      `font-family="'Segoe UI',system-ui,sans-serif" font-size="12" font-weight="600" fill="#f5a623">` +
      `${escHtml(caged)}-shape</text>`);
  }

  return `<div class="output-line scale-staff-wrap">` +
    `<svg class="scale-staff" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    parts.join('') +
    `</svg></div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Audio Context ─────────────────────────────────────────────────────────────

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// ── Note Sequence Builder ─────────────────────────────────────────────────────

function buildNoteSequence(selection) {
  const { root, quality, direction, register, order } = selection;
  const semitone = ROOT_SEMITONE[root] ?? 0;
  const ivs      = SCALE_INTERVALS[quality] ?? SCALE_INTERVALS.Major;

  // Determine which register base(s) to use
  const bases = register === 'both registers'
    ? [REGISTER_MIDI_BASE['low register'] + semitone, REGISTER_MIDI_BASE['high register'] + semitone]
    : [(REGISTER_MIDI_BASE[register] ?? REGISTER_MIDI_BASE['default']) + semitone];

  if (order) {
    // Custom order always uses the first (lowest) base
    return order.map(degree => {
      const idx = Math.min(Math.max(degree - 1, 0), 6);
      return bases[0] + ivs[idx];
    });
  }

  function scaleForBase(base) {
    const ascending = [...ivs.map(i => base + i), base + 12];
    if (direction === 'descending') return ascending.slice().reverse();
    if (direction === 'ascending + descending') {
      // Go up the scale, then back down — octave is the shared turning point
      return [...ascending, ...ascending.slice(0, -1).reverse()];
    }
    return ascending;
  }

  return bases.flatMap(base => scaleForBase(base));
}

// ── Audio: Schedule helpers ───────────────────────────────────────────────────

function scheduleNote(midi, startTime, duration, amplitude = 0.35) {
  const ctx  = getAudioContext();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'triangle';
  osc.frequency.value = midiToHz(midi);

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(amplitude, startTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(amplitude * 0.4, startTime + 0.12);
  gain.gain.setValueAtTime(amplitude * 0.4, startTime + duration - 0.04);
  gain.gain.linearRampToValueAtTime(0.0001, startTime + duration + 0.04);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.06);
  scheduledNodes.push({ osc, gain });
}

function scheduleClick(time, isDownbeat) {
  const ctx  = getAudioContext();
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = isDownbeat ? 1000 : 800;

  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(isDownbeat ? 0.35 : 0.2, time + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

  osc.start(time);
  osc.stop(time + 0.08);
  scheduledNodes.push({ osc, gain });
}

function cancelAllNodes() {
  const now = audioCtx ? audioCtx.currentTime : 0;
  scheduledNodes.forEach(({ osc, gain }) => {
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
      osc.stop(now + 0.015);
    } catch (_) { /* already stopped */ }
  });
  scheduledNodes = [];
}

// ── Metronome Scheduler ───────────────────────────────────────────────────────

function beatDuration() {
  return 60 / metro.bpm;
}

function startMetronome() {
  if (metro.running) return;
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  metro.running       = true;
  metro.bpm           = Math.max(20, Math.min(300, parseInt(document.getElementById('bpm').value, 10) || 120));
  metro.beatCount     = 0;
  metro.nextBeatTime  = ctx.currentTime + AUDIO_START_OFFSET_MS / 1000;
  metro.startWallTime = Date.now() + AUDIO_START_OFFSET_MS;

  metro.schedulerTimer = setInterval(runScheduler, SCHEDULER_INTERVAL_MS);
  metro.visualTimer    = setInterval(runVisualTick, VISUAL_INTERVAL_MS);
}

function stopMetronome() {
  if (!metro.running) return;
  metro.running = false;
  clearInterval(metro.schedulerTimer);
  clearInterval(metro.visualTimer);
  metro.schedulerTimer = null;
  metro.visualTimer    = null;
}

/** Audio scheduler: called every SCHEDULER_INTERVAL_MS. */
function runScheduler() {
  const ctx   = getAudioContext();
  const until = ctx.currentTime + LOOKAHEAD_S;
  while (metro.nextBeatTime < until) {
    onAudioBeat(metro.beatCount, metro.nextBeatTime);
    metro.beatCount++;
    metro.nextBeatTime += beatDuration();
  }
}

/**
 * Called once per audio beat.  Schedules the metronome click and any
 * session-specific notes for this beat.
 */
function onAudioBeat(beat, time) {
  const mode = getPlayMode();

  // In the last count-in bar every beat is a high (downbeat) click so the
  // player can clearly distinguish it from the preceding count-in bars.
  const inLastCountInBar = session.state === 'count-in' &&
    beat >= (session.playStartBeat - BEATS_PER_BAR) &&
    beat < session.playStartBeat;
  const isDownbeat = inLastCountInBar || (beat % BEATS_PER_BAR) === 0;

  // Metronome click (audio and both modes)
  if (mode === 'audio' || mode === 'both') {
    scheduleClick(time, isDownbeat);
  }

  // Session notes
  if (session.state !== 'idle') {
    scheduleSessionAudio(beat, time);
  }
}

/** Schedule any note(s) for this beat that belong to the active session. */
function scheduleSessionAudio(beat, time) {
  const mode = getPlayMode();
  if (mode === 'visual') return; // no audio notes in visual-only mode

  const bd = beatDuration();

  // Count-in reference note — played on the first beat of the LAST count-in bar
  if (beat === session.notePlayBeat) {
    const noteMode = getCountInNoteMode();
    if (noteMode === 'root')        scheduleNote(session.rootMidi,      time, bd * 1.5);
    else if (noteMode === 'first')  scheduleNote(session.firstNoteMidi, time, bd * 1.5);
  }

  // Play section
  if (beat >= session.playStartBeat && beat < session.playEndBeat) {
    const rel      = beat - session.playStartBeat;
    const playMode = getPlayNoteMode();

    if (playMode === 'scale') {
      if (rel < session.notePitches.length) {
        scheduleNote(session.notePitches[rel], time, bd * 0.88);
      }
    } else if (playMode === 'root' && rel % BEATS_PER_BAR === 0) {
      scheduleNote(session.rootMidi,      time, bd * 3.5);
    } else if (playMode === 'first' && rel % BEATS_PER_BAR === 0) {
      scheduleNote(session.firstNoteMidi, time, bd * 3.5);
    } else if (playMode === 'chord' && beat === session.playStartBeat) {
      // Play chord once at the start of the play section for its full duration,
      // using register-independent (default octave) MIDI values.
      const chordDuration = (session.playEndBeat - session.playStartBeat) * bd - 0.05;
      session.chordMidisDefault.forEach(m => scheduleNote(m, time, chordDuration, 0.2));
    }
  }
}

// ── Visual Ticker ─────────────────────────────────────────────────────────────

/** Returns the current visual beat (wall-clock based, independent of audio). */
function getVisualBeat() {
  const elapsed = Date.now() - metro.startWallTime;
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / (beatDuration() * 1000));
}

/** Called every VISUAL_INTERVAL_MS to drive the count-in / play display. */
function runVisualTick() {
  if (session.state === 'idle') return;

  const beat = getVisualBeat();

  // State transitions
  if (session.state === 'count-in' && beat >= session.playStartBeat) {
    session.state = 'playing';
  }
  if (session.state === 'playing' && beat >= session.playEndBeat) {
    onPlayEnd();
    return;
  }

  updateCountInDisplay(beat);
}

/** Renders the count-in label and beat dots. */
function updateCountInDisplay(beat) {
  const display = document.getElementById('countin-display');
  const label   = document.getElementById('countin-label');
  const dotsEl  = document.getElementById('beat-dots');
  const mode    = getPlayMode();

  if (session.state === 'idle') { display.hidden = true; return; }
  display.hidden = false;

  const beatInBar = beat % BEATS_PER_BAR;
  const curBar    = Math.floor(beat / BEATS_PER_BAR);
  const playBar   = session.playStartBeat / BEATS_PER_BAR; // always a whole number
  const barsLeft  = playBar - curBar; // bars remaining until play section

  // ── Beat dots — only shown in visual mode ──
  const showDots = (mode === 'visual');
  dotsEl.hidden = !showDots;
  if (showDots) {
    const isPlay = (session.state === 'playing');
    dotsEl.querySelectorAll('.beat-dot').forEach((dot, i) => {
      dot.classList.toggle('active',     i === beatInBar);
      dot.classList.toggle('is-playing', i === beatInBar && isPlay);
    });
  }

  // ── During play section ──
  if (session.state === 'playing') {
    if (mode === 'audio') { display.hidden = true; return; }
    label.textContent   = 'Play';
    label.className     = 'countin-label state-playing';
    label.style.opacity = '1';
    return;
  }

  // ── During count-in: before the count-in window starts (brief gap on auto-advance) ──
  if (beat < session.countInStart) {
    label.textContent = '';
    return;
  }

  // ── Audio mode: "Ready" fading on the last count-in bar ──
  if (mode === 'audio') {
    label.className   = 'countin-label state-ready';
    label.textContent = 'Ready';
    if (barsLeft <= 1) {
      const barDurMs   = BEATS_PER_BAR * beatDuration() * 1000;
      const elapsed    = Date.now() - metro.startWallTime;
      const progressInBar = (elapsed % barDurMs) / barDurMs;
      label.style.opacity = Math.max(0, 1 - progressInBar).toFixed(3);
    } else {
      label.style.opacity = '1';
    }
    return;
  }

  // ── Visual / Both mode: bar countdown ──
  label.style.opacity = '1';
  if (barsLeft <= 1) {
    label.textContent = 'Get Ready';
    label.className   = 'countin-label state-getready';
  } else {
    const word = BAR_WORDS[barsLeft] ?? String(barsLeft);
    label.textContent = `${word} bar${barsLeft !== 1 ? 's' : ''} left`;
    label.className   = 'countin-label state-countdown';
  }
}

/** Returns the next bar boundary at or after the given absolute beat index. */
function nextBarBoundary(beat) {
  return Math.ceil(beat / BEATS_PER_BAR) * BEATS_PER_BAR;
}

/**
 * Starts a new playback session for the given selection.
 * beatOffset = the audio beat at which count-in should begin (0 for fresh start,
 * or metro.beatCount aligned to next bar for auto-advance).
 */
function startSession(selection, beatOffset) {
  const cib   = getCountInBars();
  const notes = buildNoteSequence(selection);

  const { root, quality, register } = selection;
  const semitone = ROOT_SEMITONE[root] ?? 0;
  // For 'both registers', use the low register as the reference for count-in / chord
  const base     = register === 'both registers'
    ? REGISTER_MIDI_BASE['low register'] + semitone
    : (REGISTER_MIDI_BASE[register] ?? REGISTER_MIDI_BASE['default']) + semitone;
  const ivs      = SCALE_INTERVALS[quality] ?? SCALE_INTERVALS.Major;

  const countInStart  = beatOffset;
  // The reference note plays on the first beat of the LAST count-in bar.
  const notePlayBeat  = countInStart + Math.max(0, cib - 1) * BEATS_PER_BAR;
  const playStartBeat = countInStart + cib * BEATS_PER_BAR;
  const playEndBeat   = playStartBeat + Math.max(PLAY_BARS * BEATS_PER_BAR, notes.length);

  // Default-octave chord (register-independent) for 'chord' play mode
  const defaultBase = REGISTER_MIDI_BASE['default'] + semitone;

  session.state             = 'count-in';
  session.selection         = selection;
  session.notePitches       = notes;
  session.countInBars       = cib;
  session.countInStart      = countInStart;
  session.notePlayBeat      = notePlayBeat;
  session.playStartBeat     = playStartBeat;
  session.playEndBeat       = playEndBeat;
  session.rootMidi          = base + ivs[0];
  session.firstNoteMidi     = notes[0] ?? (base + ivs[0]);
  session.chordMidis        = [base + ivs[0], base + ivs[2], base + ivs[4]];
  session.chordMidisDefault = [defaultBase + ivs[0], defaultBase + ivs[2], defaultBase + ivs[4]];

  if (!metro.running) startMetronome();
}

/** Called when the user presses Play (or Space). */
function triggerPlay() {
  if (!currentSelection) return;

  // Toggle: if already playing, stop
  if (session.state !== 'idle') {
    stopSession();
    return;
  }

  startSession(currentSelection, 0);
  updatePlayBtn(true);
}

/**
 * Called at the end of the play section.
 * If auto-advance is on, generates next scale and continues seamlessly.
 */
function onPlayEnd() {
  if (!document.getElementById('autoAdvance').checked) {
    stopSession();
    return;
  }

  // Generate the next scale without stopping the metronome
  const ok = generateCore();
  if (!ok) { stopSession(); return; }

  // Start the new count-in from the CURRENT bar boundary so the bar already
  // in progress becomes count-in bar 1 — no extra waiting bar is inserted.
  const currentBarStart = Math.floor(metro.beatCount / BEATS_PER_BAR) * BEATS_PER_BAR;
  startSession(currentSelection, currentBarStart);
}

/** Stops playback, cancels audio, hides the display. */
function stopSession() {
  session.state = 'idle';
  cancelAllNodes();
  stopMetronome();
  const display = document.getElementById('countin-display');
  if (display) display.hidden = true;
  updatePlayBtn(false);
}

// ── Button State ──────────────────────────────────────────────────────────────

function updatePlayBtn(playing) {
  const btn = document.getElementById('playBtn');
  btn.textContent = playing ? '⏹ Stop' : '▶ Play';
  btn.classList.toggle('playing', playing);
}

// ── Settings Accessors ────────────────────────────────────────────────────────

function getPlayMode()        { return document.getElementById('playMode').value; }
function getCountInBars()     { return parseInt(document.getElementById('countInBars').value, 10) || 2; }
function getCountInNoteMode() { return document.getElementById('countInNote').value; }
function getPlayNoteMode()    { return document.getElementById('playNote').value; }

/** Returns the subset of direction values the user has checked as options. */
function getDirectionPool() {
  const pool = [];
  if (document.getElementById('dirAsc').checked)  pool.push('ascending');
  if (document.getElementById('dirDesc').checked) pool.push('descending');
  if (document.getElementById('dirBoth').checked) pool.push('ascending + descending');
  return pool.length ? pool : ['ascending']; // always return at least one value
}

/** Returns the subset of register values the user has checked as options. */
function getRegisterPool() {
  const pool = [];
  if (document.getElementById('regHigh').checked) pool.push('high register');
  if (document.getElementById('regLow').checked)  pool.push('low register');
  if (document.getElementById('regBoth').checked) pool.push('both registers');
  return pool.length ? pool : ['high register']; // always return at least one value
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.hidden = false;
}

function clearError() {
  const el = document.getElementById('error-msg');
  el.hidden = true;
  el.textContent = '';
}

// ── Hamburger / Mobile drawer ─────────────────────────────────────────────────

function openSettings() {
  const panel   = document.getElementById('settings-panel');
  const overlay = document.getElementById('settings-overlay');
  const btn     = document.getElementById('hamburger');
  panel.classList.add('open');
  overlay.classList.add('visible');
  btn.textContent = '✕';
  btn.setAttribute('aria-expanded', 'true');
}

function closeSettings() {
  const panel   = document.getElementById('settings-panel');
  const overlay = document.getElementById('settings-overlay');
  const btn     = document.getElementById('hamburger');
  panel.classList.remove('open');
  overlay.classList.remove('visible');
  btn.textContent = '☰';
  btn.setAttribute('aria-expanded', 'false');
}

// ── Event wiring ──────────────────────────────────────────────────────────────

// Randomise checkboxes → enable / disable the matching dropdown
document.getElementById('randomRoot').addEventListener('change', function () {
  document.getElementById('rootNote').disabled = this.checked;
});
document.getElementById('randomQuality').addEventListener('change', function () {
  document.getElementById('quality').disabled = this.checked;
});

// Direction / Register enable → toggle chip group opacity
document.getElementById('enableDirection').addEventListener('change', function () {
  document.getElementById('directionOptions').classList.toggle('disabled', !this.checked);
});
document.getElementById('enableRegister').addEventListener('change', function () {
  document.getElementById('registerOptions').classList.toggle('disabled', !this.checked);
});

// Next Scale button
document.getElementById('generateBtn').addEventListener('click', generate);

// Play / Stop button
document.getElementById('playBtn').addEventListener('click', () => {
  if (session.state !== 'idle') {
    stopSession();
  } else {
    triggerPlay();
  }
});

// Output area tap → generate
document.getElementById('output-area').addEventListener('click', generate);

// Keyboard: Enter → Next Scale, Space → Play/Stop
document.addEventListener('keydown', e => {
  const tag     = e.target.tagName;
  const inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA';

  if (e.code === 'Enter' && !inInput) {
    e.preventDefault();
    generate();
  }

  if (e.code === 'Space' && !inInput) {
    e.preventDefault();
    if (session.state !== 'idle') {
      stopSession();
    } else {
      triggerPlay();
    }
  }
});

// Hamburger
document.getElementById('hamburger').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  if (panel.classList.contains('open')) {
    closeSettings();
  } else {
    openSettings();
  }
});

// Close drawer when clicking the overlay
document.getElementById('settings-overlay').addEventListener('click', closeSettings);

// Auto-advance toggle → start playing immediately if turned on while idle
document.getElementById('autoAdvance').addEventListener('change', function () {
  if (this.checked && session.state === 'idle') {
    if (!currentSelection) {
      const ok = generateCore();
      if (!ok) return;
    }
    startSession(currentSelection, 0);
    updatePlayBtn(true);
  }
});
