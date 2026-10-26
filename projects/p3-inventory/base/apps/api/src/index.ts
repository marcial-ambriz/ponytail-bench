import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { config } from "./config.js";

serve({ fetch: createApp().fetch, port: config.API_PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
