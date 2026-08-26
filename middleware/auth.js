import { verifySessionToken } from '../lib/auth-store.js';

function getAdminKey() {
  return process.env.ADMIN_API_KEY || '';
}

function readBearer(req) {
  const value = req.headers.authorization || '';
  const match = String(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

export async function requireAdmin(req, res, next) {
  const adminKey = getAdminKey();
  const key = req.headers['x-admin-key'];
  if (adminKey && key === adminKey) {
    req.admin = { id: 'admin-key', role: 'owner', username: 'admin-key', dealerId: null };
    return next();
  }

  const token = req.cookies?.panel_session || readBearer(req);
  const admin = await verifySessionToken(token);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });
  req.admin = admin;
  next();
}

export async function requireAdminPage(req, res, next) {
  const adminKey = getAdminKey();
  const key = req.query.key || req.headers['x-admin-key'];
  if (!adminKey || key !== adminKey) {
    return res.status(401).send('Unauthorized. Provide ?key=ADMIN_API_KEY');
  }
  next();
}
