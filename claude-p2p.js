/* =============================================================================
   claude-p2p.js — TWO OWT Office fora do Claude (GitHub Pages / qualquer host)

   O jogo só conversa com `window.claude.use(nome)`. Dentro do claude.ai quem
   responde é a plataforma; aqui este arquivo faz o papel dela, peer-to-peer:

     room    → presença ao vivo entre quem está com a página aberta (WebRTC via Trystero)
     db      → documentos e coleções no IndexedDB de cada um, sincronizados entre os
               peers (última escrita vence). Quem entra recebe o estado de quem já está.
     assets  → uploads (capas, músicas, samples) guardados no IndexedDB e passados
               de navegador em navegador quando alguém precisa. URLs "/_blob/<id>"
               continuam funcionando (fetch e <img> são interceptados).
     user    → identidade local (id estável por navegador, apelido do jogo).
     sample  → indisponível (o Claude dentro da sala só existe no claude.ai).

   Configuração opcional, ANTES deste script:
     <script>window.TWOOWT_P2P_CONFIG = { room: 'minha-sala', password: 'segredo' }</script>
   ou pela URL: ?sala=minha-sala  (e  ?senha=segredo).
   Cada sala tem seu próprio estado salvo no navegador.
   ============================================================================= */
(function () {
  'use strict';
  if (window.claude && typeof window.claude.use === 'function') return; // já dentro do Claude

  const qs = new URLSearchParams(location.search);
  const CFG = Object.assign({
    appId: 'twoowt-office.p2p',          // troque se fizer um fork independente
    room: 'estudio',
    password: '',
    trystero: 'vendor/trystero.min.mjs',
  }, window.TWOOWT_P2P_CONFIG || {});
  if (qs.get('sala')) CFG.room = qs.get('sala').slice(0, 64);
  if (qs.get('senha')) CFG.password = qs.get('senha');
  window.TWOOWT_P2P = true;

  const MAX_DOC = 900 * 1024, MAX_BLOB = 20 * 1024 * 1024, MAX_PRES = 16 * 1024;
  const isPrivate = p => p.startsWith('data/users/');
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
  const later = fn => Promise.resolve().then(fn);

  /* ---------------- IndexedDB (com memória de reserva) ---------------- */
  let idbP = null;
  function idb() {
    return idbP || (idbP = new Promise(res => {
      try {
        const q = indexedDB.open('twoowt-p2p::' + CFG.room, 1);
        q.onupgradeneeded = () => { q.result.createObjectStore('docs'); q.result.createObjectStore('blobs'); };
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(null);
      } catch (e) { res(null); }
    }));
  }
  const MEM = { docs: new Map(), blobs: new Map() };
  async function store(name, mode, fn) {
    const d = await idb();
    if (!d) { return fn(null, MEM[name]); }
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode), s = t.objectStore(name); let out;
      const r = fn(s, null); if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const idbPut = (name, k, v) => store(name, 'readwrite', (s, m) => s ? s.put(v, k) : m.set(k, v)).catch(() => { });
  const idbDel = (name, k) => store(name, 'readwrite', (s, m) => s ? s.delete(k) : m.delete(k)).catch(() => { });
  const idbGet = (name, k) => store(name, 'readonly', (s, m) => s ? s.get(k) : m.get(k)).catch(() => MEM[name].get(k));

  /* ---------------- conexão P2P (preguiçosa, uma só) ---------------- */
  const NET = { room: null, self: null, ready: false, peers: new Map(), connH: new Set(), act: {} };
  let netP = null;
  function net() {
    return netP || (netP = (async () => {
      window.TWOOWT_NETSTATUS = 'abrindo a sala…';
      const m = await import(new URL(CFG.trystero, document.baseURI).href);
      const conf = { appId: CFG.appId };
      if (CFG.password) conf.password = CFG.password;
      const r = NET.room = m.joinRoom(conf, CFG.room);
      NET.self = await r.getSelf();
      NET.act.pres = r.makeAction('pres');
      NET.act.db = r.makeAction('db');
      NET.act.dump = r.makeAction('dump');
      NET.act.blob = r.makeAction('blob', { kind: 'request' });
      NET.act.bpush = r.makeAction('bpush');
      NET.act.bdel = r.makeAction('bdel');
      wireDb(); wireBlobs(); wireRoom();
      r.onError(e => { if (e && e.code === 'relay-failed') setConn(false); });
      r.ready.then(() => setConn(true), () => setConn(false));
      window.addEventListener('pagehide', () => { try { r.leave(); } catch (e) { } });
      return r;
    })().catch(e => { console.warn('[p2p] sem sala:', e); window.TWOOWT_NETSTATUS = 'sem conexão'; netP = null; throw e; }));
  }
  function setConn(ok) {
    NET.ready = ok; window.TWOOWT_NETSTATUS = ok ? 'ao vivo · sala ' + CFG.room : 'reconectando…';
    for (const h of NET.connH) later(() => h(ok));
  }

  /* ================================ ROOM ================================ */
  const PRES = { mine: {}, sendT: 0, timer: 0, peersH: new Set(), pend: null, snap: Object.freeze([]), at: 0 };
  function selfPeer() {
    return { peer: NET.self.peerId, by: NET.self.userId, kind: 'viewer', guest: false, sameTab: true, presence: Object.freeze(clone(PRES.mine)), updatedAt: PRES.at };
  }
  function rebuildSnap() {
    const arr = [selfPeer()]; for (const p of NET.peers.values()) arr.push(p);
    PRES.snap = Object.freeze(arr.map(Object.freeze));
  }
  function queuePeers(kind, peer) {
    if (!PRES.pend) {
      PRES.pend = { joined: new Map(), left: new Map(), updated: new Map() };
      (window.requestAnimationFrame || setTimeout)(flushPeers);
    }
    const P = PRES.pend, id = peer.peer;
    if (kind === 'left') { if (P.joined.has(id)) P.joined.delete(id); else P.left.set(id, peer); P.updated.delete(id); }
    else if (kind === 'joined') { P.left.delete(id); P.joined.set(id, peer); }
    else if (!P.joined.has(id)) P.updated.set(id, peer);
    else P.joined.set(id, peer);
  }
  function flushPeers() {
    const P = PRES.pend; PRES.pend = null; if (!P) return;
    rebuildSnap();
    const pick = m => Object.freeze([...m.keys()].map(id => PRES.snap.find(p => p.peer === id) || m.get(id)));
    const ch = { peers: PRES.snap, joined: pick(P.joined), left: Object.freeze([...P.left.values()]), updated: pick(P.updated) };
    for (const h of PRES.peersH) { try { h(ch); } catch (e) { console.error(e); } }
  }
  function sendPres(target) {
    if (!NET.act.pres) return;
    NET.act.pres.send({ p: PRES.mine, at: PRES.at }, target ? { target } : undefined).catch(() => { });
  }
  function schedulePres() {
    const wait = Math.max(0, 33 - (Date.now() - PRES.sendT));
    if (PRES.timer) return;
    PRES.timer = setTimeout(() => { PRES.timer = 0; PRES.sendT = Date.now(); sendPres(); }, wait);
  }
  function wireRoom() {
    const r = NET.room;
    r.onPeerJoin(({ peerId, userId }) => {
      if (!NET.peers.has(peerId)) {
        const p = { peer: peerId, by: userId, kind: 'viewer', guest: false, sameTab: false, presence: Object.freeze({}), updatedAt: Date.now() };
        NET.peers.set(peerId, p); queuePeers('joined', p);
      }
      sendPres(peerId); sendDump(peerId);
    }, { replay: true });
    r.onPeerLeave(({ peerId }) => {
      const p = NET.peers.get(peerId); if (!p) return;
      NET.peers.delete(peerId); queuePeers('left', p);
    });
    NET.act.pres.onMessage((d, { peerId, userId }) => {
      if (!d || typeof d.p !== 'object' || Array.isArray(d.p)) return;
      if (JSON.stringify(d.p).length > MAX_PRES) return;
      const old = NET.peers.get(peerId), p = { peer: peerId, by: userId, kind: 'viewer', guest: false, sameTab: false, presence: Object.freeze(d.p), updatedAt: Date.now() };
      NET.peers.set(peerId, p); queuePeers(old ? 'updated' : 'joined', p);
    });
    queuePeers('joined', selfPeer());
  }
  const roomNs = {
    presence(patch) {
      if (!patch || typeof patch !== 'object') return Promise.reject(err('invalid_argument'));
      const next = Object.assign({}, PRES.mine);
      for (const k in patch) { if (patch[k] === null) delete next[k]; else if (patch[k] !== undefined) next[k] = clone(patch[k]); }
      if (JSON.stringify(next).length > MAX_PRES) return Promise.reject(err('invalid_argument', 'presence too large'));
      PRES.mine = next; PRES.at = Date.now();
      if (NET.self) { queuePeers('updated', selfPeer()); schedulePres(); }
      return Promise.resolve();
    },
    peers() { return PRES.snap; },
    onPeers(h) {
      PRES.peersH.add(h);
      later(() => { if (!PRES.peersH.has(h)) return; rebuildSnap(); try { h({ peers: PRES.snap, joined: PRES.snap, left: Object.freeze([]), updated: Object.freeze([]) }); } catch (e) { console.error(e); } });
      return () => PRES.peersH.delete(h);
    },
    connected() { return NET.ready; },
    onConnection(h) { NET.connH.add(h); later(() => NET.connH.has(h) && h(NET.ready)); return () => NET.connH.delete(h); },
    emit() { return Promise.resolve(); },        // o TWO OWT não usa eventos; presença carrega tudo
    on() { return () => { }; },
    leave() { try { NET.room && NET.room.leave(); } catch (e) { } return Promise.resolve(); },
  };

  /* ================================= DB =================================
     DOCS: caminho → { v: dados | null (apagado), t: relógio, o: quem escreveu }      */
  const DOCS = new Map(); let clock = 0;
  const stamp = () => (clock = Math.max(Date.now() * 1000, clock + 1));
  const newer = (a, b) => !b || a.t > b.t || (a.t === b.t && String(a.o) > String(b.o));
  let loadP = null;
  function loadDocs() {
    return loadP || (loadP = store('docs', 'readonly', (s, m) => {
      if (!s) { for (const [k, v] of m) DOCS.set(k, v); return null; }
      const r = s.openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { DOCS.set(c.key, c.value); clock = Math.max(clock, c.value.t || 0); c.continue(); } };
      return null;
    }).catch(() => { }));
  }
  const listeners = new Set();
  const outbox = []; let outT = 0;
  function apply(path, rec, fromNet) {
    const cur = DOCS.get(path);
    if (!newer(rec, cur)) return false;
    clock = Math.max(clock, rec.t);
    DOCS.set(path, rec); idbPut('docs', path, rec);
    if (!fromNet && !isPrivate(path)) { outbox.push([path, rec]); if (!outT) outT = setTimeout(flushOut, 20); }
    notify(path); return true;
  }
  function flushOut() {
    outT = 0; const batch = outbox.splice(0); if (!batch.length || !NET.act.db) return;
    NET.act.db.send(batch).catch(() => { });
  }
  function validRec(path, rec) {
    if (typeof path !== 'string' || !path || isPrivate(path) || path.split('/').length % 2) return false;
    if (!rec || typeof rec.t !== 'number' || !isFinite(rec.t)) return false;
    if (rec.v !== null && (typeof rec.v !== 'object' || Array.isArray(rec.v))) return false;
    return JSON.stringify(rec.v).length <= MAX_DOC;
  }
  function sendDump(peerId) {
    loadDocs().then(() => {
      const all = []; for (const [p, r] of DOCS) if (!isPrivate(p)) all.push([p, r]);
      if (NET.act.dump) NET.act.dump.send(all, { target: peerId }).catch(() => { });
    });
  }
  function wireDb() {
    const take = list => { if (!Array.isArray(list)) return; loadDocs().then(() => { for (const it of list) if (Array.isArray(it) && validRec(it[0], it[1])) apply(it[0], { v: it[1].v, t: it[1].t, o: String(it[1].o || '') }, true); }); };
    NET.act.db.onMessage(take);
    NET.act.dump.onMessage(take);
  }
  // notificações agrupadas por microtask
  const dirty = new Set(); let dirtyQ = false;
  function notify(path) {
    dirty.add(path);
    if (dirtyQ) return; dirtyQ = true;
    later(() => {
      dirtyQ = false; const ps = [...dirty]; dirty.clear();
      for (const l of listeners) if (ps.some(p => l.match(p))) l.fire();
    });
  }
  const parentOf = p => p.slice(0, p.lastIndexOf('/'));
  const idOf = p => p.slice(p.lastIndexOf('/') + 1);
  const normPath = p => String(p).split('/').filter(Boolean).join('/');

  function docSnap(path) {
    const r = DOCS.get(path), exists = !!(r && r.v);
    return { id: idOf(path), exists, ref: docRef(path), data: () => exists ? clone(r.v) : undefined, get: k => exists ? clone(r.v[k]) : undefined };
  }
  function querySnap(q) {
    let rows = [];
    for (const [p, r] of DOCS) if (r.v && parentOf(p) === q.path) rows.push([p, r.v]);
    for (const [f, op, val] of q.where) rows = rows.filter(([, v]) => cmpOp(v[f], op, val));
    if (q.order.length) rows.sort((a, b) => { for (const [f, dir] of q.order) { const c = cmp(a[1][f], b[1][f]); if (c) return dir === 'desc' ? -c : c; } return a[0] < b[0] ? -1 : 1; });
    else rows.sort((a, b) => a[0] < b[0] ? -1 : 1);
    if (q.lim != null) rows = rows.slice(0, q.lim);
    const docs = rows.map(([p]) => docSnap(p));
    return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
  }
  function cmp(a, b) {
    if (a === b) return 0; if (a == null) return -1; if (b == null) return 1;
    if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
    return String(typeof a) < String(typeof b) ? -1 : 1;
  }
  function cmpOp(a, op, b) {
    switch (op) {
      case '==': return cmp(a, b) === 0; case '!=': return cmp(a, b) !== 0;
      case '<': return a != null && cmp(a, b) < 0; case '<=': return a != null && cmp(a, b) <= 0;
      case '>': return a != null && cmp(a, b) > 0; case '>=': return a != null && cmp(a, b) >= 0;
      case 'in': return Array.isArray(b) && b.some(x => cmp(a, x) === 0);
      case 'array-contains': return Array.isArray(a) && a.some(x => cmp(x, b) === 0);
      default: return false;
    }
  }
  function listen(match, compute, cb, onErr) {
    const l = { match, fire: () => { try { cb(compute()); } catch (e) { if (onErr) onErr(e); else console.error(e); } } };
    let live = true;
    loadDocs().then(() => { if (live) { listeners.add(l); l.fire(); } });
    return () => { live = false; listeners.delete(l); };
  }
  function write(path, v) {
    const s = JSON.stringify(v); if (s && s.length > MAX_DOC) return Promise.reject(err('invalid_argument', 'document too large'));
    return loadDocs().then(() => { apply(path, { v: v == null ? null : JSON.parse(s), t: stamp(), o: (NET.self && NET.self.peerId) || 'local' }, false); });
  }
  function docRef(path) {
    path = normPath(path);
    if (!path || path.split('/').length % 2) throw err('invalid_argument', 'doc path needs an even number of segments: ' + path);
    return {
      id: idOf(path), path,
      get: () => loadDocs().then(() => docSnap(path)),
      set: (data, opts) => loadDocs().then(() => {
        const cur = DOCS.get(path); const base = opts && opts.merge && cur && cur.v ? cur.v : {};
        return write(path, Object.assign({}, base, clone(data)));
      }),
      update: patch => loadDocs().then(() => {
        const cur = DOCS.get(path); if (!cur || !cur.v) throw err('not_found', 'document does not exist');
        const next = clone(cur.v);
        for (const k in patch) {
          const parts = k.split('.'); let o = next;
          for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || !o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
          if (patch[k] === undefined) delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = clone(patch[k]);
        }
        return write(path, next);
      }),
      delete: () => loadDocs().then(() => write(path, null)),
      onSnapshot: (cb, onErr) => listen(p => p === path, () => docSnap(path), cb, onErr),
      collection: sub => collRef(path + '/' + sub),
    };
  }
  function query(path, q) {
    const self = {
      path, id: idOf(path),
      where: (f, op, v) => query(path, Object.assign({}, q, { where: q.where.concat([[f, op, v]]) })),
      orderBy: (f, dir) => query(path, Object.assign({}, q, { order: q.order.concat([[f, dir === 'desc' ? 'desc' : 'asc']]) })),
      limit: n => query(path, Object.assign({}, q, { lim: Math.max(0, n | 0) })),
      get: () => loadDocs().then(() => querySnap(Object.assign({ path }, q))),
      onSnapshot: (cb, onErr) => listen(p => parentOf(p) === path, () => querySnap(Object.assign({ path }, q)), cb, onErr),
    };
    return self;
  }
  function collRef(path) {
    path = normPath(path);
    if (!path || !(path.split('/').length % 2)) throw err('invalid_argument', 'collection path needs an odd number of segments: ' + path);
    const q = query(path, { where: [], order: [], lim: null });
    return Object.assign(q, {
      doc: id => docRef(path + '/' + (id == null ? hex(10) : id)),
      add: data => { const ref = docRef(path + '/' + hex(10)); return ref.set(data).then(() => ref); },
    });
  }
  const dbNs = { collection: collRef, doc: docRef };

  /* ================================ ASSETS ================================ */
  const URLS = new Map();
  async function localBlob(id) { const r = await idbGet('blobs', id); return r && r.blob ? r.blob : null; }
  async function saveBlob(id, blob) { await idbPut('blobs', id, { blob, at: Date.now() }); }
  const waitPeer = ms => new Promise(res => { const t0 = Date.now(); (function tick() { if (NET.peers.size || Date.now() - t0 > ms) return res(); setTimeout(tick, 250); })(); });
  const pulling = new Map();
  function getBlob(id) {
    if (pulling.has(id)) return pulling.get(id);
    const p = (async () => {
      const b = await localBlob(id); if (b) return b;
      try { await net(); } catch (e) { throw err('not_found'); }
      await waitPeer(8000);
      for (const peerId of NET.peers.keys()) {
        try {
          const got = await NET.act.blob.request(id, { target: peerId, timeoutMs: 20000 });
          if (got && got.byteLength !== undefined && got.byteLength > 0) {
            const blob = got instanceof Blob ? got : new Blob([got]); await saveBlob(id, blob); return blob;
          }
        } catch (e) { }
      }
      throw err('not_found');
    })();
    pulling.set(id, p); p.finally(() => pulling.delete(id)).catch(() => { });
    return p;
  }
  async function blobUrl(id) {
    if (URLS.has(id)) return URLS.get(id);
    const b = await getBlob(id); const u = URL.createObjectURL(b); URLS.set(id, u); return u;
  }
  function wireBlobs() {
    NET.act.blob.onRequest(async id => { if (typeof id !== 'string') return null; const b = await localBlob(id); return b ? new Uint8Array(await b.arrayBuffer()) : null; });
    NET.act.blob.onReceive(({ byteLength }) => byteLength <= MAX_BLOB + 1024);
    NET.act.bpush.onReceive(({ byteLength }) => byteLength <= MAX_BLOB + 1024);
    NET.act.bpush.onMessage(async (bytes, { metadata }) => {
      const id = metadata && metadata.id; if (typeof id !== 'string' || !/^[a-f0-9]{8,64}$/.test(id)) return;
      if (await localBlob(id)) return;
      await saveBlob(id, new Blob([bytes], { type: String((metadata && metadata.type) || '') }));
    });
    NET.act.bdel.onMessage(async id => { if (typeof id === 'string') { await idbDel('blobs', id); const u = URLS.get(id); if (u) { URL.revokeObjectURL(u); URLS.delete(id); } } });
  }
  const assetsNs = {
    async upload(blob, opts) {
      if (!(blob instanceof Blob)) throw err('invalid_argument', 'upload needs a Blob');
      if (blob.size > MAX_BLOB) throw err('too_large', 'file over 20 MiB');
      const type = (opts && opts.type) || blob.type || 'application/octet-stream';
      const b = blob.type === type ? blob : new Blob([blob], { type });
      const id = hex(16); await saveBlob(id, b);
      const url = URL.createObjectURL(b); URLS.set(id, url);
      net().then(() => b.arrayBuffer()).then(ab => NET.act.bpush.send(new Uint8Array(ab), { metadata: { id, type } })).catch(() => { });
      return { id, url, sizeBytes: b.size, contentType: type };
    },
    async list() {
      const out = [];
      await store('blobs', 'readonly', (s, m) => {
        if (!s) { for (const [id, r] of m) out.push({ id, url: '/_blob/' + id, sizeBytes: r.blob.size, contentType: r.blob.type }); return null; }
        const r = s.openCursor(); r.onsuccess = () => { const c = r.result; if (c) { out.push({ id: c.key, url: '/_blob/' + c.key, sizeBytes: c.value.blob.size, contentType: c.value.blob.type }); c.continue(); } }; return null;
      }).catch(() => { });
      return { assets: out, usage: { count: out.length, bytes: out.reduce((a, x) => a + x.sizeBytes, 0) } };
    },
    async delete(id) {
      await idbDel('blobs', id); const u = URLS.get(id); if (u) { URL.revokeObjectURL(u); URLS.delete(id); }
      net().then(() => NET.act.bdel.send(id)).catch(() => { });
    },
  };

  /* ---- "/_blob/<id>" continua valendo: fetch e <img src> ---- */
  const blobId = v => {
    if (typeof v !== 'string') return null;
    const m = /^(?:https?:\/\/[^/]+)?\/_blob\/([A-Za-z0-9_-]{4,80})(?:[?#].*)?$/.exec(v);
    if (!m) return null;
    if (/^https?:/.test(v) && !v.startsWith(location.origin + '/')) return null;
    return m[1];
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const id = blobId(url);
    if (id == null) return nativeFetch(input, init);
    return getBlob(id).then(b => new Response(b, { status: 200, headers: { 'content-type': b.type || 'application/octet-stream' } }),
      () => new Response('', { status: 404 }));
  };
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: srcDesc.enumerable,
      get() { return srcDesc.get.call(this); },
      set(v) {
        const id = blobId(v);
        if (id == null) { this.__p2pWant = null; return srcDesc.set.call(this, v); }
        const el = this; el.__p2pWant = id; // src real entra quando o arquivo chegar (sem onload falso)
        blobUrl(id).then(u => { if (el.__p2pWant === id) srcDesc.set.call(el, u); },
          () => { if (el.__p2pWant === id) srcDesc.set.call(el, 'data:image/png;base64,AA=='); }); // vira onerror
      },
    });
  }

  /* ================================= USER ================================= */
  function myNick() { try { const v = JSON.parse(localStorage.getItem('twoowt-me') || '{}'); return String(v.nick || '').trim().slice(0, 20); } catch (e) { return ''; } }
  const userNs = {
    async id() { await net().catch(() => { }); return NET.self ? NET.self.userId : localId(); },
    async me() { const id = await userNs.id(); return { id, name: myNick(), guest: false }; },
    async name() { return myNick(); },
    async isOwner() { return true; },
    async canEdit() { return true; },
    async can() { return true; },               // coop entre amigos: todo mundo pode tudo
    async profiles(ids) {
      const out = {}; const me = NET.self && NET.self.userId;
      for (const id of ids || []) {
        let name = id === me ? myNick() : '';
        if (!name) for (const p of NET.peers.values()) if (p.by === id && p.presence && typeof p.presence.nick === 'string' && p.presence.nick.trim()) { name = p.presence.nick.trim().slice(0, 20); break; }
        out[id] = { id, name, guest: false };
      }
      return out;
    },
    async search() { return []; },
  };
  function localId() {
    try { let v = localStorage.getItem('twoowt-p2p-uid'); if (!v) { v = 'u_' + hex(12); localStorage.setItem('twoowt-p2p-uid', v); } return v; } catch (e) { return 'u_anon'; }
  }

  /* ============================ window.claude ============================ */
  const NS = {
    room: () => net().then(() => roomNs),
    db: () => Promise.resolve(dbNs),
    user: () => Promise.resolve(userNs),
    assets: () => Promise.resolve(assetsNs),
  };
  const memo = {};
  window.claude = Object.freeze({
    use(name) {
      if (!NS[name]) return new Promise(res => setTimeout(() => res(null), 0)); // sample, tts… = indisponível
      return memo[name] || (memo[name] = new Promise(res => setTimeout(res, 0)).then(NS[name]).then(v => Object.freeze(v), () => null));
    },
  });
  // abre a sala já (assim o db sincroniza mesmo antes da primeira presença)
  net().catch(() => { });
})();
