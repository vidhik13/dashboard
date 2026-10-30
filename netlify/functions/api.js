import vercelHandler from "../../carton-vercel/api/index.js";

export default async function handler(request) {
  let body;
  if (request.method !== "GET" && request.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }
  }

  let status = 200;
  let responseBody;
  let isJson = false;
  const response = {
    status(code) {
      status = code;
      return this;
    },
    send(value) {
      responseBody = value;
      return this;
    },
    json(value) {
      responseBody = JSON.stringify(value);
      isJson = true;
      return this;
    },
  };

  await vercelHandler({
    method: request.method,
    body,
    headers: { authorization: request.headers.get("authorization") || "" },
  }, response);

  return new Response(responseBody ?? null, {
    status,
    headers: isJson ? { "content-type": "application/json" } : { "content-type": "text/plain; charset=utf-8" },
  });
}
