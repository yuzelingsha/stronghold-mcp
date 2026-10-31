import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const WS_OPEN = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_QUEUE = 200;
const MAX_RECENT = 100;
const MAX_MESSAGES = 50;
/** The browser's heartbeat and reconnect pacing (public/js/net.js). */
const PING_INTERVAL_MS = 4_000;
const DEAD_AFTER_MS = 15_000;
const BACKOFF = Object.freeze({ base: 500, factor: 2, max: 10_000, jitter: 0.2 });
/** "Session replaced": the same token connected from elsewhere. Reconnecting would fight that session. */
const CLOSE_REPLACED = 4001;

function backoffDelay({ base, factor, max, jitter }, attempt) {
  const raw = Math.min(max, base * factor ** attempt);
  return Math.round(raw + raw * jitter * (Math.random() * 2 - 1));
}

function timeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${timeoutMs} ms`);
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cookiePair(raw) {
  if (typeof raw !== 'string') return null;
  const match = /(?:^|,\s*)([^=;\s]+=[^;\s]+)/.exec(raw);
  return match ? match[1] : null;
}

/** The `welcome` frame carries a reconnect token; never hand it back to a model or a log. */
function redactWelcome(value) {
  if (!value || typeof value !== 'object') return value;
  const { token, ...safe } = value;
  void token;
  return safe;
}

export function deriveHttpUrl(wsUrl) {
  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = url.pathname.replace(/\/ws\/?$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'http://127.0.0.1:3000';
  }
}

/**
 * One real player connection to a Stronghold Protocol server.
 *
 * It speaks only the game's own public WebSocket protocol — `hello`, then `room.*` / `g.*` / `b.*`
 * messages and the server's normal state frames — so the server validates every message exactly as it
 * validates a browser. Nothing here is privileged and nothing bypasses server authority.
 *
 * Like a browser it keeps its seat online. A heartbeat finds a socket that went silent without closing (a path can
 * die with `readyState` still OPEN, and only the next write would tell), and a lost socket is reopened with the
 * reconnect token until close(). `hello` is a full resync, so the seat and any battle it owns come back with it.
 *
 * Configuration (constructor options win over the environment):
 *   STRONGHOLD_WS_URL        ws(s):// endpoint of the game server
 *   STRONGHOLD_HTTP_URL      HTTP origin used for the login cookie (derived from the WS URL)
 *   STRONGHOLD_NAME          the display name this seat connects as
 *   STRONGHOLD_AUTH_COOKIE   a pre-obtained session cookie (skips the login request)
 *   STRONGHOLD_AUTH_USER     / STRONGHOLD_AUTH_PASSWORD   credentials for the login request
 *                            (SP_AUTH_USER / SP_AUTH_PASSWORD, the game server's own names, when these are unset)
 */
export class StrongholdClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = String(options.wsUrl || process.env.STRONGHOLD_WS_URL || 'ws://127.0.0.1:3000/ws');
    this.httpUrl = String(options.httpUrl || process.env.STRONGHOLD_HTTP_URL || deriveHttpUrl(this.wsUrl));
    this.name = String(options.name || process.env.STRONGHOLD_NAME || 'MCP Player');
    this.authCookie = String(options.authCookie || process.env.STRONGHOLD_AUTH_COOKIE || '').trim() || null;
    this.authUser = options.authUser ?? process.env.STRONGHOLD_AUTH_USER ?? process.env.SP_AUTH_USER ?? '';
    this.authPassword = options.authPassword ?? process.env.STRONGHOLD_AUTH_PASSWORD ?? process.env.SP_AUTH_PASSWORD ?? '';
    this.ws = null;
    this.connectPromise = null;
    this.cookiePromise = null;
    this.sessionToken = null;
    this.playerId = null;
    this.welcome = null;
    this.pending = new Map();
    this.nextRid = 1;
    this.events = [];
    this.waiters = [];
    this.last = Object.create(null);
    this.lastError = null;
    /** When the most recent state frame arrived, or null when nothing has arrived since the last hello. */
    this.framesAt = null;
    /** When the latest frame of each type arrived, since the last hello. */
    this.frameAt = Object.create(null);
    /** This seat's newest emote of the match, { at, round }: the messages ring can drop it long before a round ends. */
    this.lastEmote = null;
    /** Toasts, ticker lines, emotes, closures: what a human reads as it passes, kept across resyncs. */
    this.messages = [];
    this.nextMessageId = 1;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.deadAfterMs = options.deadAfterMs ?? DEAD_AFTER_MS;
    this.backoff = options.backoff ?? BACKOFF;
    /** True from connect() until close(): a socket lost in between is reopened. */
    this.keepOnline = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    /** When the oldest ping with no inbound frame since was sent. */
    this.unansweredSince = null;
    /** Set by a battle adapter (see `mcp/battle/`) so `snapshot()` can report its status. */
    this.battleSimulation = null;
    /** Set by a battle adapter: the game's own range rule, from the simulation tree it loaded. */
    this.attackRangeGrid = null;
    /** Set by mcp/recorder.js when this seat keeps a local match log. */
    this.recorder = null;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WS_OPEN && !!this.playerId;
  }

  async connect(name = null) {
    if (name != null) this.name = String(name);
    this.keepOnline = true;
    if (this.connected) return redactWelcome(this.welcome);
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._connect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _connect() {
    let cookie = await this._getAuthCookie();
    let headers = cookie ? { Cookie: cookie } : undefined;
    let ws;
    try {
      ws = await this._openWebSocket(headers);
    } catch (err) {
      // If we got a 401 and we have user/password credentials, the session cookie expired
      // (e.g. server restarted and regenerated its signing secret). Invalidate cookie and retry login once.
      const is401 = String(err?.message || '').includes('401');
      if (is401 && this.authUser && this.authPassword) {
        this.authCookie = null;
        this.sessionToken = null;
        cookie = await this._getAuthCookie();
        headers = cookie ? { Cookie: cookie } : undefined;
        ws = await this._openWebSocket(headers);
      } else {
        throw err;
      }
    }
    this.ws = ws;

    try {
      // A `hello` is a full resync: the server answers with `welcome` and then re-sends room.state and
      // (when in a match) m.public / m.private. Anything cached from a previous session is therefore
      // not "the latest frame" any more, and keeping it would let an agent reason about a match that
      // already ended. Drop it first; whatever is still true arrives again within this same handshake.
      this._clearCachedFrames();
      const rid = this._nextRid();
      const welcome = await this._requestFrame({
        t: 'hello',
        rid,
        name: this.name,
        version: 1,
        ...(this.sessionToken ? { token: this.sessionToken } : {}),
      }, { resolveTypes: new Set(['welcome']), label: 'hello' });
      this.welcome = welcome;
      this.playerId = welcome.playerId || null;
      this.sessionToken = welcome.token || this.sessionToken;
      this.last.welcome = welcome;
      this.reconnectAttempt = 0;
      this._startHeartbeat(ws);
      this.emit('welcome', welcome);
      return redactWelcome(welcome);
    } catch (error) {
      try { ws.close(); } catch { /* ignore */ }
      if (this.ws === ws) this.ws = null;
      throw error;
    }
  }

  _openWebSocket(headers) {
    const ws = new WebSocket(this.wsUrl, { headers });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError('WebSocket open', DEFAULT_TIMEOUT_MS)), DEFAULT_TIMEOUT_MS);
      const onOpen = () => {
        clearTimeout(timer);
        ws.removeListener('error', onError);
        ws.on('message', (data, isBinary) => this._onMessage(data, isBinary));
        ws.on('error', (error) => {
          if (ws !== this.ws) return;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.emit('socket.error', { error: this.lastError });
        });
        ws.once('close', (code, reason) => this._onClose(ws, code, reason));
        resolve(ws);
      };
      const onError = (error) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  async _getAuthCookie() {
    if (this.authCookie) return this.authCookie;
    if (!this.authUser && !this.authPassword) return null;
    if (!this.authUser || !this.authPassword) throw new Error('Stronghold auth requires both user and password');
    if (this.cookiePromise) return this.cookiePromise;
    this.cookiePromise = (async () => {
      const response = await fetch(new URL('/login', this.httpUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: this.authUser, password: this.authPassword }),
        redirect: 'manual',
      });
      if (response.status !== 200 && response.status !== 302 && response.status !== 303) {
        throw new Error(`Stronghold login failed with HTTP ${response.status}`);
      }
      const cookie = cookiePair(response.headers.get('set-cookie'));
      if (!cookie) throw new Error('Stronghold login returned no session cookie');
      this.authCookie = cookie;
      return cookie;
    })();
    try {
      return await this.cookiePromise;
    } finally {
      this.cookiePromise = null;
    }
  }

  /**
   * The session cookie, obtaining it if needed. Exposed because anything else that reads from the same
   * site — the simulation's module tree, for instance — needs the same credential the socket uses.
   * Returns null on a site with no login gate.
   */
  async ensureAuthCookie() {
    return this._getAuthCookie();
  }

  async rename(name) {
    await this.connect();
    this._clearCachedFrames();
    const rid = this._nextRid();
    const welcome = await this._requestFrame({
      t: 'hello', rid, name: String(name), version: 1,
      ...(this.sessionToken ? { token: this.sessionToken } : {}),
    }, { resolveTypes: new Set(['welcome']), label: 'rename' });
    this.name = String(name);
    this.welcome = welcome;
    this.playerId = welcome.playerId || this.playerId;
    this.sessionToken = welcome.token || this.sessionToken;
    this.last.welcome = welcome;
    return redactWelcome(welcome);
  }

  /**
   * Send one protocol action and (unless it is a fire-and-forget battle report) await its `ok`.
   * The game server is still the one that decides whether the action is legal.
   */
  async action(type, fields = {}, options = {}) {
    const t = String(type);
    const data = asPlainObject(fields);
    if (t === 'hello') return this.rename(data.name || this.name);
    await this.connect();
    const noReply = options.waitForReply === false || FIRE_AND_FORGET.has(t);
    const rid = noReply ? null : this._nextRid();
    const frame = { ...data, t, ...(rid == null ? {} : { rid }) };
    if (noReply) {
      this._send(frame);
      return { sent: true, type: t };
    }
    const reply = await this._requestFrame(frame, { resolveTypes: new Set(['ok']), label: t, timeoutMs: options.timeoutMs });
    if (LEAVES_ROOM.has(t)) this._clearRoomFrames();
    return { sent: true, type: t, reply };
  }

  /** Resolve with the next server event, or with one already queued whose `t` is in `types`. */
  async waitForEvent(types = null, timeoutMs = 15_000) {
    const wanted = types == null ? null : new Set((Array.isArray(types) ? types : [types]).map(String));
    const index = this.events.findIndex((event) => !wanted || wanted.has(event.t));
    if (index >= 0) return this.events.splice(index, 1)[0];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(timeoutError('Stronghold event', timeoutMs));
      }, timeoutMs);
      const waiter = { wanted, resolve: (event) => { clearTimeout(timer); resolve(event); } };
      this.waiters.push(waiter);
    });
  }

  /** The most recent frame per type, plus connection facts. This is what an agent observes. */
  snapshot(includeRecent = true) {
    const result = {
      connection: {
        connected: this.connected,
        wsUrl: this.wsUrl,
        playerId: this.playerId,
        name: this.name,
        hasSessionToken: !!this.sessionToken,
        reconnecting: this.keepOnline && !this.connected,
        lastError: this.lastError,
        // null = nothing has arrived since the last hello. A large age means the seat is quiet (a
        // finished match, a dropped socket), not that the match is paused.
        framesAgeMs: this.framesAt == null ? null : Date.now() - this.framesAt,
        frameAgesMs: Object.fromEntries(Object.entries(this.frameAt).map(([type, at]) => [type, Date.now() - at])),
      },
      welcome: redactWelcome(this.welcome),
      last: {
        ...this.last,
        ...(this.last.welcome ? { welcome: redactWelcome(this.last.welcome) } : {}),
      },
      messages: this.messages.slice(),
      lastEmote: this.lastEmote,
      queuedEvents: this.events.length,
      ...(this.battleSimulation ? { battleSimulation: this.battleSimulation } : {}),
      ...(this.recorder ? { recorder: this.recorder } : {}),
    };
    if (includeRecent) result.recentEvents = this.events.slice(-MAX_RECENT);
    return result;
  }

  async close() {
    this.keepOnline = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._stopHeartbeat();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Stronghold connection closed'));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    this.playerId = null;
    if (!ws) return;
    try { ws.close(); } catch { /* ignore */ }
    // The socket's own close event arrives later and is ignored by then (see _onClose), so the session
    // ends here, once, for everything listening — a battle runner stops its battles on this.
    this.emit('socket.close', { code: 1000, reason: 'closed by the client' });
  }

  _nextRid() {
    this.nextRid = (this.nextRid % 2_147_483_000) + 1;
    return this.nextRid;
  }

  /**
   * Drop every cached frame and queued event.
   *
   * Called before each `hello`, because that handshake is a full resync: the server re-sends the
   * current room and match state, so keeping the previous session's frames would only let a caller
   * read a match that is already over as if it were live.
   */
  _clearCachedFrames() {
    this.last = Object.create(null);
    this.events = [];
    this.framesAt = null;
    this.frameAt = Object.create(null);
  }

  /**
   * The seat is out of its room. The server sends a leaver nothing more, so the room's and match's last frames would
   * stay on as if they were current, on a connection that still reads as healthy.
   */
  _clearRoomFrames() {
    const { welcome } = this.last;
    this._clearCachedFrames();
    this.lastEmote = null;
    if (welcome) this.last.welcome = welcome;
    this.emit('room.left');
  }

  _startHeartbeat(ws) {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws !== this.ws) return;
      const now = Date.now();
      if (this.unansweredSince != null && now - this.unansweredSince > this.deadAfterMs) {
        // The close event this raises goes through _onClose like any other lost socket.
        ws.terminate();
        return;
      }
      try {
        this._send({ t: 'ping', c: now });
        this.unansweredSince ??= now;
      } catch { /* closing: _onClose takes it from here */ }
    }, this.pingIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unansweredSince = null;
  }

  _scheduleReconnect() {
    if (!this.keepOnline || this.reconnectTimer) return;
    const delay = backoffDelay(this.backoff, this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this._reconnect(), delay);
    this.reconnectTimer.unref?.();
  }

  async _reconnect() {
    this.reconnectTimer = null;
    if (!this.keepOnline) return;
    try {
      await this.connect();
      this.lastError = null;
      // close() may have arrived while the handshake ran.
      if (!this.keepOnline) await this.close();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this._scheduleReconnect();
    }
  }

  _rememberMessage(msg) {
    this.messages.push({ id: this.nextMessageId++, at: Date.now(), round: this.last['m.public']?.round ?? null, frame: msg });
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
  }

  _requestFrame(frame, { resolveTypes, label, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
      const rid = frame.rid;
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(timeoutError(label, timeoutMs));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, resolveTypes, timer, label });
      try {
        this._send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(error);
      }
    });
  }

  _send(frame) {
    if (!this.ws || this.ws.readyState !== WS_OPEN) throw new Error('Stronghold WebSocket is not connected');
    this.ws.send(JSON.stringify(frame));
  }

  _onMessage(data, isBinary) {
    this.unansweredSince = null;
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'pong' && msg.rid == null) return;
    if (MESSAGE_FRAMES.has(msg.t)) this._rememberMessage(msg);
    if (msg.t === 'm.emote' && msg.playerId === this.playerId) this.lastEmote = { at: Date.now(), round: this.last['m.public']?.round ?? null };
    if (msg.t === 'room.state' && !msg.inMatch) this.lastEmote = null; // the next match starts from silence
    if (msg.t === 'welcome') {
      this.welcome = msg;
      this.playerId = msg.playerId || this.playerId;
      this.sessionToken = msg.token || this.sessionToken;
      this.last.welcome = msg;
    }
    if (msg.t === 'room.closed') this._clearRoomFrames();
    // A scout ends when battle fields come up: the screen returns to the player's own field.
    if (msg.t === 'm.public' && msg.fields?.length && this.last['m.field']?.prep) delete this.last['m.field'];
    this.last[msg.t] = msg;
    this.frameAt[msg.t] = Date.now();
    if (STATE_FRAMES.has(msg.t)) this.framesAt = Date.now();
    this.emit(msg.t === 'error' ? 'protocol.error' : msg.t, msg);

    const rid = msg.rid;
    const pending = rid == null ? null : this.pending.get(rid);
    if (pending && pending.resolveTypes.has(msg.t)) {
      clearTimeout(pending.timer);
      this.pending.delete(rid);
      if (msg.t === 'error') pending.reject(new Error(msg.detail || msg.msg || msg.code || 'Stronghold request failed'));
      else pending.resolve(msg);
      return;
    }
    if (pending && msg.t === 'error') {
      clearTimeout(pending.timer);
      this.pending.delete(rid);
      pending.reject(new Error(msg.detail || msg.msg || msg.code || 'Stronghold request failed'));
      return;
    }
    if (!['welcome', 'ok', 'error', 'pong'].includes(msg.t)) this._pushEvent(msg);
  }

  _pushEvent(msg) {
    // A state frame replaces the one still queued: a reader wants the current state, not how it got there. The new
    // frame goes to the back, so it keeps its order against the events around it.
    const key = stateKey(msg);
    if (key) this.events = this.events.filter((event) => stateKey(event) !== key);
    while (this.events.length >= MAX_QUEUE) this.events.shift();
    const waiterIndex = this.waiters.findIndex((waiter) => !waiter.wanted || waiter.wanted.has(msg.t));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      waiter.resolve(msg);
      return;
    }
    this.events.push(msg);
  }

  _onClose(ws, code, reason) {
    // A socket this client already let go of (close(), a failed handshake) can finish closing after a
    // new one has opened. Its close describes nothing current: acting on it would tear down the new
    // session and reject the new session's requests.
    if (ws !== this.ws) return;
    this.ws = null;
    this.playerId = null;
    this._stopHeartbeat();
    const text = reason?.toString?.() || '';
    this.lastError = `WebSocket closed (${code}${text ? `: ${text}` : ''})`;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(this.lastError));
    }
    this.pending.clear();
    this.emit('socket.close', { code, reason: text });
    if (code === CLOSE_REPLACED) this.keepOnline = false;
    else this._scheduleReconnect();
  }
}

/**
 * The protocol treats these as live reports rather than requests, so waiting for an `ok` would
 * always time out. A browser sends them the same way.
 */
export const FIRE_AND_FORGET = new Set(['b.progress', 'b.result', 'b.rehearsalResult']);

/** Actions after which this seat has no room; the server treats both as a permanent departure. */
const LEAVES_ROOM = new Set(['room.leave', 'g.leave']);

/** What a human reads as it passes: observe keeps a short history of these. */
const MESSAGE_FRAMES = new Set(['m.toast', 'm.ticker', 'm.emote', 'room.closed']);

/** The frames where only the newest matters, per type or per type and field. */
const STATE_PER_TYPE = new Set(['m.public', 'm.private', 'room.state', 'b.pool']);
const STATE_PER_FIELD = new Set(['m.field', 'b.snap']);

function stateKey(msg) {
  if (STATE_PER_TYPE.has(msg.t)) return msg.t;
  return STATE_PER_FIELD.has(msg.t) ? `${msg.t}:${msg.fieldId}` : null;
}

/** Frames that describe the world, as opposed to acknowledging a request. */
const STATE_FRAMES = new Set([
  'room.state', 'm.public', 'm.private', 'm.field', 'm.result', 'm.layer', 'm.ticker',
  'b.start', 'b.pool', 'b.end', 'b.rehearsal',
]);
