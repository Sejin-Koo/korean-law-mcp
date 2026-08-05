import http from "node:http";
import handler from "./api/mcp.js";
http.createServer((req, res) => handler(req, res)).listen(3111, () => console.log("ready"));
