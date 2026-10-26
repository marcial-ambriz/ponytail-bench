import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { config } from "./config.js";
import { createServices } from "./services.js";

const services = await createServices({
  dbPath: config.DB_PATH,
  secret: config.BETTER_AUTH_SECRET,
  webPort: config.WEB_PORT,
});

serve({ fetch: createApp(services).fetch, port: config.API_PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port} (db: ${config.DB_PATH})`);
});
