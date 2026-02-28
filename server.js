// =====================================================
//  BALLER.EXE — Game Server  
//  Persistent JSON file storage — survives restarts
//  Free deploy on Render.com
// =====================================================

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const fs           = require('fs');
const path         = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*', methods:['GET','POST','PUT','PATCH','DELETE'] }});

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ballerexe_change_in_prod';

// ─────────────────────────────────────────────────
//  PERSISTENT FILE DATABASE
//  Saves to ./data/db.json — survives server restarts
// ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

function loadDB() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE))  return { users:{}, clans:{}, leagues:{}, shareTeams:{} };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {
    console.error('DB load error:', e.message);
    return { users:{}, clans:{}, leagues:{}, shareTeams:{} };
  }
}

let _saveTimer = null;
function saveDB() {
  // Debounced — writes at most once per second
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
    } catch(e) {
      console.error('DB save error:', e.message);
    }
  }, 1000);
}

// Load on startup
const DB = loadDB();
if (!DB.users)      DB.users      = {};
if (!DB.clans)      DB.clans      = {};
if (!DB.leagues)    DB.leagues    = {};
if (!DB.shareTeams) DB.shareTeams = {};

// matchQueue is always in-memory (socket references can't be serialized)
DB.matchQueue = [];

console.log(`📂 Loaded DB: ${Object.keys(DB.users).length} users, ${Object.keys(DB.clans).length} clans`);

// ─────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit:'2mb' }));

// Health check
app.get('/', (_req,res) => res.json({
  status:'ok', game:'BALLER.EXE',
  players: Object.keys(DB.users).length,
  clans:   Object.keys(DB.clans).length
}));

// ── Auth middleware ───────────────────────────────
function auth(req,res,next){
  const token = (req.headers.authorization||'').split(' ')[1];
  if(!token) return res.status(401).json({error:'No token — please log in again'});
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Double-check user still exists in DB
    if(!DB.users[req.user.username])
      return res.status(401).json({error:'Account not found — please log in again'});
    next();
  } catch(e) {
    res.status(401).json({error:'Session expired — please log in again'});
  }
}

// ── Helpers ───────────────────────────────────────
const COLORS = ['#00e57a','#ff3d5a','#3d7eff','#f5c400','#9f6fff','#ff7a2f','#00d4a8','#ff4fa3'];
function safe(u){ const {password,...s}=u; return s; }

// ─────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────

app.post('/api/register', async (req,res) => {
  const {username='', password='', teamName=''} = req.body;
  if(!username||!password)     return res.status(400).json({error:'Username and password required'});
  if(username.trim().length<3) return res.status(400).json({error:'Username needs 3+ characters'});
  if(password.length<4)        return res.status(400).json({error:'Password needs 4+ characters'});
  const u = username.trim().toLowerCase();
  if(DB.users[u])              return res.status(409).json({error:'Username already taken'});

  DB.users[u] = {
    username: u,
    password: await bcrypt.hash(password, 10),
    teamName: teamName.trim() || u,
    avatar:   '🤖',
    color:    COLORS[Math.floor(Math.random()*COLORS.length)],
    robots:[], field:{}, programs:{},
    record:   {w:0,d:0,l:0},
    rp:250, clan:null, leagueId:null,
    createdAt: Date.now()
  };
  saveDB();

  const token = jwt.sign({username:u}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user:safe(DB.users[u]) });
});

app.post('/api/login', async (req,res) => {
  const {username='', password=''} = req.body;
  const u = DB.users[username.trim().toLowerCase()];
  if(!u) return res.status(404).json({error:'Account not found'});
  if(!await bcrypt.compare(password, u.password)) return res.status(401).json({error:'Wrong password'});

  const token = jwt.sign({username:u.username}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user:safe(u) });
});

app.get('/api/me', auth, (req,res) => {
  res.json(safe(DB.users[req.user.username]));
});

app.patch('/api/me', auth, async (req,res) => {
  const u = DB.users[req.user.username];
  const {robots, programs, field, teamName, avatar, color, password} = req.body;
  if(robots   !==undefined) u.robots   = robots;
  if(programs !==undefined) u.programs = programs;
  if(field    !==undefined) u.field    = field;
  if(teamName !==undefined) u.teamName = teamName;
  if(avatar   !==undefined) u.avatar   = avatar;
  if(color    !==undefined) u.color    = color;
  if(password){
    if(password.length<4) return res.status(400).json({error:'Password too short'});
    u.password = await bcrypt.hash(password,10);
  }
  saveDB();
  res.json({ ok:true, user:safe(u) });
});

