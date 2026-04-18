const rough = require('roughjs/bundled/rough.cjs.js');
const fs = require('fs');
const gen = rough.generator();

const STROKE = '#1e293b';
const MUTED = '#475569';
const FONT = "'Caveat', 'Kalam', 'Comic Sans MS', cursive";

const COL_ACTIVE = '#dbeafe';
const COL_PASS = '#e2e8f0';
const COL_REJECT = '#fee2e2';
const COL_NOTE = '#fef3c7';
const COL_BG = '#f1f5f9';
const COL_PAPER = '#fbf7ef';

function pathFromDrawable(drawable) {
  let d = '';
  for (const set of drawable.sets) {
    for (const op of set.ops) {
      if (op.op === 'move') d += `M${op.data[0]},${op.data[1]} `;
      else if (op.op === 'bcurveTo') d += `C${op.data[0]},${op.data[1]} ${op.data[2]},${op.data[3]} ${op.data[4]},${op.data[5]} `;
      else if (op.op === 'lineTo') d += `L${op.data[0]},${op.data[1]} `;
    }
  }
  return d.trim();
}

function rect(x, y, w, h, fill) {
  const shape = gen.rectangle(x, y, w, h, { roughness: 1.3, stroke: STROKE, strokeWidth: 1.4, bowing: 1.0 });
  let out = '';
  if (fill) out += `<path d="M${x},${y} L${x+w},${y} L${x+w},${y+h} L${x},${y+h} Z" fill="${fill}" />`;
  out += `<path d="${pathFromDrawable(shape)}" stroke="${STROKE}" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return out;
}

function diamond(cx, cy, w, h, fill) {
  const pts = [[cx, cy - h/2], [cx + w/2, cy], [cx, cy + h/2], [cx - w/2, cy]];
  const shape = gen.polygon(pts, { roughness: 1.3, stroke: STROKE, strokeWidth: 1.4, bowing: 1.0 });
  const polyFill = `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]} L${pts[2][0]},${pts[2][1]} L${pts[3][0]},${pts[3][1]} Z`;
  let out = '';
  if (fill) out += `<path d="${polyFill}" fill="${fill}" />`;
  out += `<path d="${pathFromDrawable(shape)}" stroke="${STROKE}" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return out;
}

function line(x1, y1, x2, y2, dashed) {
  const shape = gen.line(x1, y1, x2, y2, { roughness: 1.2, stroke: STROKE, strokeWidth: 1.3 });
  const da = dashed ? 'stroke-dasharray="6,5"' : '';
  return `<path d="${pathFromDrawable(shape)}" stroke="${STROKE}" stroke-width="1.3" fill="none" stroke-linecap="round" ${da}/>`;
}

function arrow(x1, y1, x2, y2, dashed) {
  const body = line(x1, y1, x2, y2, dashed);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = 10;
  const ax1 = x2 - len * Math.cos(angle - 0.45);
  const ay1 = y2 - len * Math.sin(angle - 0.45);
  const ax2 = x2 - len * Math.cos(angle + 0.45);
  const ay2 = y2 - len * Math.sin(angle + 0.45);
  const head = `<path d="M${x2},${y2} L${ax1},${ay1} M${x2},${y2} L${ax2},${ay2}" stroke="${STROKE}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
  return body + head;
}

function label(x, y, text, size = 17, color = STROKE, anchor = 'middle') {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" dominant-baseline="middle">${text}</text>`;
}

function multilabel(x, y, lines, size = 15, color = STROKE) {
  const lineH = size * 1.15;
  const start = y - ((lines.length - 1) * lineH) / 2;
  return lines.map((t, i) => label(x, start + i * lineH, t, size, color)).join('');
}

function svgWrap(w, h, body) {
  const bg = `<rect width="${w}" height="${h}" fill="${COL_PAPER}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="${FONT}">${bg}${body}</svg>`;
}

