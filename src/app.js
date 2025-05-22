require('dotenv').config(); // Load environment variables at the very beginning

const config = require('./config'); // Not directly used, but good practice
const redisClient = require('./lib/redisClient'); // Ensures Redis client is initialized and connects
const { startService: startAriService } = require('./services/ariService');

async function main() {
  console.log("Starting application...");

  // redisClient automatically tries to connect and logs its status.
  // We can add a more explicit check here if needed, e.g., by exporting a
  // connection promise from redisClient or checking its status.
  // For now, relying on its internal logging.

  try {
    console.log("Attempting to start ARI service...");
    await startAriService();
    console.log("Application services started successfully.");
    // The application will now keep running, listening to ARI events.
  } catch (error) {
    console.error("Failed to start application services:", error);
    process.exit(1); // Exit if core services can't start
  }
}

main();

// Keep the process alive if it's only event-driven and doesn't have a server
// This is usually not necessary if ARI client keeps it alive or if you have other servers.
// process.stdin.resume(); // Uncomment if needed, but typically ARI client handles this.

console.log(`Application '${config.asterisk.ari_appName}' is running... Log level: ${config.application.log_level}`);
