// =====================================================
//  BALLER.EXE — Game Server
//  Routes match the game client exactly (/api/...)
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

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ballerexe_change_in_prod';

// ── In-memory store ──────────────────────────────
// Data resets if server restarts on free tier.
// Upgrade to MongoDB Atlas (free) for persistence — see README.
const DB = {
  users:      {},  // username → user
  clans:      {},  // clanId   → clan
  leagues:    {},  // leagueId → league
  shareTeams: {},  // code     → teamData
  matchQueue: []   // sockets waiting for live match
};

app.use(cors());
app.use(express.json({ limit:'2mb' }));

// ── Health — Render pings this ────────────────────
app.get('/', (_req,res) => res.json({
  status:'ok', game:'BALLER.EXE',
  players: Object.keys(DB.users).length,
  clans:   Object.keys(DB.clans).length
}));

// ── Auth middleware ───────────────────────────────
function auth(req,res,next){
  const token = req.headers.authorization?.split(' ')[1];
  if(!token) return res.status(401).json({error:'No token'});
  try{ req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch{ res.status(401).json({error:'Invalid or expired token'}); }
}

// ── Helpers ───────────────────────────────────────
const COLORS = ['#00e57a','#ff3d5a','#3d7eff','#f5c400','#9f6fff','#ff7a2f','#00d4a8','#ff4fa3'];
function safe(u){ const {password,...s}=u; return s; }
function getUser(req,res){ const u=DB.users[req.user.username]; if(!u) res.status(404).json({error:'User not found'}); return u; }

// ─────────────────────────────────────────────────
//  AUTH  /api/register  /api/login  /api/me
// ─────────────────────────────────────────────────

// POST /api/register
app.post('/api/register', async (req,res) => {
  const {username='',password='',teamName=''} = req.body;
  if(!username||!password)      return res.status(400).json({error:'Username and password required'});
  if(username.trim().length<3)  return res.status(400).json({error:'Username needs 3+ characters'});
  if(password.length<4)         return res.status(400).json({error:'Password needs 4+ characters'});
  const u = username.trim();
  if(DB.users[u])               return res.status(409).json({error:'Username already taken'});

  DB.users[u] = {
    username: u,
    password: await bcrypt.hash(password, 10),
    teamName: teamName.trim() || u,
    avatar:   '🤖',
    color:    COLORS[Math.floor(Math.random()*COLORS.length)],
    robots:   [], field:{}, programs:{},
    record:   {w:0,d:0,l:0},
    rp:       250, clan:null, leagueId:null,
    createdAt: Date.now()
  };

  const token = jwt.sign({username:u}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user:safe(DB.users[u]) });
});

// POST /api/login
app.post('/api/login', async (req,res) => {
  const {username='',password=''} = req.body;
  const u = DB.users[username.trim()];
  if(!u)                                     return res.status(404).json({error:'Account not found'});
  if(!await bcrypt.compare(password,u.password)) return res.status(401).json({error:'Wrong password'});
  const token = jwt.sign({username:u.username}, JWT_SECRET, {expiresIn:'30d'});
  res.json({ token, user:safe(u), username:u.username });
});

// GET /api/me — refresh session data
app.get('/api/me', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  res.json(safe(u));
});

// PATCH /api/me — save robots/programs/field/profile
app.patch('/api/me', auth, async (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  const {robots,programs,field,teamName,avatar,color,password} = req.body;
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
  res.json({ ok:true, user:safe(u) });
});

// ─────────────────────────────────────────────────
//  RANKED  /api/match-result  /api/leaderboard
// ─────────────────────────────────────────────────

