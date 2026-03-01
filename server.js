// =====================================================
//  BALLER.EXE — Game Server
//  MongoDB Atlas for permanent storage
//  Falls back to in-memory if MONGO_URL not set
//  Free deploy on Render.com
// =====================================================

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const cors         = require('cors');
const { v4: uuid } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*', methods:['GET','POST','PUT','PATCH','DELETE'] }});

const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ballerexe_change_in_prod';
const MONGO_URL  = process.env.MONGO_URL  || '';

// ─────────────────────────────────────────────────
//  DATABASE LAYER
//  Mongo if MONGO_URL is set, otherwise in-memory
// ─────────────────────────────────────────────────
let mongo = null;   // mongoose connection
let Col   = {};     // { users, clans, leagues, teams }

// In-memory fallback (no persistence across restarts)
const MEM = { users:{}, clans:{}, leagues:{}, shareTeams:{} };

async function connectMongo() {
  if (!MONGO_URL) {
    console.log('⚠️  No MONGO_URL — using in-memory storage (data resets on restart)');
    return false;
  }
  try {
    const mongoose = require('mongoose');
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
    mongo = mongoose;

    // ── Schemas ──────────────────────────────────
    const UserSchema = new mongoose.Schema({
      username:  { type: String, unique: true, index: true },
      password:  String,
      teamName:  String,
      avatar:    { type: String, default: '🤖' },
      color:     String,
      robots:    { type: Array,  default: [] },
      field:     { type: Object, default: {} },
      programs:  { type: Object, default: {} },
      record:    { type: Object, default: { w:0, d:0, l:0 } },
      rp:        { type: Number, default: 250 },
      clan:      { type: String, default: null },
      leagueId:  { type: String, default: null },
      shareCode: { type: String, default: null },
      createdAt: { type: Number, default: Date.now }
    }, { strict: false });

    const ClanSchema = new mongoose.Schema({
      id:        { type: String, unique: true, index: true },
      name:      String, tag: String, color: String, icon: String,
      owner:     String, createdAt: Number
    });

    const LeagueSchema = new mongoose.Schema({
      id:        { type: String, unique: true, index: true },
      name:      String,
      teams:     { type: Array, default: [] },
      createdAt: Number
    });

    const TeamShareSchema = new mongoose.Schema({
      code:     { type: String, unique: true, index: true },
      name:     String, robots: Array, programs: Object,
      field:    Object, savedAt: Number
    });

    Col.users   = mongoose.models.User      || mongoose.model('User',      UserSchema);
    Col.clans   = mongoose.models.Clan      || mongoose.model('Clan',      ClanSchema);
    Col.leagues = mongoose.models.League    || mongoose.model('League',    LeagueSchema);
    Col.teams   = mongoose.models.TeamShare || mongoose.model('TeamShare', TeamShareSchema);

    console.log('✅ MongoDB connected — data is permanent');
    return true;
  } catch(e) {
    console.error('❌ MongoDB failed:', e.message);
    console.log('⚠️  Falling back to in-memory storage');
    return false;
  }
}

// ── DB helpers: uniform API for both Mongo and in-memory ──

async function getUser(username) {
  if (mongo) return await Col.users.findOne({ username }).lean();
  return MEM.users[username] || null;
}

async function saveUser(username, data) {
  if (mongo) {
    await Col.users.findOneAndUpdate(
      { username },
      { $set: data },
      { upsert: true, new: true }
    );
  } else {
    MEM.users[username] = { ...(MEM.users[username]||{}), ...data };
  }
}

async function createUser(data) {
  if (mongo) {
    const doc = new Col.users(data);
    await doc.save();
    return doc.toObject();
  } else {
    MEM.users[data.username] = data;
    return data;
  }
}

async function userExists(username) {
  if (mongo) return !!(await Col.users.findOne({ username }).lean());
  return !!MEM.users[username];
}

async function getAllUsers() {
  if (mongo) return await Col.users.find({}).lean();
  return Object.values(MEM.users);
}

async function getClan(id) {
  if (mongo) return await Col.clans.findOne({ id }).lean();
  return MEM.clans[id] || null;
}

