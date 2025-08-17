require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const PORT = process.env.CHAT_PORT || 6060;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || 'cryptoloop';
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// --- DB ---
mongoose.connect(MONGO_URI, { dbName: DB_NAME })
  .then(() => console.log('Chat DB connected'))
  .catch(err => { console.error('Chat DB error', err); process.exit(1); });

// --- Schemas ---
const ConversationSchema = new mongoose.Schema({
  userEmail: { type: String, index: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  assignedTo: { type: String, default: '' }
}, { timestamps: true });

const MessageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
  senderType: { type: String, enum: ['user', 'agent', 'bot'], required: true },
  senderId: { type: String, default: '' },
  text: { type: String, default: '' }
}, { timestamps: true });

const Conversation = mongoose.model('Conversation', ConversationSchema);
const Message = mongoose.model('Message', MessageSchema);

// --- App + IO ---
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '100kb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

// --- Auth (REST) ---
function auth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // should include email (and role for admin)
    next();
  } catch {
    res.status(401).json({ msg: 'Unauthorized' });
  }
}

// --- Healthcheck ---
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- REST: Start / History ---
app.post('/api/chat/start', auth, async (req, res) => {
  const userEmail = req.user.email;
  let convo = await Conversation.findOne({ userEmail, status: 'open' });
  if (!convo) convo = await Conversation.create({ userEmail });
  res.json({ conversationId: convo._id.toString() });
});

app.get('/api/chat/:id/messages', auth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const before = req.query.before ? new Date(req.query.before) : null;
  const q = { conversationId: req.params.id };
  if (before) q.createdAt = { $lt: before };
  const msgs = await Message.find(q).sort({ createdAt: -1 }).limit(limit);
  res.json(msgs.reverse());
});

// --- Socket auth ---
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) throw new Error('missing token');
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = { email: payload.email, role: payload.role || 'user' };
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

// --- Socket events ---
io.on('connection', (socket) => {
  socket.on('join_conversation', async ({ conversationId }) => {
    const convo = await Conversation.findById(conversationId);
    if (!convo) return;
    const isOwner = convo.userEmail === socket.user.email;
    const isAgent = socket.user.role === 'admin' || socket.user.role === 'agent';
    if (!isOwner && !isAgent) return;
    socket.join(conversationId.toString());
  });

  socket.on('user_message', async ({ conversationId, text }) => {
    const convo = await Conversation.findById(conversationId);
    if (!convo || convo.userEmail !== socket.user.email) return;
    if (!text || typeof text !== 'string' || text.length > 2000) return;
    const msg = await Message.create({ conversationId, senderType: 'user', senderId: socket.user.email, text });
    io.to(conversationId.toString()).emit('message_new', { ...msg.toObject() });
  });

  socket.on('agent_message', async ({ conversationId, text }) => {
    const isAgent = socket.user.role === 'admin' || socket.user.role === 'agent';
    if (!isAgent) return;
    if (!text || typeof text !== 'string' || text.length > 2000) return;
    const msg = await Message.create({ conversationId, senderType: 'agent', senderId: socket.user.email, text });
    io.to(conversationId.toString()).emit('message_new', { ...msg.toObject() });
  });
});

server.listen(PORT, () => console.log(`Chat service on :${PORT}`));
