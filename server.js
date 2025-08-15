// server.js
const express = require('express');
const session = require('express-session');
const ecpay_payment = require('ecpay_aio_nodejs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin';

// ---- ECPay 測試設定（上線改 Production & 正式商店參數）----
const ECPAY_OPTIONS = {
  OperationMode: 'Test',
  MercProfile: {
    MerchantID: '2000132',
    HashKey: '5294y06JbISpM5x9',
    HashIV:  'v77hoKGq4kWxNNIS',
  },
  IgnorePayment: [],
  IsProjectContractor: false,
};

// ---- 簡易 CORS（允許自訂標頭與憑證）----
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin'); // 讓代理根據來源分開快取
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, Authorization');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- DB 初始化 ----
const DB_PATH = path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  img    TEXT,
  price  INTEGER NOT NULL,
  stock  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,          -- 我們的 orderId（8碼）
  trade_no   TEXT,                      -- 送綠界的 MerchantTradeNo
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  address    TEXT NOT NULL,
  notes      TEXT,
  subtotal   INTEGER NOT NULL,
  shipping   INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'created', -- created/pending/paid/failed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id   TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  price      INTEGER NOT NULL,          -- 下單當下的單價
  line_total INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id),
  FOREIGN KEY (order_id)  REFERENCES orders(id)    ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);
