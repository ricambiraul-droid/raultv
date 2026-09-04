'use strict';

// ---------------------------------------------------------------------------
// Registrul de dispozitive si de conturi Xtream.
//
// Fiecare dispozitiv are un token propriu, derivat determinist dintr-un secret
// server-side: nu-l tinem nicaieri in clar si ramane acelasi dupa repornire.
// Starea editabila (nume, activ/inactiv, contul folosit) se salveaza intr-un
// fisier de lucru si poate fi fixata permanent prin variabila RAULTV_DEVICES.
//
// Credentialele Xtream NU ies niciodata din acest modul catre manifest sau UI.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.RAULTV_STATE_FILE || path.join(process.env.RENDER_DISK_PATH || '/tmp', 'raultv-devices.json');
const SLOTS = Math.min(200, Math.max(30, Number(process.env.RAULTV_DEVICE_SLOTS || 100)));

// --- conturi Xtream -------------------------------------------------------

function baseAccount() {
  return {
    id: 'main',
    label: 'Cont principal',
    server: String(process.env.TIVIONE_XTREAM_SERVER || '').replace(/\/+$/, ''),
    username: process.env.TIVIONE_XTREAM_USERNAME || '',
    password: process.env.TIVIONE_XTREAM_PASSWORD || '',
    maxConnections: Number(process.env.TIVIONE_MAX_CONNECTIONS || 1)
  };
}

// XTREAM_ACCOUNTS = {"copii":{"server":"http://...","username":"..","password":"..","maxConnections":1}}
function extraAccounts() {
  const raw = String(process.env.XTREAM_ACCOUNTS || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Object.entries(parsed).map(([id, a]) => ({
      id: String(id),
      label: String(a.label || id),
      server: String(a.server || '').replace(/\/+$/, ''),
      username: String(a.username || ''),
      password: String(a.password || ''),
      maxConnections: Number(a.maxConnections || 1)
    })).filter(a => a.id !== 'main');
  } catch (e) {
    console.error('[RaulTV] XTREAM_ACCOUNTS ignorat: JSON invalid');
    return [];
  }
}

const accounts = new Map();
function loadAccounts() {
  accounts.clear();
  const list = [baseAccount(), ...extraAccounts()];
  for (const a of list) accounts.set(a.id, a);
  return accounts;
}
loadAccounts();

const getAccount = id => accounts.get(id) || accounts.get('main');
const accountConfigured = a => Boolean(a && a.server && a.username && a.password);
// Rezumat public: fara server, fara user, fara parola.
const accountSummary = a => ({ id: a.id, eticheta: a.label, configurat: accountConfigured(a), maxConexiuni: a.maxConnections });
const listAccounts = () => [...accounts.values()].map(accountSummary);

// --- secret si token-uri --------------------------------------------------

function secret() {
  const explicit = String(process.env.RAULTV_SECRET || '').trim();
  if (explicit) return explicit;
  const main = getAccount('main');
  // Fallback stabil intre reporniri, derivat din credentiale — nu se expune.
  return crypto.createHash('sha256').update('raultv|' + main.username + '|' + main.password).digest('hex');
}

function tokenFor(id) {
  return crypto.createHmac('sha256', secret()).update('device:' + id).digest('base64url').slice(0, 22);
}

// --- starea dispozitivelor ------------------------------------------------

const devices = new Map();
const byToken = new Map();

function blank(id, index) {
  return {
    id,
    nume: 'Dispozitiv ' + index,
    activ: index <= 1,          // primul slot pornit, restul se activeaza din panou
    cont: 'main',
    note: '',
    creat: null,
    ultimaCerere: null,
    cereri: 0
  };
}

function seed() {
  devices.clear();
  for (let i = 1; i <= SLOTS; i++) {
    const id = 'd' + i;
    devices.set(id, blank(id, i));
  }
}