async function saveClan(id, data) {
  if (mongo) {
    await Col.clans.findOneAndUpdate({ id }, { $set: data }, { upsert: true });
  } else {
    MEM.clans[id] = { ...(MEM.clans[id]||{}), ...data };
  }
}

async function deleteClan(id) {
  if (mongo) await Col.clans.deleteOne({ id });
  else delete MEM.clans[id];
}

async function getAllClans() {
  if (mongo) return await Col.clans.find({}).lean();
  return Object.values(MEM.clans);
}

async function getLeague(id) {
  if (mongo) return await Col.leagues.findOne({ id }).lean();
  return MEM.leagues[id] || null;
}

async function saveLeague(id, data) {
  if (mongo) {
    await Col.leagues.findOneAndUpdate({ id }, { $set: data }, { upsert: true });
  } else {
    MEM.leagues[id] = { ...(MEM.leagues[id]||{}), ...data };
  }
}

async function deleteLeague(id) {
  if (mongo) await Col.leagues.deleteOne({ id });
  else delete MEM.leagues[id];
}

async function getAllLeagues() {
  if (mongo) return await Col.leagues.find({}).lean();
  return Object.values(MEM.leagues);
}

async function getTeamShare(code) {
  if (mongo) return await Col.teams.findOne({ code }).lean();
  return MEM.shareTeams[code] || null;
}

async function saveTeamShare(code, data) {
  if (mongo) {
    await Col.teams.findOneAndUpdate({ code }, { $set: { code, ...data } }, { upsert: true });
  } else {
    MEM.shareTeams[code] = data;
  }
}

async function deleteTeamShare(code) {
  if (mongo) await Col.teams.deleteOne({ code });
  else delete MEM.shareTeams[code];
}

// ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', async (_req, res) => {
  const users = await getAllUsers();
  const clans = await getAllClans();
  res.json({ status:'ok', game:'BALLER.EXE', players:users.length, clans:clans.length, storage: mongo ? 'mongodb' : 'memory' });
});

// ── Auth middleware ───────────────────────────────
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token — please log in again' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = await getUser(payload.username);
    if (!u) return res.status(401).json({ error: 'Account not found — please log in again' });
    req.user = payload;
    req.dbUser = u;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

const COLORS = ['#00e57a','#ff3d5a','#3d7eff','#f5c400','#9f6fff','#ff7a2f','#00d4a8','#ff4fa3'];
function safe(u) { const { password, _id, __v, ...s } = u; return s; }

