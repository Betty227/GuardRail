const http = require("node:http");

function transactionQueue(purchase, capacity) {
  const pending = new Map();
  let tail = Promise.resolve();
  return intent => {
    if (pending.has(intent)) return pending.get(intent);
    if (pending.size >= capacity) throw Error("queue full");
    const result = tail.then(() => purchase(intent)).finally(() => pending.delete(intent));
    pending.set(intent, result);
    tail = result.catch(() => {});
    return result;
  };
}

function sandbox(purchase, { capacity = 8, perMinute = 12 } = {}) {
  const submit = transactionQueue(purchase, capacity);
  const windows = new Map();
  const cleanup = setInterval(() => {
    for (const [ip, entry] of windows) if (entry.until <= Date.now()) windows.delete(ip);
  }, 60000).unref();
  const server = http.createServer(async (req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, {"content-type":"application/json", "cache-control":"no-store"});
      res.end(JSON.stringify(payload));
    };
    const match = /^\/purchases\/([A-Za-z0-9_-]{1,64})$/.exec(req.url);
    if (req.method !== "POST" || !match) return send(404, {error:"Unknown endpoint"});
    if (req.headers.origin && req.headers.origin !== process.env.GUARDRAIL_ALLOWED_ORIGIN)
      return send(403,{error:"Origin denied"});
    if (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) !== 0)
      return send(400,{error:"Fixed synthetic order only"});
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let entry = windows.get(ip);
    if (!entry || entry.until <= now) {
      entry = {until:now+60000,count:0}; windows.set(ip,entry);
    }
    if (++entry.count > perMinute) {
      res.setHeader("retry-after", Math.ceil((entry.until-now)/1000));
      return send(429,{error:"Request limit reached"});
    }
    let job;
    try { job = submit(match[1]); }
    catch { return send(503,{error:"Queue at capacity"}); }
    try { send(200,await job); }
    catch { send(502,{error:"Purchase incomplete. Retry with the same reference."}); }
  });
  server.once("close", () => clearInterval(cleanup));
  return server;
}
module.exports = {sandbox, transactionQueue};
if (require.main === module) {
  const {purchase} = require("./purchase");
  const port = Number(process.env.PORT || 3030);
  sandbox(purchase).listen(port, "127.0.0.1", () => console.log("Sandbox listening on loopback port",port));
}