`);

// 若 products 表缺 stock 欄位就補上（舊資料庫升級）
const cols = db.prepare(`PRAGMA table_info(products)`).all();
if (!cols.some(c => c.name === 'stock')) {
  db.exec(`ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0;`);
  console.log('[DB] Added stock column to products.');
}

// ---- 初始商品（只在空表時匯入一次）----
const SEED_PRODUCTS = [
  // 禮盒
  { id: 'gift_lux_12',  name: '精裝咖啡禮盒（12入）', img: '/img/精裝禮盒.jpg',   price: 800,  stock: 20 },
  { id: 'gift_lux_20',  name: '精裝咖啡禮盒（20入）', img: '/img/精裝禮盒.jpg',   price: 1200, stock: 15 },
  { id: 'gift_std_12',  name: '平裝咖啡禮盒（12入）', img: '/img/平裝禮盒.jpg',   price: 680,  stock: 30 },
  { id: 'gift_std_20',  name: '平裝咖啡禮盒（20入）', img: '/img/平裝禮盒.jpg',   price: 1080, stock: 20 },

  // 掛耳
  { id: 'drip_special', name: '達味特調 Dawit Special',              img: '/img/達味特調.png',       price: 50, stock: 200 },
  { id: 'drip_djimmah', name: '日曬吉瑪 Djimmah',                     img: '/img/日曬吉瑪.png',       price: 50, stock: 200 },
  { id: 'drip_yirg',    name: '水洗耶加雪菲 Yirgacheffe',             img: '/img/水洗耶加雪菲.png',   price: 50, stock: 200 },
  { id: 'drip_yirg_cl', name: '經典耶加雪菲 Classic Yirgacheffe',    img: '/img/經典耶加雪菲.png',   price: 50, stock: 200 },

  // 烘豆
  { id: 'beans_gesha_100', name: '衣索匹亞藝伎 Gesha 100g', img: '/img/日曬吉瑪咖啡豆.png', price: 700, stock: 10 },
  { id: 'beans_yirg_200',  name: '水洗耶加雪菲 200g',       img: '/img/日曬吉瑪咖啡豆.png', price: 500, stock: 25 },
  { id: 'beans_djim_200',  name: '日曬吉瑪 200g',           img: '/img/日曬吉瑪咖啡豆.png', price: 400, stock: 25 },
];

const prodCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (prodCount === 0) {
  const seedStmt = db.prepare('INSERT INTO products (id, name, img, price, stock) VALUES (@id, @name, @img, @price, @stock)');
  const seedTx = db.transaction(rows => rows.forEach(r => seedStmt.run(r)));
  seedTx(SEED_PRODUCTS);
  console.log(`[DB] Seeded ${SEED_PRODUCTS.length} products.`);
}

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 } // 1 hr
}));

// 靜態檔案（public 內含 order.html 與 img）
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function getCart(req) {
  if (!req.session.cart) req.session.cart = {}; // { productId: quantity }
  return req.session.cart;
}

function cartToArray(cart) {
  const items = [];
  for (const [pid, qty] of Object.entries(cart)) {
    const p = db.prepare('SELECT id, name, img, price, stock FROM products WHERE id = ?').get(pid);
    if (!p) continue;
    items.push({ ...p, quantity: qty, lineTotal: p.price * qty });
  }
  return items;
}

function cartSummary(cart) {
  const items = cartToArray(cart);
  const subtotal = items.reduce((sum, it) => sum + it.lineTotal, 0);
  const shipping = subtotal >= 500 || subtotal === 0 ? 0 : 60; // free over NT$500
  const total = subtotal + shipping;
  return { items, subtotal, shipping, total };
}

// ---- Admin 驗證：支援 header / query / Bearer ----
function readAdminToken(req) {
  const h = req.headers;
  const fromHeader = h['x-admin-token'] || req.get && req.get('x-admin-token');
  const fromBearer = (h.authorization || '').startsWith('Bearer ')
    ? h.authorization.slice('Bearer '.length).trim()
    : '';
  const fromQuery = req.query && req.query.token ? String(req.query.token) : '';
  return fromHeader || fromBearer || fromQuery || '';
}
function adminAuth(req, res, next) {
  const token = readAdminToken(req);
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({
    error: 'Unauthorized',
    hint: '請以 x-admin-token header 或 Authorization: Bearer <token>，或 ?token= 傳遞',
    expected_default: ADMIN_TOKEN === 'dev-admin' // 僅供本機快速判斷
  });
}

// ====== Public APIs ======
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT id, name, img, price, stock FROM products ORDER BY id').all();
  res.json({ products });
});

app.get('/api/cart', (req, res) => {
  const summary = cartSummary(getCart(req));
  res.json(summary);
});

app.post('/api/cart/add', (req, res) => {
  const { productId, quantity } = req.body || {};
  const qty = Math.max(1, Number(quantity) || 1);
  const prod = db.prepare('SELECT id, stock FROM products WHERE id = ?').get(productId);
  if (!prod) return res.status(400).json({ error: 'Invalid productId' });

  if (qty > prod.stock) {
    return res.status(400).json({ error: `庫存不足（可購買上限：${prod.stock}）` });
  }

  const cart = getCart(req);
  cart[productId] = (cart[productId] || 0) + qty;
  res.json(cartSummary(cart));
});

app.post('/api/cart/update', (req, res) => {
  const { productId, quantity } = req.body || {};
  const qty = Math.max(0, Number(quantity) || 0);
  const cart = getCart(req);
  if (!(productId in cart)) return res.status(400).json({ error: 'Item not in cart' });

  if (qty > 0) {
    const prod = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
    if (!prod) return res.status(400).json({ error: 'Invalid productId' });
    if (qty > prod.stock) return res.status(400).json({ error: `庫存不足（可購買上限：${prod.stock}）` });
  }

  if (qty === 0) delete cart[productId]; else cart[productId] = qty;
  res.json(cartSummary(cart));
});

app.post('/api/cart/clear', (req, res) => {
  req.session.cart = {};
  res.json(cartSummary(getCart(req)));
});

// 建立訂單：檢查庫存、寫入訂單與明細、並「預扣庫存」
app.post('/api/checkout', (req, res) => {
  const { name, phone, address, notes } = req.body || {};
  const cart = getCart(req);
  const summary = cartSummary(cart);
  if (summary.items.length === 0) return res.status(400).json({ error: '購物車是空的' });
  if (!name || !phone || !address) return res.status(400).json({ error: '請填寫收件人、電話與地址' });

  // 檢查庫存是否足夠
  for (const it of summary.items) {
    const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(it.id);
    if (!p || p.stock < it.quantity) {
      return res.status(400).json({ error: `${it.name} 庫存不足（剩餘 ${p ? p.stock : 0}）` });
    }
  }

  const orderId = uuidv4().slice(0, 8);

  const insertOrder = db.prepare(`
    INSERT INTO orders (id, name, phone, address, notes, subtotal, shipping, total, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created')
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, quantity, price, line_total)
    VALUES (?, ?, ?, ?, ?)
  `);
  const decStock = db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`);

  const tx = db.transaction(() => {
    insertOrder.run(orderId, name, phone, address, notes || '', summary.subtotal, summary.shipping, summary.total);
    summary.items.forEach(it => {
      insertItem.run(orderId, it.id, it.quantity, it.price, it.lineTotal);
      decStock.run(it.quantity, it.id);
    });
  });
  tx();

  // session 暫存（/pay/:orderId 用）
  req.session.pendingOrder = {
    orderId,
    customer: { name, phone, address, notes: notes || '' },
    ...summary,
  };

  res.json({ message: '訂單已建立，準備導向綠界', orderId, redirect: `/pay/${orderId}` });
});