// ─────────────────────────────────────────────────
//  RANKED
// ─────────────────────────────────────────────────

app.post('/api/match-result', auth, (req,res) => {
  const u = DB.users[req.user.username];
  const {result, homeScore=0, awayScore=0} = req.body;
  const rpDelta = {win:+25, draw:+5, loss:-15}[result] ?? 0;
  u.rp = Math.max(0,(u.rp||250)+rpDelta);
  if(!u.record) u.record={w:0,d:0,l:0};
  if(result==='win')  u.record.w++;
  if(result==='loss') u.record.l++;
  if(result==='draw') u.record.d++;

  if(u.leagueId && DB.leagues[u.leagueId]){
    const t = DB.leagues[u.leagueId].teams.find(t=>t.player===u.username);
    if(t){
      if(result==='win'){t.w++;t.pts+=3;}
      else if(result==='draw'){t.d++;t.pts+=1;}
      else t.l++;
      t.gf=(t.gf||0)+homeScore;
      t.ga=(t.ga||0)+awayScore;
    }
  }
  saveDB();
  res.json({ rp:u.rp, record:u.record, rpChange:rpDelta });
});

app.get('/api/leaderboard', (_req,res) => {
  const top50 = Object.values(DB.users)
    .map(u=>({ username:u.username, teamName:u.teamName, avatar:u.avatar,
               rp:u.rp||0, record:u.record||{w:0,d:0,l:0}, clan:u.clan }))
    .sort((a,b)=>b.rp-a.rp)
    .slice(0,50);
  res.json(top50);
});

// ─────────────────────────────────────────────────
//  CLANS
// ─────────────────────────────────────────────────

app.get('/api/clans', (_req,res) => {
  const list = Object.values(DB.clans).map(c=>({
    ...c,
    memberCount: Object.values(DB.users).filter(u=>u.clan===c.id).length
  }));
  res.json(list);
});

app.post('/api/clans', auth, (req,res) => {
  const u = DB.users[req.user.username];
  // Force-clear stale clan if the clan no longer exists
  if(u.clan && !DB.clans[u.clan]) u.clan = null;
  if(u.clan) return res.status(400).json({error:'You are already in a clan'});

  const {name,tag,color,icon} = req.body;
  if(!name||!tag) return res.status(400).json({error:'Name and tag are required'});
  const TAG = tag.toUpperCase().slice(0,3);
  if(Object.values(DB.clans).find(c=>c.tag===TAG))
    return res.status(409).json({error:'Tag already taken'});

  const clan = {
    id:uuid(), name:name.trim(), tag:TAG,
    color:color||'#00e57a', icon:icon||'🛡️',
    owner:u.username, createdAt:Date.now()
  };
  DB.clans[clan.id] = clan;
  u.clan = clan.id;
  saveDB();
  res.json(clan);
});

// IMPORTANT: /api/clans/leave must be defined BEFORE /api/clans/:id/join
// otherwise Express matches "leave" as an :id param
app.post('/api/clans/leave', auth, (req,res) => {
  const u = DB.users[req.user.username];
  u.clan = null;
  saveDB();
  res.json({ok:true});
});

app.post('/api/clans/:id/join', auth, (req,res) => {
  const u = DB.users[req.user.username];
  // Auto-clear stale clan reference (clan was deleted / server reset)
  if(u.clan && !DB.clans[u.clan]) u.clan = null;
  if(u.clan) return res.status(400).json({error:'You are already in a clan — leave first'});

  const clan = DB.clans[req.params.id];
  if(!clan) return res.status(404).json({error:'Clan not found'});

  u.clan = clan.id;
  saveDB();
  res.json(clan);
});

app.get('/api/clans/:id/members', (req,res) => {
  const members = Object.values(DB.users)
    .filter(u=>u.clan===req.params.id)
    .map(u=>({username:u.username,avatar:u.avatar,rp:u.rp||0,record:u.record||{w:0,d:0,l:0}}));
  res.json(members);
});

// ─────────────────────────────────────────────────
//  LEAGUES
// ─────────────────────────────────────────────────

app.get('/api/leagues', (_req,res) => res.json(Object.values(DB.leagues)));

app.post('/api/leagues/join', auth, (req,res) => {
  const u = DB.users[req.user.username];
  // Auto-clear stale league reference
  if(u.leagueId && !DB.leagues[u.leagueId]) u.leagueId = null;
  if(u.leagueId) return res.status(400).json({error:'Already in a league'});

  let league = Object.values(DB.leagues).find(
    l=>l.teams.length<8 && !l.teams.some(t=>t.player===u.username)
  );
  if(!league){
    league = {id:uuid(), name:`League ${Object.keys(DB.leagues).length+1}`, teams:[], createdAt:Date.now()};
    DB.leagues[league.id] = league;
  }
  league.teams.push({
    player:u.username, name:u.teamName||u.username, avatar:u.avatar,
    w:0, d:0, l:0, gf:0, ga:0, pts:0
  });
  u.leagueId = league.id;
  saveDB();
  res.json(league);
});

