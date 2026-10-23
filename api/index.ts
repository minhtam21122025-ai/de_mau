import app from '../src/server/app.js';

export default function handler(req: any, res: any) {
  // Chuẩn hóa đường dẫn khi Vercel rewrite /api/(.*) -> /api?path=$1
  if (req.query && req.query.path) {
    const subpath = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
    req.url = '/api/' + String(subpath).replace(/^\/+/, '');
  } else if (!req.url || req.url === '/' || req.url === '/api' || req.url.startsWith('/?')) {
    const matched = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url'];
    if (matched && typeof matched === 'string' && matched.startsWith('/api')) {
      req.url = matched;
    }
  }

  // Đảm bảo req.url luôn có prefix /api nếu bị rút ngắn
  if (req.url && !req.url.startsWith('/api') && (
    req.url.startsWith('/auth') ||
    req.url.startsWith('/exam') ||
    req.url.startsWith('/admin') ||
    req.url.startsWith('/health')
  )) {
    req.url = '/api' + req.url;
  }

  return app(req, res);
}