// ============== AUTH MODES ==============
function renderAuth() {
  const W = 900, H = 380;
  let s = '';
  s += rect(30, 20, 840, 140, COL_BG);
  s += label(90, 42, 'Default', 16);
  s += rect(30, 200, 840, 160, COL_BG);
  s += label(130, 222, '--oauth-bridge', 16);

  s += rect(80, 70, 160, 60, COL_ACTIVE);
  s += label(160, 100, 'Client');
  s += rect(370, 70, 200, 60, COL_ACTIVE);
  s += label(470, 100, 'Proxy');
  s += rect(700, 70, 140, 60, COL_ACTIVE);
  s += multilabel(770, 100, ['api.', 'anthropic.com'], 14);

  s += arrow(240, 100, 370, 100);
  s += label(305, 85, 'x-api-key: sk-ant-…', 14, MUTED);
  s += arrow(570, 100, 700, 100);
  s += label(635, 85, 'unchanged', 14, MUTED);

  s += rect(80, 250, 160, 60, COL_ACTIVE);
  s += label(160, 280, 'Client');
  s += rect(370, 250, 200, 60, COL_ACTIVE);
  s += label(470, 280, 'Proxy');
  s += rect(700, 250, 140, 60, COL_ACTIVE);
  s += multilabel(770, 280, ['api.', 'anthropic.com'], 14);

  s += rect(400, 330, 140, 30, COL_NOTE);
  s += label(470, 345, 'macOS Keychain', 13);

  s += arrow(240, 280, 370, 280);
  s += label(305, 265, 'sk-ant-…', 14, MUTED);
  s += arrow(570, 280, 700, 280);
  s += label(635, 265, 'oauth-…', 14, MUTED);
  s += arrow(470, 330, 470, 315, true);

  fs.writeFileSync('/tmp/excalidraw-gen/auth.svg', svgWrap(W, H, s));
}

// ============== REQUEST FLOW ==============
function renderFlow() {
  const W = 1100, H = 1800;
  let s = '';
  const CX = 550;
  const LEFT = 180;
  const RIGHT = 900;

  // Nodes
  s += rect(CX - 180, 30, 360, 50, COL_ACTIVE);
  s += label(CX, 55, 'Client: POST /v1/messages', 17);

  s += diamond(CX, 160, 260, 80, COL_BG);
  s += multilabel(CX, 160, ['anthropic-version', 'header present?'], 15);

  s += rect(RIGHT - 80, 135, 160, 50, COL_REJECT);
  s += label(RIGHT, 160, '400 — reject', 16);

  s += diamond(CX, 280, 260, 80, COL_BG);
  s += label(CX, 280, 'path starts with /v1/?', 15);

  s += rect(RIGHT - 80, 255, 160, 50, COL_REJECT);
  s += label(RIGHT, 280, '403 — forbidden', 15);

  s += diamond(CX, 400, 260, 80, COL_BG);
  s += multilabel(CX, 400, ['/v1/messages', 'or count_tokens?'], 15);

  s += rect(LEFT - 80, 375, 160, 50, COL_PASS);
  s += label(LEFT, 400, 'passthrough', 16, MUTED);

  s += diamond(CX, 520, 260, 80, COL_BG);
  s += label(CX, 520, 'proxy paused?', 15);
  s += rect(LEFT - 80, 495, 160, 50, COL_PASS);
  s += label(LEFT, 520, 'passthrough', 16, MUTED);

  s += diamond(CX, 640, 260, 80, COL_BG);
  s += multilabel(CX, 640, ['thinking-state', 'in request?'], 15);
  s += rect(LEFT - 80, 615, 160, 50, COL_PASS);
  s += label(LEFT, 640, 'passthrough', 16, MUTED);

  s += diamond(CX, 760, 260, 80, COL_BG);
  s += multilabel(CX, 760, ['token +', 'server reachable?'], 15);
  s += rect(LEFT - 80, 735, 160, 50, COL_PASS);
  s += label(LEFT, 760, 'passthrough', 16, MUTED);

  s += rect(CX - 180, 860, 360, 56, COL_ACTIVE);
  s += multilabel(CX, 888, ['POST /api/cli/proxy/prepare', '800ms budget'], 15);

  s += diamond(CX, 990, 260, 80, COL_BG);
  s += multilabel(CX, 990, ['server responded', 'in time?'], 15);
  s += rect(LEFT - 80, 965, 160, 50, COL_PASS);
  s += label(LEFT, 990, 'passthrough', 16, MUTED);

  s += rect(CX - 180, 1090, 360, 56, COL_ACTIVE);
  s += multilabel(CX, 1118, ['trim messages', '+ append system_fragment'], 15);

  s += rect(CX - 180, 1200, 360, 50, COL_ACTIVE);
  s += label(CX, 1225, 'forward to api.anthropic.com', 16);

  s += rect(CX - 180, 1300, 360, 56, COL_ACTIVE);
  s += multilabel(CX, 1328, ['patch input_tokens', 'in SSE message_start'], 15);

  s += rect(CX - 180, 1430, 360, 50, COL_ACTIVE);
  s += label(CX, 1455, 'stream response to client', 16);

  // Passthrough merge column
  s += rect(LEFT - 80, 1200, 160, 56, COL_PASS);
  s += multilabel(LEFT, 1228, ['forward to', 'api.anthropic.com'], 14, MUTED);

  // Arrows
  // Main spine
  s += arrow(CX, 80, CX, 120);   // A -> B
  s += arrow(CX + 130, 160, RIGHT - 80, 160);
  s += label((CX+130+RIGHT-80)/2, 150, 'no', 14, MUTED);
  s += arrow(CX, 200, CX, 240);  // B -> C
  s += label(CX - 30, 220, 'yes', 14, MUTED);

  s += arrow(CX + 130, 280, RIGHT - 80, 280);
  s += label((CX+130+RIGHT-80)/2, 270, 'no', 14, MUTED);
  s += arrow(CX, 320, CX, 360);  // C -> D
  s += label(CX - 30, 340, 'yes', 14, MUTED);

  s += arrow(CX - 130, 400, LEFT + 80, 400);
  s += label((CX-130+LEFT+80)/2, 390, 'no', 14, MUTED);
  s += arrow(CX, 440, CX, 480);  // D -> E
  s += label(CX - 30, 460, 'yes', 14, MUTED);

  s += arrow(CX - 130, 520, LEFT + 80, 520);
  s += label((CX-130+LEFT+80)/2, 510, 'yes', 14, MUTED);
  s += arrow(CX, 560, CX, 600);  // E -> G
  s += label(CX - 30, 580, 'no', 14, MUTED);

  s += arrow(CX - 130, 640, LEFT + 80, 640);
  s += label((CX-130+LEFT+80)/2, 630, 'yes', 14, MUTED);
  s += arrow(CX, 680, CX, 720);  // G -> H
  s += label(CX - 30, 700, 'no', 14, MUTED);

  s += arrow(CX - 130, 760, LEFT + 80, 760);
  s += label((CX-130+LEFT+80)/2, 750, 'no', 14, MUTED);
  s += arrow(CX, 800, CX, 860);  // H -> I
  s += label(CX - 30, 830, 'yes', 14, MUTED);

  s += arrow(CX, 916, CX, 950);  // I -> J
  s += arrow(CX - 130, 990, LEFT + 80, 990);
  s += label((CX-130+LEFT+80)/2, 980, 'no', 14, MUTED);
  s += arrow(CX, 1030, CX, 1090); // J -> K
  s += label(CX - 30, 1060, 'yes', 14, MUTED);

  s += arrow(CX, 1146, CX, 1200); // K -> L
  s += arrow(CX, 1250, CX, 1300); // L -> M
  s += arrow(CX, 1356, CX, 1430); // M -> N

  // Left passthrough spine: F1..F5 all flow down to L0 at y=1200
  s += arrow(LEFT, 425, LEFT, 495, true);    // F1 -> F2 area visual trail
  // To keep it clean, draw single flowing line down from F1 to L0
  for (const fy of [425, 545, 665, 785, 1015]) {
    const dy = fy + 20;
    s += line(LEFT, dy, LEFT, 1200); // down trail
  }
  s += arrow(LEFT, 1200, LEFT, 1200);

  // L0 -> N
  s += arrow(LEFT + 80, 1225, CX - 180, 1455);

  fs.writeFileSync('/tmp/excalidraw-gen/flow.svg', svgWrap(W, H, s));
}

