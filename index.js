var params = (query, path) => {
  if (!/\:/.test(query) && query !== path) return;

  return query.split("/").reduce((params, part, i) => {
    if (!/^\:/.test(part)) return params;
    const name = part.replace(/^\:/, "");
    params[name] = path.split("/")[i];
    return params;
  }, {});
};

// Put an undetermined number of callbacks together
// Stops when one of them returns something
var reduce = (...cbs) => async ctx => {
  for (let cb of cbs) {
    try {
      const data = await cb(ctx);
      if (data) return data;
    } catch (error) {
      return { body: error.message, status: 500 };
    }
  }
  return { body: "Not Found", status: 404 };
};

// Normalize the reply to return always an object in the same format
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, PUT, PATCH, POST, DELETE, HEAD"
};

var reply = async (handler, ctx) => {
  const data = await handler(ctx);
  const headers = {};
  if (ctx.options.cors === true) {
    for (let key in cors) {
      headers[key] = cors[key];
    }
    // Quick reply for the OPTIONS CORS
    if (ctx.method === "OPTIONS") {
      return { body: "", headers, status: 200 };
    }
  }

  if (!data) return { body: "Not found", headers, status: 404 };

  // The function means the hanlder knows what it's doing and wants a raw reply
  if (typeof data === "function") {
    const rest = await data(ctx);
    return { status: 200, headers, ...rest };
  }

  // A plain string response
  if (typeof data === "string") return { body: data, headers, status: 200 };

  // Most basic of error handling, anything higher level should be on user code
  if (data instanceof Error) {
    return { status: data.status || 500, headers, body: data.message };
  }

  // Treat it as a plain object
  return {
    body: JSON.stringify(data),
    status: data.status || 200,
    headers: { ...headers, "content-type": "application/json" }
  };
};

// Node native body parser
const parseBody = async req => {
  return new Promise((done, fail) => {
    const type = req.headers["content-type"];
    const parser = /application\/json/.test(type)
      ? data => JSON.parse(data)
      : data => data;
    const data = [];
    req
      .on("data", chunk => {
        data.push(chunk);
      })
      .on("end", () => {
        const raw = Buffer.concat(data).toString();
        try {
          done(parser(raw));
        } catch (error) {
          fail(error);
        }
      })
      .on("error", fail);
  });
};

// Cloudflare body parser as https://developers.cloudflare.com/workers/templates/snippets/post_data/
async function readRequestBody(request) {
  const { headers } = request;
  const contentType = headers.get("content-type") || "text/html";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    return JSON.stringify(body);
  } else if (contentType.includes("application/text")) {
    const body = await request.text();
    return body;
  } else if (contentType.includes("text/html")) {
    const body = await request.text();
    return body;
  } else if (contentType.includes("form")) {
    const formData = await request.formData();
    let body = {};
    for (let entry of formData.entries()) {
      body[entry[0]] = entry[1];
    }
    return JSON.stringify(body);
  } else {
    let myBlob = await request.blob();
    var objectURL = URL.createObjectURL(myBlob);
    return objectURL;
  }
}

var bodyParser = async ctx => {
  // No parsing for now
  if (!ctx.req) return;

  // Parsing it out of the request's text() method
  if (ctx.req.text) {
    ctx.body = await readRequestBody(ctx.req);
    return;
  }
  ctx.body = await parseBody(ctx.req);
};

const decode = decodeURIComponent;

// Parse the query from the url (without the `?`)
const parseQuery = (query = "") => {
  return query
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .map(p => p.split("="))
    .reduce((all, [key, val]) => ({ ...all, [decode(key)]: decode(val) }), {});
};

// Available in Node since 10.0.0
// https://nodejs.org/api/globals.html#globals_url
var urlParser = async ctx => {
  const url = new URL(ctx.url);
  ctx.protocol = url.protocol;
  ctx.host = url.host;
  ctx.port = url.port;
  ctx.hostname = url.hostname;
  ctx.password = url.password;
  ctx.username = url.username;
  ctx.origin = url.origin;
  ctx.path = url.pathname;
  ctx.query = parseQuery(url.search);
  ctx.href = url.href;
};

var middle = [urlParser, bodyParser];

const runtime = "node";

const getUrl = ({ protocol = "http", headers, url = "/" }) => {
  return protocol + "://" + headers["host"] + url;
};

// https://stackoverflow.com/a/19524949/938236
const getIp = req => {
  return (
    (req.headers["x-forwarded-for"] || "").split(",").pop() ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.connection.socket.remoteAddress
  );
};

