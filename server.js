const express = require('express');
const session = require('express-session');
const ecpay_payment = require('ecpay_aio_nodejs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const ECPAY_OPTIONS = {
  OperationMode: 'Test', // 正式上線改 'Production'
  MercProfile: {
    MerchantID: '2000132',
    HashKey: '5294y06JbISpM5x9',
    HashIV:  'v77hoKGq4kWxNNIS',
  },
  IgnorePayment: [],
  IsProjectContractor: false,
};

// Simple in-memory catalog (could be swapped out for a DB)
const PRODUCTS = [
  // 禮盒
  { id: 'gift_lux_12',  name: '精裝咖啡禮盒（12入）', img:"./img/精裝禮盒.jpg", price: 800 },
  { id: 'gift_lux_20',  name: '精裝咖啡禮盒（20入）', img:"./img/精裝禮盒.jpg", price: 1200 },
  { id: 'gift_std_12',  name: '平裝咖啡禮盒（12入）', img:"./img/平裝禮盒.jpg", price: 680 },
  { id: 'gift_std_20',  name: '平裝咖啡禮盒（20入）',img:"./img/平裝禮盒.jpg",  price: 1080 },

  // 掛耳
  { id: 'drip_special', name: '', img:"./img/達味特調.png", price: 50 },
  { id: 'drip_djimmah', name: '', img:"./img/日曬吉瑪.png",              price: 50 },
  { id: 'drip_yirg',    name: '',  img:"./img/水洗耶加雪菲.png",     price: 50 },
  { id: 'drip_yirg_cl', name: '',img:"./img/經典耶加雪菲.png", price: 50 },

  // 烘豆
  { id: 'beans_gesha_100', name: '衣索匹亞藝伎 Gesha 100g', img:"./img/日曬吉瑪咖啡豆.png", price: 700 },
  { id: 'beans_yirg_200',  name: '水洗耶加雪菲 200g',    img:"./img/日曬吉瑪咖啡豆.png",    price: 500 },
  { id: 'beans_djim_200',  name: '日曬吉瑪 200g',   img:"./img/日曬吉瑪咖啡豆.png",          price: 400 },
];

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 } // 1 hour
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Helpers
function getCart(req) {
  if (!req.session.cart) req.session.cart = {}; // { productId: quantity }
  return req.session.cart;
}

function cartToArray(cart) {
  return Object.entries(cart).map(([pid, qty]) => {
    const p = PRODUCTS.find(x => x.id === pid);
    if (!p) return null;
    return { ...p, quantity: qty, lineTotal: p.price * qty };
  }).filter(Boolean);
}

function cartSummary(cart) {
  const items = cartToArray(cart);
  const subtotal = items.reduce((sum, it) => sum + it.lineTotal, 0);
  const shipping = subtotal >= 500 || subtotal === 0 ? 0 : 60; // free over NT$500
  const total = subtotal + shipping;
  return { items, subtotal, shipping, total };
}

// API routes
app.get('/api/products', (req, res) => {
  res.json({ products: PRODUCTS });
});

app.get('/api/cart', (req, res) => {
  const summary = cartSummary(getCart(req));
  res.json(summary);
});

app.post('/api/cart/add', (req, res) => {
  const { productId, quantity } = req.body || {};
  const qty = Number(quantity) || 1;
  const exists = PRODUCTS.some(p => p.id === productId);
  if (!exists) return res.status(400).json({ error: 'Invalid productId' });
  const cart = getCart(req);
  cart[productId] = (cart[productId] || 0) + qty;
  res.json(cartSummary(cart));
});

app.post('/api/cart/update', (req, res) => {
  const { productId, quantity } = req.body || {};
  const qty = Math.max(0, Number(quantity) || 0);
  const cart = getCart(req);
  if (!(productId in cart)) return res.status(400).json({ error: 'Item not in cart' });
  if (qty === 0) delete cart[productId]; else cart[productId] = qty;
  res.json(cartSummary(cart));
});

app.post('/api/cart/clear', (req, res) => {
  req.session.cart = {};
  res.json(cartSummary(getCart(req)));
});

app.post('/api/checkout', (req, res) => {
  const { name, phone, address, notes } = req.body || {};
  const summary = cartSummary(getCart(req));
  if (summary.items.length === 0) return res.status(400).json({ error: '購物車是空的' });
  if (!name || !phone || !address) return res.status(400).json({ error: '請填寫收件人、電話與地址' });

  const orderId = uuidv4().slice(0, 8);
  // 暫存到 session，等等 /pay/:orderId 要用
  req.session.pendingOrder = {
    orderId,
    customer: { name, phone, address, notes: notes || '' },
    ...summary,
  };

  // 這裡先不要清空購物車；待綠界回傳成功再清。
  res.json({
    message: '訂單已建立，準備導向綠界',
    orderId,
    redirect: `/pay/${orderId}`
  });
});

app.get('/pay/:orderId', (req, res) => {
  const pending = req.session.pendingOrder;
  if (!pending || pending.orderId !== req.params.orderId) {
    return res.status(400).send('找不到待付款訂單，請重新結帳');
  }

  const tradeNo = `TEST${pending.orderId}${Date.now()}`.slice(0, 20); // 20 碼內
  const tradeDate = new Date();
  const pad2 = n => (n < 10 ? '0' + n : '' + n);
  const dateStr = `${tradeDate.getFullYear()}/${pad2(tradeDate.getMonth()+1)}/${pad2(tradeDate.getDate())} ${pad2(tradeDate.getHours())}:${pad2(tradeDate.getMinutes())}:${pad2(tradeDate.getSeconds())}`;

  // 組品項名稱（以「#」隔開），ECPay 需純文字，避免逗號太多
  const itemName = pending.items.map(it => `${it.name}x${it.quantity}`).join('#');

  const base_param = {
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: dateStr,
    TotalAmount: String(pending.total), // 以總計金額送出
    TradeDesc: 'CoffeeOrder',
    ItemName: itemName,
    ReturnURL: 'https://example.com/ecpay/return',    // 伺服器背景接收付款結果（測試可先放假網址）
    OrderResultURL: `http://localhost:${PORT}/result`, // 付款完成導回顧客看到的頁
    ClientBackURL: `http://localhost:${PORT}/`,        // 取消或返回
    ChoosePayment: 'ALL',
    EncryptType: 1,
  };

  const create = new ecpay_payment(ECPAY_OPTIONS);
  const html = create.payment_client.aio_check_out_all(base_param);

  // 回傳一個會自動提交到綠界的 HTML
  res.send(html);
});

// 綠界付款完成導回的前景頁（顧客可見）
app.post('/result', express.urlencoded({ extended: false }), (req, res) => {
  // 這裡可以依照 RtnCode === '1' 判斷交易成功
  // 成功後可清除購物車、顯示成功訊息
  req.session.cart = {};
  req.session.pendingOrder = null;

  res.send(`<html><body style="font-family:sans-serif">
    <h2>付款結果</h2>
    <pre>${JSON.stringify(req.body, null, 2)}</pre>
    <a href="/">回首頁</a>
  </body></html>`);
});

// 背景回傳（server-to-server），正式上線時要檢核 CheckMacValue 並更新訂單狀態
app.post('/ecpay/return', express.urlencoded({ extended: false }), (req, res) => {
  console.log('[ECPay ReturnURL] body:', req.body);
  // TODO: 驗證 CheckMacValue、更新訂單狀態（已付款）
  // 綠界規定要回 "1|OK"
  res.send('1|OK');
});

app.listen(PORT, () => {
  console.log(`Coffee order app running at http://localhost:${PORT}`);
});
