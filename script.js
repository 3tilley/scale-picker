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
const DIRECTIONS      = ['ascending', 'descending'];
const REGISTERS       = ['high register', 'low register'];

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

// ── State ─────────────────────────────────────────────────────────────────────

let currentSelection = null; // Last generated selection
let audioCtx         = null; // Web Audio context (lazy)
let scheduledNodes   = [];   // Oscillators scheduled for current playback
let isPlaying        = false;

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

/**
 * Returns an array like [3, 4, 7, 5, 2, 1, 6, 3].
 * • Starts AND ends on the same chord tone (1, 3, 5, or 7) — the note is repeated.
 * • All seven scale degrees appear exactly once in the sequence.
 * • The 6 remaining degrees fill the middle in random order.
 */
function generateScaleOrder() {
  const startEnd = pickRandom(CHORD_TONES);
  const middle   = shuffle([1, 2, 3, 4, 5, 6, 7].filter(n => n !== startEnd));
  return [startEnd, ...middle, startEnd];
}

// ── Core: Generate Selection ──────────────────────────────────────────────────

function generate() {
  const randomRoot    = document.getElementById('randomRoot').checked;
  const randomQuality = document.getElementById('randomQuality').checked;

  // Validation: at least one of the first two categories must be randomised
  if (!randomRoot && !randomQuality) {
    showError('Please enable randomisation for Root Note or Quality (or both).');
    return;
  }
  clearError();

  const root      = randomRoot    ? pickRandom(ROOT_NOTES) : document.getElementById('rootNote').value;
  const quality   = randomQuality ? pickRandom(QUALITIES)  : document.getElementById('quality').value;
  const caged     = document.getElementById('enableCaged').checked     ? pickRandom(CAGED_POSITIONS) : null;
  const direction = document.getElementById('enableDirection').checked ? pickRandom(DIRECTIONS)      : null;
  const register  = document.getElementById('enableRegister').checked  ? pickRandom(REGISTERS)       : null;
  const order     = document.getElementById('enableOrder').checked     ? generateScaleOrder()         : null;

  currentSelection = { root, quality, caged, direction, register, order };
  renderOutput();

  document.getElementById('playBtn').disabled = false;
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

  // Line 1 — root + quality (always present)
  html.push(`<div class="output-line output-root-quality">${escHtml(root)} ${escHtml(quality)}</div>`);

  // Line 2 — CAGED position
  if (caged) {
    html.push(
      `<div class="output-line output-caged-row">${renderCaged(caged)}</div>`
    );
  }

  // Line 3 — direction
  if (direction) {
    html.push(`<div class="output-line output-direction-line">${escHtml(direction)}</div>`);
  }

  // Line 4 — register
  if (register) {
    html.push(`<div class="output-line output-register-line">${escHtml(register)}</div>`);
  }

  // Line 5 — scale order (bottom)
  if (order) {
    html.push(`<div class="output-line output-order-line">${escHtml(order.join('\u2013'))}</div>`);
  }

  document.getElementById('output').innerHTML = html.join('');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Audio: Play Scale ─────────────────────────────────────────────────────────

/**
 * Build the list of MIDI notes to play.
 * • If a custom order (cat 6) is active, map degree numbers to MIDI.
 * • Otherwise play the 8-note diatonic scale (7 degrees + octave).
 * • Ascending / descending only applies when there is no custom order.
 */
function buildNoteSequence(selection) {
  const { root, quality, direction, register, order } = selection;

  const semitone = ROOT_SEMITONE[root] ?? 0;
  const base     = (REGISTER_MIDI_BASE[register] ?? REGISTER_MIDI_BASE['default']) + semitone;
  const ivs      = SCALE_INTERVALS[quality] ?? SCALE_INTERVALS.Major;

  if (order) {
    // Degree 1-7 → interval index 0-6; clamp defensively against out-of-range values
    return order.map(degree => {
      const idx = Math.min(Math.max(degree - 1, 0), 6);
      return base + ivs[idx];
    });
  }

  // 8-note ascending scale (include octave)
  const ascending = [...ivs.map(i => base + i), base + 12];
  return direction === 'descending' ? ascending.reverse() : ascending;
}

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playScale() {
  if (!currentSelection || isPlaying) return;

  const ctx   = getAudioContext();
  const bpm   = Math.max(20, Math.min(300, parseInt(document.getElementById('bpm').value, 10) || 60));
  const beatS = (60 / bpm) / 2; // eighth-note duration in seconds

  const notes = buildNoteSequence(currentSelection);

  // Resume context if suspended (required after user gesture on some browsers)
  const doPlay = () => {
    isPlaying = true;
    updatePlayBtn(true);
    scheduledNodes = [];

    const now = ctx.currentTime + 0.05;

    notes.forEach((midi, i) => {
      const freq      = midiToHz(midi);
      const noteStart = now + i * beatS;
      const noteEnd   = noteStart + beatS * 0.88;

      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, noteStart);

      // ADSR envelope: quick attack → decay → sustain → release
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(0.35, noteStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.14, noteStart + 0.12);
      gain.gain.setValueAtTime(0.14, noteEnd - 0.04);
      gain.gain.linearRampToValueAtTime(0.0001, noteEnd + 0.04);

      osc.start(noteStart);
      osc.stop(noteEnd + 0.06);

      scheduledNodes.push({ osc, gain });
    });

    // Auto-reset after playback completes
    const totalMs = (notes.length * beatS + 0.25) * 1000;
    setTimeout(() => {
      if (isPlaying) stopPlayback();
    }, totalMs);
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(doPlay);
  } else {
    doPlay();
  }
}

function stopPlayback() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  scheduledNodes.forEach(({ osc, gain }) => {
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
      osc.stop(now + 0.02);
    } catch (_) { /* InvalidStateError: oscillator already stopped naturally */ }
  });
  scheduledNodes = [];
  isPlaying = false;
  updatePlayBtn(false);
}

function updatePlayBtn(playing) {
  const btn = document.getElementById('playBtn');
  btn.textContent = playing ? '⏹ Stop' : '▶ Play';
  btn.classList.toggle('playing', playing);
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

// Generate button
document.getElementById('generateBtn').addEventListener('click', generate);

// Play / Stop button
document.getElementById('playBtn').addEventListener('click', () => {
  if (isPlaying) {
    stopPlayback();
  } else {
    playScale();
  }
});

// Output area tap target
document.getElementById('output-area').addEventListener('click', generate);

// Keyboard: Space → generate, Enter on output-area → generate
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'BUTTON') {
    e.preventDefault();
    generate();
  }
  if (e.code === 'Enter' && e.target.id === 'output-area') {
    e.preventDefault();
    generate();
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
