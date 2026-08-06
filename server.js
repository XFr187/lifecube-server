const http = require('http');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const DB_CONFIG = {
  host: 'gateway03.us-west-2.prod.aws.tidbcloud.com',
  port: 4000,
  user: '2X73k3Wke67GQP9.root',
  password: 'OYQlIPy6dXXuDdiH',
  database: 'lifecube',
  ssl: { rejectUnauthorized: true },
  connectionLimit: 10,
  waitForConnections: true,
  connectTimeout: 15000,
};

const pool = mysql.createPool(DB_CONFIG);
const PORT = process.env.PORT || 3000;

function uuid() {
  return crypto.randomBytes(16).toString('hex');
}

function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nowPlusSeconds(sec) {
  const d = new Date(Date.now() + sec * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function calcLevel(score) {
  if (score <= 50) return '青铜';
  if (score <= 150) return '白银';
  if (score <= 300) return '黄金';
  if (score <= 500) return '钻石';
  return '传奇';
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let chunks = '';
    req.on('data', function (c) { chunks += c; });
    req.on('end', function () {
      try { resolve(chunks ? JSON.parse(chunks) : {}); }
      catch (e) { resolve({}); }
    });
  });
}

async function addScore(userId, delta, reason) {
  try {
    const [rows] = await pool.query('SELECT score, details FROM user_activities WHERE userId = ?', [userId]);
    if (rows.length === 0) {
      const newScore = delta;
      const details = JSON.stringify([{ reason: reason, delta: delta, time: nowStr() }]);
      await pool.query(
        'INSERT INTO user_activities (_id, userId, score, level, details) VALUES (?,?,?,?,?)',
        [uuid(), userId, newScore, calcLevel(newScore), details]
      );
    } else {
      const oldScore = rows[0].score || 0;
      let detailsArr = [];
      try { detailsArr = JSON.parse(rows[0].details || '[]'); } catch (e) { detailsArr = []; }
      detailsArr.push({ reason: reason, delta: delta, time: nowStr() });
      const newScore = oldScore + delta;
      await pool.query(
        'UPDATE user_activities SET score = ?, level = ?, details = ? WHERE userId = ?',
        [newScore, calcLevel(newScore), JSON.stringify(detailsArr), userId]
      );
    }
  } catch (e) {
    console.error('addScore error:', e.message);
  }
}