// ============== PREPARE EXCHANGE (sequence) ==============
function renderSequence() {
  const W = 1200, H = 720;
  let s = '';
  const actors = [
    { x: 150, name: 'Claude Code' },
    { x: 450, name: 'ergosum-proxy' },
    { x: 800, name: 'ErgoSum server' },
    { x: 1100, name: 'api.anthropic.com' },
  ];

  // Actor headers
  for (const a of actors) {
    s += rect(a.x - 90, 30, 180, 46, COL_ACTIVE);
    s += label(a.x, 53, a.name, 15);
    // Lifeline
    s += line(a.x, 76, a.x, H - 40, true);
  }

  function msg(fromX, toX, y, text, dashed) {
    s += arrow(fromX, y, toX, y, dashed);
    const cx = (fromX + toX) / 2;
    s += label(cx, y - 10, text, 14, MUTED);
  }

  function note(x1, x2, y, lines) {
    const pad = 14;
    const W0 = x2 - x1 + pad * 2;
    s += rect(x1 - pad, y, W0, 22 + lines.length * 16, COL_NOTE);
    lines.forEach((t, i) => s += label((x1+x2)/2, y + 18 + i * 16, t, 13));
  }

  msg(actors[0].x, actors[1].x, 115, 'POST /v1/messages  {messages, system, ...}');
  msg(actors[1].x, actors[2].x, 170, 'POST /api/cli/proxy/prepare');
  s += label((actors[1].x + actors[2].x)/2, 186, '{messages, window_tokens, last_user_text, session_id}', 12, MUTED);

  note(actors[2].x - 90, actors[2].x + 90, 210, [
    'priority-aware pair drop',
    '+ semantic retrieval',
    '+ archive dropped turns',
  ]);

  msg(actors[2].x, actors[1].x, 310, '{messages, system_fragment,', true);
  s += label((actors[1].x + actors[2].x)/2, 326, 'trimmed_count, retrieved_sections}', 12, MUTED);

  note(actors[1].x - 110, actors[1].x + 110, 350, [
    'append system_fragment',
    'to request.system',
  ]);

  msg(actors[1].x, actors[3].x, 430, 'POST /v1/messages (trimmed)');
  msg(actors[3].x, actors[1].x, 480, 'SSE stream', true);

  note(actors[1].x - 120, actors[1].x + 120, 510, [
    'patch input_tokens',
    'in message_start event',
  ]);

  msg(actors[1].x, actors[0].x, 590, 'SSE stream (patched)', true);

  fs.writeFileSync('/tmp/excalidraw-gen/sequence.svg', svgWrap(W, H, s));
}

