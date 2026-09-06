"use strict";
setTimeout(() => process.exit(0), Math.max(1, Number(process.argv[2]) - Date.now()));
process.on("message", (message) => { if (message === "finish") process.exit(0); });