// Launch the server for the Node.js environment
var node = async (handler, options = {}) => {
  const { createServer } = await import('http');

  const server = createServer(async (req, res) => {
    // Handle each of the API calls here:
    const reply = await handler({
      url: getUrl(req),
      method: req.method,
      headers: req.headers,
      ip: getIp(req),
      runtime,
      req
    });

    res.statusCode = reply.status || 200;
    for (let key in reply.headers) {
      res.setHeader(key, reply.headers[key]);
    }
    res.write(reply.body);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(options.port, error => {
      if (error) reject(error);
      resolve({ options, handler, runtime, close: () => server.close() });
    });
  });
};

const runtime$1 = "cloudflare";

const getIp$1 = req => req.headers.get("CF-Connecting-IP");

// At least one header has to be read first so that .entries() works
const getHeaders = ({ headers }) => {
  const plain = {};
  for (let entry of headers.entries()) {
    headers[entry[0]] = entry[1];
  }
  return plain;
};

// Launch the server in a Cloudflare Worker
var cloudflare = (handler, options = {}) => {
  addEventListener("fetch", e => {
    const response = handler({
      url: e.request.url,
      method: e.request.method,
      headers: getHeaders(e.request),
      ip: getIp$1(e.request),
      runtime: runtime$1,
      req: e.request
    }).then(({ status, body, headers }) => {
      return new Response(body, { status, headers });
    });
    return e.respondWith(response);
  });
  return Promise.resolve({ options, handler, runtime: runtime$1, close: () => {} });
};

// Cloudflare has to be detected and launched immediately, so no async/await
const detectEngineSync = () => {
  if (typeof addEventListener !== "undefined" && typeof fetch !== "undefined") {
    return cloudflare;
  }
};

// Node.js can be detected async by the presence of `http`
const detectEngineAsync = async () => {
  try {
    await import('http');
    return node;
  } catch (error) {
    throw new Error("Could not find engine automatically");
  }
};

// Loosely find which one is the correct runtime through ducktyping
var getEngine = () => detectEngineSync() || detectEngineAsync();

var index = (...cbs) => async ctx => {
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];

  ctx.params = params(path, ctx.path);
  if (!ctx.params) return;
  return reduce(...all)(ctx);
};

var index$1 = (...cbs) => async ctx => {
  if (ctx.method !== "GET") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];

  ctx.params = params(path, ctx.path);
  if (!ctx.params) return;
  return reduce(...all)(ctx);
};

var index$2 = (...cbs) => async ctx => {
  if (ctx.method !== "POST") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];
  if (path !== ctx.path) return;
  return reduce(...all)(ctx);
};

var index$3 = (...cbs) => async ctx => {
  if (ctx.method !== "PUT") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];
  if (path !== ctx.path) return;
  return reduce(...all)(ctx);
};

var index$4 = (...cbs) => async ctx => {
  if (ctx.method !== "PATCH") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];
  if (path !== ctx.path) return;
  return reduce(...all)(ctx);
};

var index$5 = (...cbs) => async ctx => {
  if (ctx.method !== "DELETE") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];
  if (path !== ctx.path) return;
  return reduce(...all)(ctx);
};

var index$6 = (...cbs) => async ctx => {
  if (ctx.method !== "HEAD") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];
  if (path !== ctx.path) return;
  return reduce(...all)(ctx);
};

var index$7 = (...cbs) => async ctx => {
  if (ctx.method !== "OPTIONS") return;
  const [path, ...all] = typeof cbs[0] === "string" ? cbs : [ctx.path, ...cbs];
  if (path !== ctx.path) return;
  return reduce(...all)(ctx);
};

// Some other, non-HTTP methods but routers nonetheless
// export { default as socket } from "./socket";
// export { default as domain } from "./domain";

// Cannot do async/await here because some of them MUST be launched immediately
const runEngine = (handler, options) => {
  return options.engine.then
    ? options.engine.then(engine => engine(handler, options))
    : options.engine(handler, options);
};

// The main function that runs the whole thing
var index$8 = async (options = {}, ...middleware) => {
  if (typeof options === "function") {
    middleware.unshift(options);
    options = { port: 3000 };
  }
  options.engine = options.engine || getEngine();

  const addOptions = ctx => {
    ctx.options = options;
  };

  // Generate a single callback with all the middleware
  const callback = reduce(addOptions, ...middle, ...middleware);

  return runEngine(ctx => reply(callback, ctx), options);
};

export default index$8;
export { index as any, index$5 as del, index$1 as get, index$6 as head, index$7 as options, index$4 as patch, index$2 as post, index$3 as put };
