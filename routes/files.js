import { Router } from 'express';
import { getFileBySlug } from '../lib/files.js';
import { getUserById } from '../lib/db-store.js';
import { stripSubscriptionComments } from '../lib/subscription-meta.js';
import { serveUserSubscription } from '../lib/subscription-serve.js';
import { enforceUserLimits } from '../lib/user-enforcement.js';

const router = Router();

function publicRequestUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${req.originalUrl.split('?')[0]}`;
}

router.get('/f/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const format = req.query.format || 'base64';

    const file = await getFileBySlug(slug);
    if (!file) {
      return res.status(404).type('text/plain').send('File not found');
    }

    if (!file.enabled && !file.linkedUserId) {
      return res.status(403).type('text/plain').send('File disabled');
    }

    if (!file.publicAccess) {
      return res.status(403).type('text/plain').send('File is not public');
    }

    if (file.linkedUserId) {
      let user = await getUserById(file.linkedUserId);
      if (!user) {
        return res.status(404).type('text/plain').send('Linked user not found');
      }

      const enforcement = await enforceUserLimits(user);
      if (enforcement.changed) {
        user = (await getUserById(file.linkedUserId)) || enforcement.user || user;
      }

      const profileWebPageUrl = publicRequestUrl(req);
      const served = await serveUserSubscription(res, user, file, format, {
        // Keep legacy /f/:slug imports live as well.  Previously this endpoint
        // served the stored snapshot forever, so IP/SNI/RAW-key changes made
        // in the panel appeared to be ignored by clients using an old URL.
        live: true,
        profileWebPageUrl,
        userAgent: req.get('user-agent'),
        client: req.query.client,
      });
      if (served.ok) return;
      return res.status(served.status).type('text/plain').send(served.message);
    }

    if (file.type === 'subscription') {
      const body = stripSubscriptionComments(file.content || '');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="subscription.txt"');
      return res.send(body);
    }

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="subscription.txt"');
    return res.send(file.content || '');
  } catch (err) {
    console.error('GET /f/:slug error:', err);
    res.status(500).type('text/plain').send('Internal server error');
  }
});

export default router;
