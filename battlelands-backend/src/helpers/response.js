function ok(res, data) {
  return res.json({ code: 200, status: 'OK', data });
}

function stub(res) {
  return res.json({ code: 200, status: 'OK' });
}

function fail(res, code, error, message, details = {}) {
  return res.status(code >= 500 ? 500 : 200).json({
    code,
    status: code === 401 ? 'Unauthorized' : code >= 500 ? 'InternalServerError' : 'BadRequest',
    error,
    errorMessage: message,
    errorDetails: details
  });
}

module.exports = { ok, stub, fail };