// ─────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  try {
    const { username='', password='', teamName='' } = req.body;
    if (!username || !password)     return res.status(400).json({ error: 'Username and password required' });
    if (username.trim().length < 3) return res.status(400).json({ error: 'Username needs 3+ characters' });
    if (password.length < 4)        return res.status(400).json({ error: 'Password needs 4+ characters' });
    const u = username.trim().toLowerCase();
    if (await userExists(u))        return res.status(409).json({ error: 'Username already taken' });

    const newUser = {
      username: u, password: await bcrypt.hash(password, 10),
      teamName: teamName.trim() || u, avatar: '🤖',
      color:    COLORS[Math.floor(Math.random() * COLORS.length)],
      robots:[], field:{}, programs:{}, record:{w:0,d:0,l:0},
      rp: 250, clan: null, leagueId: null, createdAt: Date.now()
    };
    const saved = await createUser(newUser);
    const token = jwt.sign({ username: u }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safe(saved) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username='', password='' } = req.body;
    const u = await getUser(username.trim().toLowerCase());
    if (!u) return res.status(404).json({ error: 'Account not found' });
    if (!await bcrypt.compare(password, u.password)) return res.status(401).json({ error: 'Wrong password' });
    const token = jwt.sign({ username: u.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safe(u) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, (req, res) => res.json(safe(req.dbUser)));

app.patch('/api/me', auth, async (req, res) => {
  try {
    const { robots, programs, field, teamName, avatar, color, password } = req.body;
    const update = {};
    if (robots   !== undefined) update.robots   = robots;
    if (programs !== undefined) update.programs = programs;
    if (field    !== undefined) update.field    = field;
    if (teamName !== undefined) update.teamName = teamName;
    if (avatar   !== undefined) update.avatar   = avatar;
    if (color    !== undefined) update.color    = color;
    if (password) {
      if (password.length < 4) return res.status(400).json({ error: 'Password too short' });
      update.password = await bcrypt.hash(password, 10);
    }
    await saveUser(req.user.username, update);
    const updated = await getUser(req.user.username);
    res.json({ ok: true, user: safe(updated) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────
//  RANKED
// ─────────────────────────────────────────────────

app.post('/api/match-result', auth, async (req, res) => {
  try {
    const u = req.dbUser;
    const { result, homeScore=0, awayScore=0 } = req.body;
    const rpDelta = { win:+25, draw:+5, loss:-15 }[result] ?? 0;
    const newRp  = Math.max(0, (u.rp || 250) + rpDelta);
    const rec    = u.record || { w:0, d:0, l:0 };
    if (result === 'win')  rec.w++;
    if (result === 'loss') rec.l++;
    if (result === 'draw') rec.d++;
    await saveUser(u.username, { rp: newRp, record: rec });

    // Update league
    if (u.leagueId) {
      const league = await getLeague(u.leagueId);
      if (league) {
        const t = league.teams.find(t => t.player === u.username);
        if (t) {
          if (result === 'win')       { t.w++; t.pts += 3; }
          else if (result === 'draw') { t.d++; t.pts += 1; }
          else t.l++;
          t.gf = (t.gf||0) + homeScore;
          t.ga = (t.ga||0) + awayScore;
          await saveLeague(league.id, { teams: league.teams });
        }
      }
    }
    res.json({ rp: newRp, record: rec, rpChange: rpDelta });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const users = await getAllUsers();
    const top50 = users
      .map(u => ({ username:u.username, teamName:u.teamName, avatar:u.avatar, rp:u.rp||0, record:u.record||{w:0,d:0,l:0}, clan:u.clan }))
      .sort((a, b) => b.rp - a.rp)
      .slice(0, 50);
    res.json(top50);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────
//  CLANS
// ─────────────────────────────────────────────────

app.get('/api/clans', async (_req, res) => {
  try {
    const [clans, users] = await Promise.all([getAllClans(), getAllUsers()]);
    res.json(clans.map(c => ({ ...c, memberCount: users.filter(u => u.clan === c.id).length })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clans', auth, async (req, res) => {
  try {
    const u = req.dbUser;
    if (u.clan && await getClan(u.clan)) return res.status(400).json({ error: 'You are already in a clan' });
    const { name, tag, color, icon } = req.body;
    if (!name || !tag) return res.status(400).json({ error: 'Name and tag are required' });
    const TAG = tag.toUpperCase().slice(0, 3);
    const existing = await getAllClans();
    if (existing.find(c => c.tag === TAG)) return res.status(409).json({ error: 'Tag already taken' });
    const clan = { id:uuid(), name:name.trim(), tag:TAG, color:color||'#00e57a', icon:icon||'🛡️', owner:u.username, createdAt:Date.now() };
    await saveClan(clan.id, clan);
    await saveUser(u.username, { clan: clan.id });
    res.json(clan);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clans/leave', auth, async (req, res) => {
  try {
    await saveUser(req.user.username, { clan: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clans/:id/join', auth, async (req, res) => {
  try {
    const u = req.dbUser;
    if (u.clan && await getClan(u.clan)) return res.status(400).json({ error: 'Leave your current clan first' });
    const clan = await getClan(req.params.id);
    if (!clan) return res.status(404).json({ error: 'Clan not found' });
    await saveUser(u.username, { clan: clan.id });
    res.json(clan);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clans/:id/members', async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users.filter(u => u.clan === req.params.id)
      .map(u => ({ username:u.username, avatar:u.avatar, rp:u.rp||0, record:u.record||{w:0,d:0,l:0} })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────
//  LEAGUES
// ─────────────────────────────────────────────────

app.get('/api/leagues', async (_req, res) => {
  try { res.json(await getAllLeagues()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/join', auth, async (req, res) => {
  try {
    const u = req.dbUser;
    if (u.leagueId && await getLeague(u.leagueId)) return res.status(400).json({ error: 'Already in a league' });
    const all = await getAllLeagues();
    let league = all.find(l => l.teams.length < 8 && !l.teams.some(t => t.player === u.username));
    if (!league) {
      league = { id:uuid(), name:`League ${all.length + 1}`, teams:[], createdAt:Date.now() };
    }
    league.teams.push({ player:u.username, name:u.teamName||u.username, avatar:u.avatar, w:0,d:0,l:0,gf:0,ga:0,pts:0 });
    await saveLeague(league.id, league);
    await saveUser(u.username, { leagueId: league.id });
    res.json(league);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leagues/leave', auth, async (req, res) => {
  try {
    const u = req.dbUser;
    if (u.leagueId) {
      const league = await getLeague(u.leagueId);
      if (league) {
        league.teams = league.teams.filter(t => t.player !== u.username);
        if (!league.teams.length) await deleteLeague(u.leagueId);
        else await saveLeague(u.leagueId, { teams: league.teams });
      }
    }
    await saveUser(u.username, { leagueId: null });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leagues/:id', async (req, res) => {
  try {
    const l = await getLeague(req.params.id);
    if (!l) return res.status(404).json({ error: 'League not found' });
    res.json(l);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────
//  SHARE TEAM
// ─────────────────────────────────────────────────

app.post('/api/share-team', auth, async (req, res) => {
  try {
    const u = req.dbUser;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (u.shareCode) await deleteTeamShare(u.shareCode);
    await saveTeamShare(code, { name:u.teamName, robots:u.robots||[], programs:u.programs||{}, field:u.field||{}, savedAt:Date.now() });
    await saveUser(u.username, { shareCode: code });
    res.json({ code });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/team/:code', async (req, res) => {
  try {
    const t = await getTeamShare(req.params.code.toUpperCase());
    if (!t) return res.status(404).json({ error: 'Team not found' });
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────
//  SOCKET.IO
// ─────────────────────────────────────────────────
const matchQueue = [];
const rooms = {};

io.on('connection', socket => {
  console.log(`🔌 +${socket.id.slice(0,8)}`);

  socket.on('queue:join', ({ token, teamData }) => {
    try { socket.username = jwt.verify(token, JWT_SECRET).username; }
    catch { socket.username = 'Guest_' + socket.id.slice(0,4); }
    socket.teamData = teamData;

    const waiting = matchQueue.find(s => s.id !== socket.id && s.connected);
    if (waiting) {
      matchQueue.splice(matchQueue.indexOf(waiting), 1);
      const roomId = uuid();
      rooms[roomId] = { players:[waiting, socket], createdAt:Date.now() };
      waiting.join(roomId); socket.join(roomId);
      waiting.roomId = roomId; socket.roomId = roomId;
      io.to(roomId).emit('match:found', {
        roomId,
        home: { username:waiting.username, teamData:waiting.teamData },
        away: { username:socket.username,  teamData:socket.teamData  }
      });
      console.log(`⚽ ${waiting.username} vs ${socket.username}`);
    } else {
      matchQueue.push(socket);
      socket.emit('queue:waiting', { position: matchQueue.length });
    }
  });

  socket.on('queue:leave', () => {
    const i = matchQueue.indexOf(socket);
    if (i > -1) matchQueue.splice(i, 1);
    socket.emit('queue:left');
  });

  socket.on('match:goal',  d => socket.roomId && socket.to(socket.roomId).emit('match:goal',  d));
  socket.on('match:state', d => socket.roomId && socket.to(socket.roomId).emit('match:state', d));
  socket.on('match:end',   d => { if(socket.roomId){ socket.to(socket.roomId).emit('match:end', d); delete rooms[socket.roomId]; }});
  socket.on('match:chat', ({ message='' }) => {
    if (socket.roomId) io.to(socket.roomId).emit('match:chat', { from:socket.username, message:message.slice(0,120) });
  });

  socket.on('disconnect', () => {
    const i = matchQueue.indexOf(socket);
    if (i > -1) matchQueue.splice(i, 1);
    if (socket.roomId) { socket.to(socket.roomId).emit('match:opponent_left'); delete rooms[socket.roomId]; }
    console.log(`🔌 -${socket.id.slice(0,8)}`);
  });
});

// ─────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────
connectMongo().then(() => {
  server.listen(PORT, () => console.log(`\n⚽ BALLER.EXE → http://localhost:${PORT}\n`));
});