// ============== LIFECYCLE (state diagram) ==============
function renderLifecycle() {
  const W = 1100, H = 700;
  let s = '';

  // States
  function state(x, y, w, h, title, fill = COL_ACTIVE) {
    s += rect(x, y, w, h, fill);
    s += label(x + w/2, y + h/2, title, 17);
  }

  // Start dot
  s += `<circle cx="80" cy="80" r="10" fill="${STROKE}"/>`;

  // NotRunning (center-top)
  state(430, 60, 200, 60, 'NotRunning', COL_BG);

  // Running (left)
  state(100, 260, 200, 60, 'Running');

  // LaunchAgent (right)
  state(780, 260, 220, 60, 'LaunchAgent');

  // Paused (middle)
  state(440, 260, 200, 60, 'Paused', COL_PASS);

  // Notes (side)
  function noteBox(x, y, w, lines, title) {
    const h = 16 + lines.length * 16 + 8;
    s += rect(x, y, w, h, COL_NOTE);
    s += label(x + w/2, y + 14, title, 14);
    lines.forEach((t, i) => s += label(x + w/2, y + 30 + i * 16, t, 12, MUTED));
  }

  noteBox(100, 400, 200, ['ANTHROPIC_BASE_URL set', 'trimming active'], 'Running');
  noteBox(440, 400, 200, ['proxy still up', 'passthrough mode', 'Claude Code stays connected'], 'Paused');
  noteBox(780, 400, 220, ['survives reboots', 'starts on login', 'runs with --persistent'], 'LaunchAgent');

  // Arrows from start to NotRunning
  s += arrow(80, 90, 430, 90);

  // NotRunning -> Running
  s += arrow(430, 105, 200, 260);
  s += label(270, 170, 'ergosum-proxy', 13, MUTED);

  // NotRunning -> LaunchAgent
  s += arrow(630, 105, 880, 260);
  s += label(790, 170, 'install', 13, MUTED);

  // Running -> Paused
  s += arrow(300, 290, 440, 290);
  s += label(370, 280, 'stop', 13, MUTED);

  // LaunchAgent -> Paused (curved would be nice, use line)
  s += arrow(780, 305, 640, 305);
  s += label(710, 295, 'stop', 13, MUTED);

  // Paused -> Running (below)
  s += arrow(440, 300, 300, 300);
  s += label(370, 315, 'resume', 13, MUTED);

  // Running -> NotRunning (curve back via left edge) - use a line going up then right
  s += line(200, 260, 200, 210);
  s += line(200, 210, 530, 210);
  s += arrow(530, 210, 530, 120);
  s += label(370, 205, 'uninstall', 13, MUTED);

  // LaunchAgent -> NotRunning (curve back via right edge)
  s += line(880, 260, 880, 200);
  s += line(880, 200, 570, 200);
  s += arrow(570, 200, 570, 120);
  s += label(730, 195, 'uninstall', 13, MUTED);

  // Paused -> NotRunning (straight up)
  s += arrow(540, 260, 540, 120);
  s += label(555, 195, 'uninstall', 13, MUTED, 'start');

  fs.writeFileSync('/tmp/excalidraw-gen/lifecycle.svg', svgWrap(W, H, s));
}

renderAuth();
renderFlow();
renderSequence();
renderLifecycle();
console.log('wrote all 4 SVGs');