// POST /api/match-result
app.post('/api/match-result', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  const {result,homeScore=0,awayScore=0} = req.body;  // result: 'win'|'loss'|'draw'
  const rpDelta = {win:+25, draw:+5, loss:-15}[result] ?? 0;
  u.rp = Math.max(0,(u.rp||250)+rpDelta);
  if(!u.record) u.record={w:0,d:0,l:0};
  if(result==='win')  u.record.w++;
  if(result==='loss') u.record.l++;
  if(result==='draw') u.record.d++;

  // Update league table
  if(u.leagueId && DB.leagues[u.leagueId]){
    const t = DB.leagues[u.leagueId].teams.find(t=>t.player===u.username);
    if(t){
      if(result==='win'){t.w++;t.pts+=3;} else if(result==='draw'){t.d++;t.pts+=1;} else t.l++;
      t.gf=(t.gf||0)+homeScore; t.ga=(t.ga||0)+awayScore;
    }
  }
  res.json({ rp:u.rp, record:u.record, rpChange:rpDelta });
});

// GET /api/leaderboard
app.get('/api/leaderboard', (_req,res) => {
  const top50 = Object.values(DB.users)
    .map(u=>({ username:u.username, teamName:u.teamName, avatar:u.avatar, rp:u.rp||0, record:u.record||{w:0,d:0,l:0}, clan:u.clan }))
    .sort((a,b)=>b.rp-a.rp)
    .slice(0,50);
  res.json(top50);
});

// ─────────────────────────────────────────────────
//  CLANS  /api/clans
// ─────────────────────────────────────────────────

// GET /api/clans — list all
app.get('/api/clans', (_req,res) => {
  const list = Object.values(DB.clans).map(c=>({
    ...c,
    memberCount: Object.values(DB.users).filter(u=>u.clan===c.id).length
  }));
  res.json(list);
});

// POST /api/clans — create
app.post('/api/clans', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  if(u.clan) return res.status(400).json({error:'You are already in a clan'});
  const {name,tag,color,icon} = req.body;
  if(!name||!tag) return res.status(400).json({error:'Name and tag are required'});
  const TAG = tag.toUpperCase().slice(0,3);
  if(Object.values(DB.clans).find(c=>c.tag===TAG)) return res.status(409).json({error:'Tag already taken'});
  const clan = { id:uuid(), name:name.trim(), tag:TAG, color:color||'#00e57a', icon:icon||'🛡️', owner:u.username, createdAt:Date.now() };
  DB.clans[clan.id]=clan; u.clan=clan.id;
  res.json(clan);
});

// POST /api/clans/:id/join
app.post('/api/clans/:id/join', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  if(u.clan) return res.status(400).json({error:'Leave your current clan first'});
  const clan = DB.clans[req.params.id];
  if(!clan) return res.status(404).json({error:'Clan not found'});
  u.clan=clan.id;
  res.json(clan);
});

// POST /api/clans/leave
app.post('/api/clans/leave', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  u.clan=null; res.json({ok:true});
});

// GET /api/clans/:id/members
app.get('/api/clans/:id/members', (req,res) => {
  const members = Object.values(DB.users)
    .filter(u=>u.clan===req.params.id)
    .map(u=>({username:u.username,avatar:u.avatar,rp:u.rp||0,record:u.record||{w:0,d:0,l:0}}));
  res.json(members);
});

// ─────────────────────────────────────────────────
//  LEAGUES  /api/leagues
// ─────────────────────────────────────────────────

// GET /api/leagues
app.get('/api/leagues', (_req,res) => res.json(Object.values(DB.leagues)));

// POST /api/leagues/join — auto-join open league or create new
app.post('/api/leagues/join', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  if(u.leagueId) return res.status(400).json({error:'Already in a league'});

  let league = Object.values(DB.leagues).find(l=>l.teams.length<8&&!l.teams.some(t=>t.player===u.username));
  if(!league){
    league = {id:uuid(), name:`League ${Object.keys(DB.leagues).length+1}`, teams:[], createdAt:Date.now()};
    DB.leagues[league.id]=league;
  }
  league.teams.push({player:u.username, name:u.teamName||u.username, avatar:u.avatar, w:0,d:0,l:0,gf:0,ga:0,pts:0});
  u.leagueId=league.id;
  res.json(league);
});

// POST /api/leagues/leave
app.post('/api/leagues/leave', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  if(u.leagueId && DB.leagues[u.leagueId]){
    DB.leagues[u.leagueId].teams = DB.leagues[u.leagueId].teams.filter(t=>t.player!==u.username);
    if(!DB.leagues[u.leagueId].teams.length) delete DB.leagues[u.leagueId];
  }
  u.leagueId=null; res.json({ok:true});
});