async function handleRequest(req, res, method, path, query, body) {
  if (method === 'POST' && path === '/api/login') {
    const [rows] = await pool.query(
      'SELECT * FROM profiles WHERE username = ? AND password = ? LIMIT 1',
      [body.username, body.password]
    );
    if (rows.length === 0) {
      return sendJson(res, 200, { success: false, message: '用户名或密码错误' });
    }
    const u = rows[0];
    await addScore(u._id, 0, 'init');
    return sendJson(res, 200, { success: true, user: u });
  }

  if (method === 'POST' && path === '/api/register') {
    const [exists] = await pool.query('SELECT _id FROM profiles WHERE username = ? LIMIT 1', [body.username]);
    if (exists.length > 0) {
      return sendJson(res, 200, { success: false, message: '用户名已存在' });
    }
    const id = uuid();
    await pool.query(
      'INSERT INTO profiles (_id, username, password, nickname, classInfo) VALUES (?,?,?,?,?)',
      [id, body.username, body.password, body.nickname || '', body.classInfo || '']
    );
    await addScore(id, 0, 'init');
    const [rows] = await pool.query('SELECT * FROM profiles WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true, user: rows[0] });
  }

  if (method === 'GET' && path === '/api/notices') {
    const [rows] = await pool.query('SELECT * FROM notices ORDER BY is_pinned DESC, created_at DESC');
    return sendJson(res, 200, { success: true, data: rows });
  }
  if (method === 'POST' && path === '/api/notices') {
    const id = uuid();
    await pool.query(
      'INSERT INTO notices (_id, title, content, publisherId, is_pinned) VALUES (?,?,?,?,?)',
      [id, body.title, body.content || '', body.publisherId || '', body.isPinned ? 1 : 0]
    );
    const [rows] = await pool.query('SELECT * FROM notices WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true, data: rows[0] });
  }

  if (method === 'PUT' && path.startsWith('/api/notices/')) {
    const id = path.split('/')[3];
    const sets = [];
    const vals = [];
    if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title); }
    if (body.content !== undefined) { sets.push('content = ?'); vals.push(body.content); }
    if (body.isPinned !== undefined) { sets.push('is_pinned = ?'); vals.push(body.isPinned ? 1 : 0); }
    if (sets.length === 0) return sendJson(res, 200, { success: true });
    vals.push(id);
    await pool.query('UPDATE notices SET ' + sets.join(', ') + ' WHERE _id = ?', vals);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/notices/')) {
    const id = path.split('/')[3];
    await pool.query('DELETE FROM notices WHERE _id = ?', [id]);
    await pool.query('DELETE FROM notice_reads WHERE noticeId = ?', [id]);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'POST' && path.match(/^\/api\/notices\/[^/]+\/read$/)) {
    const id = path.split('/')[3];
    const [exists] = await pool.query('SELECT _id FROM notice_reads WHERE noticeId = ? AND userId = ? LIMIT 1', [id, body.userId]);
    if (exists.length === 0) {
      await pool.query('INSERT INTO notice_reads (_id, noticeId, userId) VALUES (?,?,?)', [uuid(), id, body.userId]);
    }
    return sendJson(res, 200, { success: true });
  }

  if (method === 'GET' && path.match(/^\/api\/notices\/[^/]+\/read$/)) {
    const id = path.split('/')[3];
    const [rows] = await pool.query('SELECT _id FROM notice_reads WHERE noticeId = ? AND userId = ? LIMIT 1', [id, query.userId]);
    return sendJson(res, 200, { success: true, read: rows.length > 0 });
  }

  if (method === 'GET' && path === '/api/polls') {
    const [rows] = await pool.query('SELECT * FROM polls ORDER BY created_at DESC');
    return sendJson(res, 200, { success: true, data: rows });
  }
  if (method === 'POST' && path === '/api/polls') {
    const id = uuid();
    await pool.query(
      'INSERT INTO polls (_id, question, options, createdBy, ends_at, is_active) VALUES (?,?,?,?,?,1)',
      [id, body.question, JSON.stringify(body.options || []), body.createdBy || '', body.endsAt || null]
    );
    if (body.createdBy) await addScore(body.createdBy, 2, '发起投票');
    const [rows] = await pool.query('SELECT * FROM polls WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true, data: rows[0] });
  }

  if (method === 'PUT' && path.match(/^\/api\/polls\/[^/]+\/end$/)) {
    const id = path.split('/')[3];
    await pool.query('UPDATE polls SET is_active = 0 WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/polls/') && !path.includes('/', 11)) {
    const id = path.split('/')[3];
    await pool.query('DELETE FROM polls WHERE _id = ?', [id]);
    await pool.query('DELETE FROM vote_records WHERE pollId = ?', [id]);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'POST' && path.match(/^\/api\/polls\/[^/]+\/vote$/)) {
    const id = path.split('/')[3];
    const [exists] = await pool.query('SELECT _id FROM vote_records WHERE pollId = ? AND userId = ? LIMIT 1', [id, body.userId]);
    if (exists.length > 0) {
      return sendJson(res, 200, { success: false, message: '您已投过票' });
    }
    await pool.query('INSERT INTO vote_records (_id, pollId, userId, option_index) VALUES (?,?,?,?)', [uuid(), id, body.userId, body.optionIndex]);
    await addScore(body.userId, 2, '参与投票');
    return sendJson(res, 200, { success: true });
  }

  if (method === 'GET' && path.match(/^\/api\/polls\/[^/]+\/voted$/)) {
    const id = path.split('/')[3];
    const [rows] = await pool.query('SELECT option_index FROM vote_records WHERE pollId = ? AND userId = ? LIMIT 1', [id, query.userId]);
    return sendJson(res, 200, { success: true, voted: rows.length > 0, optionIndex: rows.length > 0 ? rows[0].option_index : -1 });
  }

  if (method === 'GET' && path.match(/^\/api\/polls\/[^/]+\/records$/)) {
    const id = path.split('/')[3];
    const [rows] = await pool.query('SELECT option_index FROM vote_records WHERE pollId = ?', [id]);
    return sendJson(res, 200, { success: true, data: rows });
  }

  if (method === 'GET' && path === '/api/tasks') {
    const [rows] = await pool.query('SELECT * FROM tasks ORDER BY deadline ASC');
    return sendJson(res, 200, { success: true, data: rows });
  }
  if (method === 'POST' && path === '/api/tasks') {
    const id = uuid();
    await pool.query(
      'INSERT INTO tasks (_id, title, description, deadline, publisherId, status) VALUES (?,?,?,?,?,?)',
      [id, body.title, body.description || '', body.deadline || null, body.publisherId || '', '待完成']
    );
    const [rows] = await pool.query('SELECT * FROM tasks WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true, data: rows[0] });
  }

  if (method === 'PUT' && path.startsWith('/api/tasks/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    const sets = [];
    const vals = [];
    if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title); }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description); }
    if (body.deadline !== undefined) { sets.push('deadline = ?'); vals.push(body.deadline); }
    if (body.status !== undefined) { sets.push('status = ?'); vals.push(body.status); }
    if (sets.length === 0) return sendJson(res, 200, { success: true });
    vals.push(id);
    await pool.query('UPDATE tasks SET ' + sets.join(', ') + ' WHERE _id = ?', vals);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'DELETE' && path.startsWith('/api/tasks/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    await pool.query('DELETE FROM tasks WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'GET' && path === '/api/moments') {
    const [rows] = await pool.query(
      'SELECT m.*, p.nickname, p.avatar_url AS author_avatar ' +
      'FROM moments m LEFT JOIN profiles p ON m.authorId = p._id ' +
      'ORDER BY m.created_at DESC'
    );
    return sendJson(res, 200, { success: true, data: rows });
  }
  if (method === 'POST' && path === '/api/moments') {
    const id = uuid();
    await pool.query(
      'INSERT INTO moments (_id, content, image_url, authorId, likes) VALUES (?,?,?,?,0)',
      [id, body.content || '', body.imageUrl || '', body.authorId]
    );
    await addScore(body.authorId, 3, '发布动态');
    const [rows] = await pool.query('SELECT * FROM moments WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true, data: rows[0] });
  }

  if (method === 'DELETE' && path.startsWith('/api/moments/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    await pool.query('DELETE FROM moments WHERE _id = ?', [id]);
    await pool.query('DELETE FROM moment_likes WHERE momentId = ?', [id]);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'POST' && path.match(/^\/api\/moments\/[^/]+\/like$/)) {
    const id = path.split('/')[3];
    const [exists] = await pool.query('SELECT _id FROM moment_likes WHERE momentId = ? AND userId = ? LIMIT 1', [id, body.userId]);
    if (exists.length > 0) {
      await pool.query('DELETE FROM moment_likes WHERE momentId = ? AND userId = ?', [id, body.userId]);
      await pool.query('UPDATE moments SET likes = likes - 1 WHERE _id = ? AND likes > 0', [id]);
      return sendJson(res, 200, { success: true, liked: false });
    } else {
      await pool.query('INSERT INTO moment_likes (_id, momentId, userId) VALUES (?,?,?)', [uuid(), id, body.userId]);
      await pool.query('UPDATE moments SET likes = likes + 1 WHERE _id = ?', [id]);
      await addScore(body.userId, 1, '点赞');
      return sendJson(res, 200, { success: true, liked: true });
    }
  }

  if (method === 'GET' && path.match(/^\/api\/moments\/[^/]+\/liked$/)) {
    const id = path.split('/')[3];
    const [rows] = await pool.query('SELECT _id FROM moment_likes WHERE momentId = ? AND userId = ? LIMIT 1', [id, query.userId]);
    return sendJson(res, 200, { success: true, liked: rows.length > 0 });
  }

  if (method === 'GET' && path === '/api/checkins') {
    const userId = query.userId;
    const year = query.year || new Date().getFullYear();
    const month = query.month || (new Date().getMonth() + 1);
    const start = year + '-' + String(month).padStart(2, '0') + '-01';
    const nextMonth = month == 12 ? 1 : (parseInt(month) + 1);
    const nextYear = month == 12 ? (parseInt(year) + 1) : year;
    const end = nextYear + '-' + String(nextMonth).padStart(2, '0') + '-01';
    const [rows] = await pool.query('SELECT * FROM check_ins WHERE userId = ? AND date >= ? AND date < ? ORDER BY date ASC', [userId, start, end]);
    return sendJson(res, 200, { success: true, data: rows });
  }
  if (method === 'POST' && path === '/api/checkins') {
    const userId = body.userId;
    const today = todayStr();
    const [todayRows] = await pool.query('SELECT _id FROM check_ins WHERE userId = ? AND date = ? LIMIT 1', [userId, today]);
    if (todayRows.length > 0) {
      return sendJson(res, 200, { success: false, message: '今日已签到' });
    }
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const [yRows] = await pool.query('SELECT streak FROM check_ins WHERE userId = ? AND date = ? LIMIT 1', [userId, yesterday]);
    const streak = yRows.length > 0 ? (yRows[0].streak + 1) : 1;
    await pool.query('INSERT INTO check_ins (_id, userId, date, streak) VALUES (?,?,?,?)', [uuid(), userId, today, streak]);
    await addScore(userId, 5, '每日签到');
    return sendJson(res, 200, { success: true, streak: streak });
  }

  if (method === 'GET' && path.startsWith('/api/profiles/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    const [rows] = await pool.query('SELECT * FROM profiles WHERE _id = ?', [id]);
    if (rows.length === 0) return sendJson(res, 200, { success: false, message: '用户不存在' });
    return sendJson(res, 200, { success: true, data: rows[0] });
  }
  if (method === 'PUT' && path.startsWith('/api/profiles/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    const sets = [];
    const vals = [];
    if (body.nickname !== undefined) { sets.push('nickname = ?'); vals.push(body.nickname); }
    if (body.classInfo !== undefined) { sets.push('classInfo = ?'); vals.push(body.classInfo); }
    if (body.avatarUrl !== undefined) { sets.push('avatar_url = ?'); vals.push(body.avatarUrl); }
    if (sets.length === 0) return sendJson(res, 200, { success: true });
    vals.push(id);
    await pool.query('UPDATE profiles SET ' + sets.join(', ') + ' WHERE _id = ?', vals);
    const [rows] = await pool.query('SELECT * FROM profiles WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true, data: rows[0] });
  }

  if (method === 'GET' && path === '/api/profiles') {
    const [rows] = await pool.query('SELECT * FROM profiles ORDER BY created_at DESC');
    return sendJson(res, 200, { success: true, data: rows });
  }

  if (method === 'GET' && path === '/api/user-activities') {
    const [rows] = await pool.query('SELECT * FROM user_activities WHERE userId = ? LIMIT 1', [query.userId]);
    return sendJson(res, 200, { success: true, data: rows.length > 0 ? rows[0] : null });
  }

  if (method === 'GET' && path.startsWith('/api/users/') && path.split('/').length === 4) {
    const id = path.split('/')[3];
    const [uRows] = await pool.query('SELECT * FROM profiles WHERE _id = ?', [id]);
    if (uRows.length === 0) return sendJson(res, 200, { success: false, message: '用户不存在' });
    const [aRows] = await pool.query('SELECT * FROM user_activities WHERE userId = ? LIMIT 1', [id]);
    const [cRows] = await pool.query('SELECT * FROM check_ins WHERE userId = ? ORDER BY date DESC', [id]);
    const [mRows] = await pool.query('SELECT * FROM moments WHERE authorId = ? ORDER BY created_at DESC', [id]);
    return sendJson(res, 200, {
      success: true,
      data: { user: uRows[0], activity: aRows.length > 0 ? aRows[0] : null, checkins: cRows, moments: mRows }
    });
  }

  if (method === 'PUT' && path.match(/^\/api\/users\/[^/]+\/ban$/)) {
    const id = path.split('/')[3];
    const expire = nowPlusSeconds(parseInt(body.seconds) || 0);
    await pool.query('UPDATE profiles SET is_banned = 1, ban_expire_at = ? WHERE _id = ?', [expire, id]);
    return sendJson(res, 200, { success: true, ban_expire_at: expire });
  }
  if (method === 'PUT' && path.match(/^\/api\/users\/[^/]+\/unban$/)) {
    const id = path.split('/')[3];
    await pool.query('UPDATE profiles SET is_banned = 0, ban_expire_at = NULL WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true });
  }
  if (method === 'PUT' && path.match(/^\/api\/users\/[^/]+\/mute$/)) {
    const id = path.split('/')[3];
    const expire = nowPlusSeconds(parseInt(body.seconds) || 0);
    await pool.query('UPDATE profiles SET is_muted = 1, mute_expire_at = ? WHERE _id = ?', [expire, id]);
    return sendJson(res, 200, { success: true, mute_expire_at: expire });
  }
  if (method === 'PUT' && path.match(/^\/api\/users\/[^/]+\/unmute$/)) {
    const id = path.split('/')[3];
    await pool.query('UPDATE profiles SET is_muted = 0, mute_expire_at = NULL WHERE _id = ?', [id]);
    return sendJson(res, 200, { success: true });
  }

  if (method === 'GET' && path === '/api/ban-status') {
    const [rows] = await pool.query('SELECT is_banned, ban_expire_at, is_muted, mute_expire_at FROM profiles WHERE _id = ? LIMIT 1', [query.userId]);
    if (rows.length === 0) return sendJson(res, 200, { success: false });
    const u = rows[0];
    const now = Date.now();
    let banned = u.is_banned == 1;
    let muted = u.is_muted == 1;
    if (banned && u.ban_expire_at) {
      if (new Date(u.ban_expire_at).getTime() <= now) {
        await pool.query('UPDATE profiles SET is_banned = 0, ban_expire_at = NULL WHERE _id = ?', [query.userId]);
        banned = false;
      }
    }
    if (muted && u.mute_expire_at) {
      if (new Date(u.mute_expire_at).getTime() <= now) {
        await pool.query('UPDATE profiles SET is_muted = 0, mute_expire_at = NULL WHERE _id = ?', [query.userId]);
        muted = false;
      }
    }
    return sendJson(res, 200, {
      success: true,
      is_banned: banned,
      ban_expire_at: u.ban_expire_at,
      is_muted: muted,
      mute_expire_at: u.mute_expire_at
    });
  }

  if (method === 'GET' && path === '/api/dashboard') {
    const [uRows] = await pool.query('SELECT COUNT(*) AS c FROM profiles');
    const today = todayStr();
    const [cRows] = await pool.query('SELECT COUNT(*) AS c FROM check_ins WHERE date = ?', [today]);
    const totalUsers = uRows[0].c;
    const todayCheckin = cRows[0].c;
    const checkinRate = totalUsers > 0 ? Math.round(todayCheckin / totalUsers * 100) : 0;

    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const [r] = await pool.query('SELECT COUNT(*) AS c FROM check_ins WHERE date = ?', [d]);
      trend.push({ date: d, count: r[0].c });
    }

    const [pollRows] = await pool.query('SELECT p._id, p.question, COUNT(v._id) AS cnt FROM polls p LEFT JOIN vote_records v ON p._id = v.pollId GROUP BY p._id ORDER BY cnt DESC LIMIT 3');

    const [rankRows] = await pool.query('SELECT a.userId, a.score, a.level, p.nickname FROM user_activities a LEFT JOIN profiles p ON a.userId = p._id ORDER BY a.score DESC LIMIT 10');

    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const [wRows] = await pool.query('SELECT COUNT(*) AS c FROM moments WHERE created_at >= ?', [weekAgo]);
    const [mRows] = await pool.query('SELECT COUNT(*) AS c FROM moments WHERE created_at >= ?', [monthAgo]);

    return sendJson(res, 200, {
      success: true,
      data: {
        totalUsers: totalUsers,
        todayCheckin: todayCheckin,
        checkinRate: checkinRate,
        trend: trend,
        topPolls: pollRows,
        ranking: rankRows,
        weekMoments: wRows[0].c,
        monthMoments: mRows[0].c
      }
    });
  }

  sendJson(res, 404, { success: false, message: 'Not found: ' + method + ' ' + path });
}

const server = http.createServer(async function (req, res) {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, {});
  }
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const query = {};
  for (const [k, v] of url.searchParams.entries()) { query[k] = v; }
  try {
    const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
    await handleRequest(req, res, req.method, path, query, body);
  } catch (e) {
    console.error('Server error:', e);
    sendJson(res, 500, { success: false, message: '服务器错误: ' + e.message });
  }
});

server.listen(PORT, function () {
  console.log('生活立方后端API运行在 http://0.0.0.0:' + PORT + '/api');
});
