const zlib = require('zlib');

function shouldCompress(req, res) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/i.test(ae)) return false;
  const type = String(res.getHeader('Content-Type') || '');
  if (!type) return false;
  return /(json|javascript|text|html|xml|svg|css|csv)/i.test(type);
}

module.exports = function compression() {
  return function compressionMiddleware(req, res, next) {
    const chunks = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let ended = false;

    res.write = (chunk, encoding, callback) => {
      if (ended) return false;
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = (chunk, encoding, callback) => {
      if (ended) return;
      ended = true;
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));

      const body = Buffer.concat(chunks);
      if (!shouldCompress(req, res) || body.length < 1024) {
        res.write = originalWrite;
        res.end = originalEnd;
        return originalEnd(body, callback);
      }

      zlib.gzip(body, (err, compressed) => {
        res.write = originalWrite;
        res.end = originalEnd;
        if (err) return originalEnd(body, callback);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
        return originalEnd(compressed, callback);
      });
    };

    next();
  };
};