function applyOverlay(raw, sursa) {
  if (!raw) return 0;
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { console.error('[RaulTV] stare dispozitive ignorata (' + sursa + '): JSON invalid'); return 0; }
  let n = 0;
  for (const [id, patch] of Object.entries(parsed || {})) {
    const d = devices.get(id);
    if (!d || !patch || typeof patch !== 'object') continue;
    if (typeof patch.nume === 'string') d.nume = patch.nume.slice(0, 40);
    if (typeof patch.activ === 'boolean') d.activ = patch.activ;
    if (typeof patch.cont === 'string' && accounts.has(patch.cont)) d.cont = patch.cont;
    if (typeof patch.note === 'string') d.note = patch.note.slice(0, 120);
    if (typeof patch.creat === 'string') d.creat = patch.creat;
    n++;
  }
  return n;
}

function reindex() {
  byToken.clear();
  for (const d of devices.values()) byToken.set(tokenFor(d.id), d);
}

function persistedShape() {
  const out = {};
  for (const d of devices.values()) {
    out[d.id] = { nume: d.nume, activ: d.activ, cont: d.cont, note: d.note, creat: d.creat };
  }
  return out;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(persistedShape()));
    return true;
  } catch (e) {
    console.error('[RaulTV] nu am putut salva starea dispozitivelor:', e.message);
    return false;
  }
}

function load() {
  seed();
  const fromEnv = applyOverlay(process.env.RAULTV_DEVICES, 'RAULTV_DEVICES');
  let fromFile = 0;
  try {
    if (fs.existsSync(STATE_FILE)) fromFile = applyOverlay(fs.readFileSync(STATE_FILE, 'utf8'), 'fisier');
  } catch (e) { /* pornim cu ce avem */ }
  reindex();
  console.log(`[RaulTV] ${devices.size} sloturi de dispozitiv (env: ${fromEnv}, fisier: ${fromFile})`);
}
load();

// --- API ------------------------------------------------------------------

function resolve(token) {
  if (!token) return null;
  const d = byToken.get(token);
  if (!d) return { eroare: 'necunoscut' };
  if (!d.activ) return { eroare: 'dezactivat', dispozitiv: d };
  return { dispozitiv: d, cont: getAccount(d.cont) };
}

function touch(d) {
  d.cereri++;
  d.ultimaCerere = new Date().toISOString();
  if (!d.creat) d.creat = d.ultimaCerere;
}

function update(id, patch) {
  const d = devices.get(id);
  if (!d) return null;
  if (typeof patch.nume === 'string') d.nume = patch.nume.slice(0, 40);
  if (typeof patch.activ === 'boolean') d.activ = patch.activ;
  if (typeof patch.cont === 'string' && accounts.has(patch.cont)) d.cont = patch.cont;
  if (typeof patch.note === 'string') d.note = patch.note.slice(0, 120);
  if (d.activ && !d.creat) d.creat = new Date().toISOString();
  save();
  return d;
}

function list({ includeToken = false } = {}) {
  return [...devices.values()].map(d => ({
    id: d.id, nume: d.nume, activ: d.activ, cont: d.cont, note: d.note,
    creat: d.creat, ultimaCerere: d.ultimaCerere, cereri: d.cereri,
    ...(includeToken ? { token: tokenFor(d.id) } : {})
  }));
}

function stats() {
  const all = [...devices.values()];
  const active = all.filter(d => d.activ);
  const de24h = Date.now() - 24 * 3600 * 1000;
  return {
    sloturi: all.length,
    active: active.length,
    inactive: all.length - active.length,
    folositeVreodata: all.filter(d => d.ultimaCerere).length,
    activeUltimele24h: all.filter(d => d.ultimaCerere && Date.parse(d.ultimaCerere) > de24h).length,
    cereriTotale: all.reduce((s, d) => s + d.cereri, 0),
    peConturi: [...accounts.keys()].map(id => ({ cont: id, dispozitive: active.filter(d => d.cont === id).length }))
  };
}

module.exports = {
  SLOTS, STATE_FILE,
  tokenFor, resolve, touch, update, list, stats, save,
  getAccount, listAccounts, accountConfigured, accountSummary,
  accountIds: () => [...accounts.keys()]
};
