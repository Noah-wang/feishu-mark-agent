import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

const config = await loadConfig();
startServer(config);
