#!/usr/bin/env node
/**
 * Form Master Benchmark — Scoring Backend
 *
 * Tests an AI agent's ability to read structured data and fill out
 * HTML forms accurately and quickly.
 *
 * Runs on port 7433 by default.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.BENCH_PORT ? parseInt(process.env.BENCH_PORT) : 7433;

// --- Data Generation ---

const FIRST_NAMES = ['Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack', 'Karen', 'Leo', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rachel', 'Sam', 'Tara'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Wilson', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin'];
const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Pine Rd', 'Elm St', 'Washington Blvd', 'Park Ave', 'Lake Dr', 'River Rd'];
const CITIES = ['Springfield', 'Riverside', 'Greenville', 'Fairview', 'Madison', 'Georgetown', 'Franklin', 'Clinton', 'Salem', 'Ashland'];
const STATES = [
  { label: 'Alabama', value: 'AL' }, { label: 'Alaska', value: 'AK' },
  { label: 'Arizona', value: 'AZ' }, { label: 'California', value: 'CA' },
  { label: 'Colorado', value: 'CO' }, { label: 'Florida', value: 'FL' },
  { label: 'Georgia', value: 'GA' }, { label: 'Illinois', value: 'IL' },
  { label: 'New York', value: 'NY' }, { label: 'Ohio', value: 'OH' },
  { label: 'Texas', value: 'TX' }, { label: 'Washington', value: 'WA' },
];
const DEPARTMENTS = ['Engineering', 'Marketing', 'Sales', 'Human Resources', 'Finance', 'Operations', 'Legal', 'Design'];
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern'];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Australia', 'Germany', 'France'];
const SUBSCRIPTION_PLANS = ['Free', 'Basic', 'Pro', 'Enterprise'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function padded(n, len = 2) { return String(n).padStart(len, '0'); }

function generateProfile() {
  const state = pick(STATES);
  const birthYear = randInt(1960, 2000);
  const birthMonth = randInt(1, 12);
  const birthDay = randInt(1, 28);
  const salary = randInt(40, 200) * 1000;

  return {
    firstName: pick(FIRST_NAMES),
    lastName: pick(LAST_NAMES),
    email: null, // filled below
    phone: `${randInt(200,999)}-${randInt(100,999)}-${randInt(1000,9999)}`,
    dateOfBirth: `${birthYear}-${padded(birthMonth)}-${padded(birthDay)}`,
    street: `${randInt(100, 9999)} ${pick(STREETS)}`,
    city: pick(CITIES),
    state: state.value,
    stateLabel: state.label,
    zipCode: String(randInt(10000, 99999)),
    country: 'United States',
    department: pick(DEPARTMENTS),
    employmentType: pick(EMPLOYMENT_TYPES),
    salary: salary,
    startDate: `${randInt(2018,2024)}-${padded(randInt(1,12))}-${padded(randInt(1,28))}`,
    subscriptionPlan: pick(SUBSCRIPTION_PLANS),
    newsletter: Math.random() > 0.5,
    notes: `This is a test profile for the form master benchmark.`,
  };
}

// Field definitions — each has a type, label, and how to get its value from profile
const ALL_FIELD_DEFS = [
  { id: 'firstName',       label: 'First Name',       type: 'text',     key: 'firstName' },
  { id: 'lastName',        label: 'Last Name',        type: 'text',     key: 'lastName' },
  { id: 'email',           label: 'Email Address',    type: 'email',    key: 'email' },
  { id: 'phone',           label: 'Phone Number',     type: 'text',     key: 'phone' },
  { id: 'dateOfBirth',     label: 'Date of Birth',    type: 'date',     key: 'dateOfBirth' },
  { id: 'street',          label: 'Street Address',   type: 'text',     key: 'street' },
  { id: 'city',            label: 'City',             type: 'text',     key: 'city' },
  { id: 'state',           label: 'State',            type: 'select',   key: 'state',    options: STATES.map(s => ({ label: s.label, value: s.value })) },
  { id: 'zipCode',         label: 'ZIP Code',         type: 'text',     key: 'zipCode' },
  { id: 'country',         label: 'Country',          type: 'select',   key: 'country',  options: COUNTRIES.map(c => ({ label: c, value: c })) },
  { id: 'department',      label: 'Department',       type: 'select',   key: 'department', options: DEPARTMENTS.map(d => ({ label: d, value: d })) },
  { id: 'employmentType',  label: 'Employment Type',  type: 'radio',    key: 'employmentType', options: EMPLOYMENT_TYPES.map(e => ({ label: e, value: e })) },
  { id: 'salary',          label: 'Annual Salary ($)', type: 'number',  key: 'salary' },
  { id: 'startDate',       label: 'Start Date',       type: 'date',     key: 'startDate' },
  { id: 'subscriptionPlan',label: 'Subscription Plan',type: 'select',  key: 'subscriptionPlan', options: SUBSCRIPTION_PLANS.map(p => ({ label: p, value: p })) },
  { id: 'newsletter',      label: 'Subscribe to Newsletter', type: 'checkbox', key: 'newsletter' },
  { id: 'notes',           label: 'Notes',            type: 'textarea', key: 'notes' },
];

// Difficulty levels define which fields appear and in what order
const DIFFICULTY_LEVELS = [
  // Round 1: single simple text field
  { round: 1, fieldIds: ['firstName'] },
  // Round 2: two simple text fields
  { round: 2, fieldIds: ['firstName', 'lastName'] },
  // Round 3: text + email
  { round: 3, fieldIds: ['firstName', 'lastName', 'email'] },
  // Round 4: text + phone
  { round: 4, fieldIds: ['firstName', 'phone', 'zipCode'] },
  // Round 5: address block
  { round: 5, fieldIds: ['street', 'city', 'zipCode'] },
  // Round 6: address + dropdown
  { round: 6, fieldIds: ['street', 'city', 'state', 'zipCode'] },
  // Round 7: dropdown + select + date
  { round: 7, fieldIds: ['country', 'state', 'dateOfBirth'] },
  // Round 8: radio buttons + select
  { round: 8, fieldIds: ['department', 'employmentType', 'salary'] },
  // Round 9: dates + number
  { round: 9, fieldIds: ['startDate', 'salary', 'subscriptionPlan'] },
  // Round 10: full form - all field types
  { round: 10, fieldIds: ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'street', 'city', 'state', 'zipCode', 'department', 'employmentType', 'subscriptionPlan', 'newsletter'] },
];

function buildRounds(config = {}) {
  const totalRounds = config.totalRounds || DIFFICULTY_LEVELS.length;
  const profile = generateProfile();
  // Generate email from name
  profile.email = `${profile.firstName.toLowerCase()}.${profile.lastName.toLowerCase()}@example.com`;

  const rounds = [];
  for (let i = 0; i < totalRounds; i++) {
    const level = DIFFICULTY_LEVELS[Math.min(i, DIFFICULTY_LEVELS.length - 1)];
    const fields = level.fieldIds.map(id => {
      const def = ALL_FIELD_DEFS.find(f => f.id === id);
      return { ...def, correctValue: profile[def.key] };
    });
    rounds.push({ roundIndex: i, fields });
  }
  return { profile, rounds };
}

// --- Session Store ---
const sessions = new Map();

function createSession(config = {}) {
  const sessionId = crypto.randomUUID();
  const { profile, rounds } = buildRounds(config);
  const session = {
    sessionId,
    config,
    profile,
    rounds,
    roundIndex: 0,
    score: 0,
    totalFields: 0,
    correctFields: 0,
    incorrectFields: 0,
    roundResults: [],
    startedAt: Date.now(),
    finishedAt: null,
    finished: false,
    easyMode: config.easyMode !== false, // default true: show data side-by-side
  };
  sessions.set(sessionId, session);
  return sessionId;
}

function sessionState(session) {
  const currentRound = session.finished ? null : session.rounds[session.roundIndex] || null;
  return {
    sessionId: session.sessionId,
    easyMode: session.easyMode,
    profile: session.easyMode ? session.profile : undefined,
    round: session.roundIndex,
    totalRounds: session.rounds.length,
    currentRound: currentRound ? {
      roundIndex: currentRound.roundIndex,
      fields: currentRound.fields.map(f => ({
        id: f.id,
        label: f.label,
        type: f.type,
        options: f.options || undefined,
      })),
    } : null,
    score: session.score,
    totalFields: session.totalFields,
    correctFields: session.correctFields,
    incorrectFields: session.incorrectFields,
    accuracy: session.totalFields > 0 ? session.correctFields / session.totalFields : null,
    roundResults: session.roundResults,
    totalTime: session.finishedAt ? session.finishedAt - session.startedAt : Date.now() - session.startedAt,
    finished: session.finished,
  };
}

function processSubmission(session, { answers, reactionMs }) {
  if (session.finished) return { state: sessionState(session), fieldResults: [] };

  const currentRound = session.rounds[session.roundIndex];
  if (!currentRound) return { state: sessionState(session), fieldResults: [] };

  const rm = typeof reactionMs === 'number' ? reactionMs : 9999;
  const fieldResults = [];
  let roundScore = 0;
  let roundCorrect = 0;
  let roundIncorrect = 0;

  for (const field of currentRound.fields) {
    const submitted = answers[field.id];
    const correct = field.correctValue;
    let isCorrect = false;

    // Type-aware comparison
    if (field.type === 'checkbox') {
      // Accept boolean or string "true"/"false"/"on"
      const boolSubmit = submitted === true || submitted === 'true' || submitted === 'on' || submitted === 1;
      isCorrect = boolSubmit === correct;
    } else if (field.type === 'number' || field.id === 'salary' || field.id === 'zipCode') {
      isCorrect = String(submitted).trim() === String(correct).trim();
    } else if (typeof submitted === 'string') {
      isCorrect = submitted.trim().toLowerCase() === String(correct).trim().toLowerCase();
    }

    fieldResults.push({ fieldId: field.id, submitted, correct, isCorrect });

    if (isCorrect) {
      roundCorrect++;
      // Score: 50 base per field + speed bonus
      const speedBonus = Math.max(0, Math.round((10000 - rm) / 100));
      roundScore += 50 + speedBonus;
    } else {
      roundIncorrect++;
    }
  }

  session.roundResults[session.roundIndex] = {
    roundIndex: session.roundIndex,
    score: roundScore,
    correctFields: roundCorrect,
    incorrectFields: roundIncorrect,
    totalFields: currentRound.fields.length,
    reactionMs: rm,
    fieldResults,
  };
  const completed = session.roundResults.filter(Boolean);
  session.score = completed.reduce((sum, result) => sum + result.score, 0);
  session.totalFields = completed.reduce((sum, result) => sum + result.totalFields, 0);
  session.correctFields = completed.reduce((sum, result) => sum + result.correctFields, 0);
  session.incorrectFields = completed.reduce((sum, result) => sum + result.incorrectFields, 0);
  session.roundIndex++;

  if (session.roundIndex >= session.rounds.length) {
    session.finished = true;
    session.finishedAt = Date.now();
  }

  return { state: sessionState(session), fieldResults };
}

// --- HTTP Server ---
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // POST /api/start
  if (req.method === 'POST' && pathname === '/api/start') {
    const body = await readBody(req);
    const sessionId = createSession(body.config || {});
    const session = sessions.get(sessionId);
    return json(res, sessionState(session));
  }

  // POST /api/submit  — submit answers for the current round
  if (req.method === 'POST' && pathname === '/api/submit') {
    const body = await readBody(req);
    const { sessionId } = body;
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    const result = processSubmission(session, body);
    return json(res, result);
  }

  // POST /api/jump — revisit any round without replaying earlier rounds.
  if (req.method === 'POST' && pathname === '/api/jump') {
    const body = await readBody(req);
    const session = sessions.get(body.sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    const roundIndex = Number(body.roundIndex);
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= session.rounds.length) {
      return json(res, { error: 'Invalid round index' }, 400);
    }
    session.roundIndex = roundIndex;
    session.finished = false;
    session.finishedAt = null;
    return json(res, sessionState(session));
  }

  // GET /api/state
  if (req.method === 'GET' && pathname === '/api/state') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, sessionState(session));
  }

  // GET /api/profile  — get the full profile (for agent reference in hard mode)
  if (req.method === 'GET' && pathname === '/api/profile') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, session.profile);
  }

  // GET /api/results
  if (req.method === 'GET' && pathname === '/api/results') {
    const sessionId = url.searchParams.get('session');
    const session = sessions.get(sessionId);
    if (!session) return json(res, { error: 'Session not found' }, 404);
    return json(res, sessionState(session));
  }

  // GET /api/sessions
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const result = [];
    for (const [, s] of sessions) result.push(sessionState(s));
    return json(res, result);
  }

  // GET /health
  if (req.method === 'GET' && pathname === '/health') {
    return json(res, { ok: true, sessions: sessions.size });
  }

  // GET / — serve index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`📋 Form Master Benchmark Server listening on http://localhost:${PORT}`);
  console.log(`   Open http://localhost:${PORT} in a browser to play manually`);
  console.log(`   API: POST /api/start | POST /api/submit | GET /api/state`);
});

server.on('error', (e) => {
  console.error('Server error:', e.message);
  process.exit(1);
});