// GET /api/leagues/:id
app.get('/api/leagues/:id', (req,res) => {
  const l = DB.leagues[req.params.id];
  if(!l) return res.status(404).json({error:'League not found'});
  res.json(l);
});

// ─────────────────────────────────────────────────
//  ONLINE SHARE  /api/share-team  /api/team/:code
// ─────────────────────────────────────────────────

// POST /api/share-team — generate code + save team snapshot
app.post('/api/share-team', auth, (req,res) => {
  const u = DB.users[req.user.username];
  if(!u) return res.status(404).json({error:'Not found'});
  const code = u.username.toUpperCase().slice(0,6).padEnd(4,'0');
  DB.shareTeams[code] = { name:u.teamName, robots:u.robots, programs:u.programs, field:u.field, savedAt:Date.now() };
  u.shareCode=code;
  res.json({ code });
});

// GET /api/team/:code
app.get('/api/team/:code', (req,res) => {
  const t = DB.shareTeams[req.params.code.toUpperCase()];
  if(!t) return res.status(404).json({error:'Team not found'});
  res.json(t);
});

// ─────────────────────────────────────────────────
//  SOCKET.IO — Live matchmaking + relay
// ─────────────────────────────────────────────────
const rooms = {};

io.on('connection', socket => {
  console.log(`🔌 +${socket.id.slice(0,8)}`);

  // Join matchmaking queue
  socket.on('queue:join', ({token, teamData}) => {
    try{ socket.username = jwt.verify(token, JWT_SECRET).username; }
    catch{ socket.username = 'Guest_'+socket.id.slice(0,4); }
    socket.teamData = teamData;

    const waiting = DB.matchQueue.find(s=>s.id!==socket.id&&s.connected);
    if(waiting){
      DB.matchQueue = DB.matchQueue.filter(s=>s.id!==waiting.id);
      const roomId = uuid();
      rooms[roomId] = {players:[waiting,socket], createdAt:Date.now()};
      waiting.join(roomId); socket.join(roomId);
      waiting.roomId=roomId; socket.roomId=roomId;

      io.to(roomId).emit('match:found', {
        roomId,
        home:{ username:waiting.username, teamData:waiting.teamData },
        away:{ username:socket.username,  teamData:socket.teamData  }
      });
      console.log(`⚽ Match: ${waiting.username} vs ${socket.username}`);
    } else {
      DB.matchQueue.push(socket);
      socket.emit('queue:waiting', {position:DB.matchQueue.length});
      console.log(`⏳ Queue: ${socket.username} (${DB.matchQueue.length} waiting)`);
    }
  });

  socket.on('queue:leave', () => {
    DB.matchQueue = DB.matchQueue.filter(s=>s.id!==socket.id);
    socket.emit('queue:left');
  });

  // Relay match events to opponent
  socket.on('match:goal',  d => socket.roomId && socket.to(socket.roomId).emit('match:goal',d));
  socket.on('match:state', d => socket.roomId && socket.to(socket.roomId).emit('match:state',d));
  socket.on('match:end',   d => { if(socket.roomId){ socket.to(socket.roomId).emit('match:end',d); delete rooms[socket.roomId]; }});
  socket.on('match:chat',  ({message=''}) => {
    if(socket.roomId) io.to(socket.roomId).emit('match:chat',{from:socket.username, message:message.slice(0,120)});
  });

  socket.on('disconnect', () => {
    DB.matchQueue = DB.matchQueue.filter(s=>s.id!==socket.id);
    if(socket.roomId){ socket.to(socket.roomId).emit('match:opponent_left'); delete rooms[socket.roomId]; }
    console.log(`🔌 -${socket.id.slice(0,8)}`);
  });
});

// ─────────────────────────────────────────────────
server.listen(PORT, () => console.log(`\n⚽ BALLER.EXE server running → http://localhost:${PORT}\n`));