app.get('/pay/:orderId', (req, res) => {
  const pending = req.session.pendingOrder;
  if (!pending || pending.orderId !== req.params.orderId) {
    return res.status(400).send('找不到待付款訂單，請重新結帳');
  }

  const tradeNo = `TEST${pending.orderId}${Date.now()}`.slice(0, 20); // 20碼內
  const tradeDate = new Date();
  const pad2 = n => (n < 10 ? '0' + n : '' + n);
  const dateStr = `${tradeDate.getFullYear()}/${pad2(tradeDate.getMonth()+1)}/${pad2(tradeDate.getDate())} ${pad2(tradeDate.getHours())}:${pad2(tradeDate.getMinutes())}:${pad2(tradeDate.getSeconds())}`;

  // 更新 DB：寫入 trade_no 與狀態 pending
  db.prepare('UPDATE orders SET trade_no = ?, status = ? WHERE id = ?')
    .run(tradeNo, 'pending', pending.orderId);

  const itemName = pending.items.map(it => `${it.name}x${it.quantity}`).join('#');

  const base_param = {
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: dateStr,
    TotalAmount: String(pending.total),
    TradeDesc: 'CoffeeOrder',
    ItemName: itemName,
    ReturnURL: 'https://example.com/ecpay/return',    // TODO: 上線改為正式可達的 HTTPS 並驗證 CheckMacValue
    OrderResultURL: `http://localhost:${PORT}/result`,
    ClientBackURL: `http://localhost:${PORT}/`,
    ChoosePayment: 'ALL',
    EncryptType: 1,
  };

  const create = new ecpay_payment(ECPAY_OPTIONS);
  const html = create.payment_client.aio_check_out_all(base_param);
  res.send(html);
});

// 顧客可見（前景）—示範用（正式上線應以 ReturnURL 檢核為準）
app.post('/result', express.urlencoded({ extended: false }), (req, res) => {
  const tradeNo = req.body.MerchantTradeNo;
  const rtnCode = String(req.body.RtnCode || '');
  if (tradeNo && rtnCode === '1') {
    db.prepare('UPDATE orders SET status = ? WHERE trade_no = ?').run('paid', tradeNo);
  }

  req.session.cart = {};
  req.session.pendingOrder = null;

  res.send(`<html><body style="font-family:sans-serif">
    <h2>付款結果</h2>
    <pre>${JSON.stringify(req.body, null, 2)}</pre>
    <a href="/">回首頁</a>
  </body></html>`);
});

// 背景回傳（server-to-server）—正式上線請以這個為準，並驗證 CheckMacValue
app.post('/ecpay/return', express.urlencoded({ extended: false }), (req, res) => {
  console.log('[ECPay ReturnURL] body:', req.body);
  const tradeNo = req.body.MerchantTradeNo;
  const rtnCode = String(req.body.RtnCode || '');
  if (tradeNo && rtnCode === '1') {
    db.prepare('UPDATE orders SET status = ? WHERE trade_no = ?').run('paid', tradeNo);
  }
  res.send('1|OK');
});

// 方便的 /order 路由（避免路徑搞混）
app.get('/order', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// ====== Admin APIs（簡易 Token 驗證）======
// 上架新商品
app.post('/api/admin/products', adminAuth, (req, res) => {
  const { id, name, img, price, stock } = req.body || {};
  if (!id || !name || !Number.isFinite(Number(price)) || !Number.isFinite(Number(stock))) {
    return res.status(400).json({ error: 'id/name/price/stock 必填，且 price/stock 需為數字' });
  }
  try {
    db.prepare('INSERT INTO products (id, name, img, price, stock) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, img || '', Number(price), Math.max(0, Number(stock)));
    const p = db.prepare('SELECT id, name, img, price, stock FROM products WHERE id = ?').get(id);
    res.json({ ok: true, product: p });
  } catch (e) {
    res.status(400).json({ error: '新增失敗，可能是 id 重複' });
  }
});

// 改價／改名／改圖／改庫存（擇一或多個欄位）
app.patch('/api/admin/products/:id', adminAuth, (req, res) => {
  const { id } = req.params;
  const { name, img, price, stock } = req.body || {};
  const fields = [];
  const vals = [];
  if (typeof name === 'string') { fields.push('name = ?'); vals.push(name); }
  if (typeof img === 'string')  { fields.push('img = ?');  vals.push(img); }
  if (price !== undefined)      { fields.push('price = ?'); vals.push(Number(price)); }
  if (stock !== undefined)      { fields.push('stock = ?'); vals.push(Math.max(0, Number(stock))); }
  if (fields.length === 0) return res.status(400).json({ error: '無任何可更新欄位' });

  vals.push(id);
  const sql = `UPDATE products SET ${fields.join(', ')} WHERE id = ?`;
  const info = db.prepare(sql).run(...vals);
  if (info.changes === 0) return res.status(404).json({ error: '找不到該商品' });
  const p = db.prepare('SELECT id, name, img, price, stock FROM products WHERE id = ?').get(id);
  res.json({ ok: true, product: p });
});

// 查單
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, trade_no, name, phone, address, subtotal, shipping, total, status, created_at FROM orders ORDER BY created_at DESC`).all();
  res.json({ orders: rows });
});

// 查某單的明細
app.get('/api/admin/orders/:id/items', adminAuth, (req, res) => {
  const { id } = req.params;
  const rows = db.prepare(`
    SELECT oi.product_id, p.name, oi.quantity, oi.price, oi.line_total
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(id);
  res.json({ items: rows });
});

app.listen(PORT, () => {
  console.log(`Coffee order app running at http://localhost:${PORT}`);
  console.log(`[Admin] 使用的管理 Token：${ADMIN_TOKEN}`);
});