// /api/leagues/leave must be before /api/leagues/:id
app.post('/api/leagues/leave', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(u.leagueId && DB.leagues[u.leagueId]){
    DB.leagues[u.leagueId].teams = DB.leagues[u.leagueId].teams.filter(t=>t.player!==u.username);
    if(!DB.leagues[u.leagueId].teams.length) delete DB.leagues[u.leagueId];
  }
  u.leagueId = null;
  saveDB();
  res.json({ok:true});
});

app.get('/api/leagues/:id', (req,res) => {
  const l = DB.leagues[req.params.id];
  if(!l) return res.status(404).json({error:'League not found'});
  res.json(l);
});

// ─────────────────────────────────────────────────
//  SHARE TEAM
// ─────────────────────────────────────────────────

app.post('/api/share-team', auth, (req,res) => {
  const u = DB.users[req.user.username];
  // Generate a fresh random 6-char alphanumeric code each time
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  // Store snapshot of current team data
  DB.shareTeams[code] = {
    name:     u.teamName,
    robots:   u.robots   || [],
    programs: u.programs || {},
    field:    u.field    || {},
    savedAt:  Date.now()
  };
  // Also index by username so old codes from same user are replaced
  if(u.shareCode && u.shareCode !== code) delete DB.shareTeams[u.shareCode];
  u.shareCode = code;
  saveDB();
  res.json({ code });
});

app.get('/api/team/:code', (req,res) => {
  const t = DB.shareTeams[req.params.code.toUpperCase()];
  if(!t) return res.status(404).json({error:'Team not found'});
  res.json(t);
});

// ─────────────────────────────────────────────────
//  SOCKET.IO — Live matchmaking
// ─────────────────────────────────────────────────
const rooms = {};

io.on('connection', socket => {
  console.log(`🔌 +${socket.id.slice(0,8)}`);

  socket.on('queue:join', ({token, teamData}) => {
    try{ socket.username = jwt.verify(token, JWT_SECRET).username; }
    catch{ socket.username = 'Guest_'+socket.id.slice(0,4); }
    socket.teamData = teamData;

    const waiting = DB.matchQueue.find(s=>s.id!==socket.id && s.connected);
    if(waiting){
      DB.matchQueue = DB.matchQueue.filter(s=>s.id!==waiting.id);
      const roomId = uuid();
      rooms[roomId] = {players:[waiting,socket], createdAt:Date.now()};
      waiting.join(roomId); socket.join(roomId);
      waiting.roomId = roomId; socket.roomId = roomId;
      io.to(roomId).emit('match:found', {
        roomId,
        home:{ username:waiting.username, teamData:waiting.teamData },
        away:{ username:socket.username,  teamData:socket.teamData  }
      });
      console.log(`⚽ ${waiting.username} vs ${socket.username}`);
    } else {
      DB.matchQueue.push(socket);
      socket.emit('queue:waiting', {position:DB.matchQueue.length});
    }
  });

  socket.on('queue:leave', () => {
    DB.matchQueue = DB.matchQueue.filter(s=>s.id!==socket.id);
    socket.emit('queue:left');
  });

  socket.on('match:goal',  d => socket.roomId && socket.to(socket.roomId).emit('match:goal',d));
  socket.on('match:state', d => socket.roomId && socket.to(socket.roomId).emit('match:state',d));
  socket.on('match:end',   d => {
    if(socket.roomId){ socket.to(socket.roomId).emit('match:end',d); delete rooms[socket.roomId]; }
  });
  socket.on('match:chat', ({message=''}) => {
    if(socket.roomId) io.to(socket.roomId).emit('match:chat',{from:socket.username, message:message.slice(0,120)});
  });

  socket.on('disconnect', () => {
    DB.matchQueue = DB.matchQueue.filter(s=>s.id!==socket.id);
    if(socket.roomId){ socket.to(socket.roomId).emit('match:opponent_left'); delete rooms[socket.roomId]; }
    console.log(`🔌 -${socket.id.slice(0,8)}`);
  });
});

// ─────────────────────────────────────────────────
server.listen(PORT, () => console.log(`\n⚽ BALLER.EXE server → http://localhost:${PORT}\n`));
