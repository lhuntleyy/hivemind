const path = require("path");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "hivemind",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned
      // to the repo. Starting with `pm2 start index.js` from another directory silently
      // loses .env and the JSON state files.
      env: {
        NODE_ENV: "production",
        // The control panel reads and writes the wallet key. Loopback only; reach it
        // from your laptop with:
        //   ssh -N -L 4141:127.0.0.1:4141 user@vps
        // Never set this to 0.0.0.0 without also setting HIVEMIND_WEB_TOKEN — the
        // server refuses to bind a public interface without one, by design.
        HIVEMIND_WEB_HOST: "127.0.0.1",
      },
    },
  ],
};
