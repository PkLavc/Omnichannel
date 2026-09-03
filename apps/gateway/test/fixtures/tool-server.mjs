import { createServer } from "node:http";

createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url !== "/tool") {
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: "not found" }));
  }
  if (request.method === "GET") {
    response.statusCode = 405;
    return response.end(JSON.stringify({ error: "POST required" }));
  }
  if (request.method !== "POST" || request.headers.authorization !== "Bearer fixture-tool-secret") {
    response.statusCode = 401;
    return response.end(JSON.stringify({ error: "unauthorized" }));
  }
  let raw = "";
  request.on("data", chunk => raw += chunk);
  request.on("end", () => {
    const body = JSON.parse(raw);
    response.end(JSON.stringify({
      name: body.tool,
      found: true,
      content: `Resultado real da Tool para: ${body.input}`,
    }));
  });
}).listen(8081, "0.0.0.0");
