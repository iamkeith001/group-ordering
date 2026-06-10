const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const ASSETS = {
  '/order.html': { file: 'order.html', type: ASSET_TYPES['.html'] },
  '/style.css': { file: 'style.css', type: ASSET_TYPES['.css'] },
  '/app.js': { file: 'app.js', type: ASSET_TYPES['.js'] },
  '/menu/burgerking.js': { file: 'menu/burgerking.js', type: ASSET_TYPES['.js'] }
};
const ASSET_CONTENTS = {};

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      drink TEXT NOT NULL,
      img TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_orders_group_created ON orders(group_id, created_at);
  `);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function normalizeGroupId(value) {
  const groupId = String(value || '').trim();
  if (!groupId || groupId.length > 80) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(groupId)) return null;
  return groupId;
}

function validateOrder(input) {
  const groupId = normalizeGroupId(input?.groupId);
  const name = String(input?.name || '').trim();
  const drink = String(input?.drink || '').trim();
  const img = String(input?.img || '').trim();

  if (!groupId) return { error: 'Invalid groupId' };
  if (!name || name.length > 40) return { error: 'Invalid name' };
  if (!drink || drink.length > 120) return { error: 'Invalid drink' };
  if (img.length > 1000) return { error: 'Invalid image URL' };

  return { groupId, name, drink, img };
}

async function handleGet(request, env) {
  const url = new URL(request.url);
  const groupId = normalizeGroupId(url.searchParams.get('g'));
  if (!groupId) return json({ success: false, error: 'Invalid group id' }, 400);

  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(`
    SELECT name, drink, img, created_at AS createdAt
    FROM orders
    WHERE group_id = ?
    ORDER BY datetime(created_at) ASC, id ASC
  `).bind(groupId).all();

  return json({ success: true, orders: results || [] });
}

async function handleOrder(request, env) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, 400);
  }

  const order = validateOrder(input);
  if (order.error) return json({ success: false, error: order.error }, 400);

  await ensureSchema(env.DB);
  await env.DB.prepare(`
    INSERT INTO orders (group_id, name, drink, img)
    VALUES (?, ?, ?, ?)
  `).bind(order.groupId, order.name, order.drink, order.img).run();

  return json({ success: true });
}

async function serveAsset(pathname) {
  const asset = ASSETS[pathname] || ASSETS['/order.html'];
  const body = ASSET_CONTENTS[pathname] || ASSET_CONTENTS['/order.html'];

  return new Response(body, {
    headers: {
      'content-type': asset.type,
      'cache-control': asset.file.endsWith('.html') ? 'no-store' : 'public, max-age=300'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/get.php') {
      return handleGet(request, env);
    }

    if (url.pathname === '/api/order.php' && request.method === 'POST') {
      return handleOrder(request, env);
    }

    if (url.pathname === '/' || ASSETS[url.pathname]) {
      return serveAsset(url.pathname === '/' ? '/order.html' : url.pathname);
    }

    return serveAsset('/order.html');
  }
};
