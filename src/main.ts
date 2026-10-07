import { createServer, defaultDbPath } from "./server";

async function main(): Promise<void> {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const dbArg = process.argv.find((a) => a.startsWith("--db="));
  const port = portArg ? parseInt(portArg.split("=")[1], 10) : undefined;
  const dbPath = dbArg ? dbArg.split("=")[1] : defaultDbPath();

  const { server, store } = await createServer(dbPath, port);
  const actual = (server.address() as { port: number }).port;
  process.stdout.write(
    `TCP Reno 回放服务已启动\n  地址:   http://127.0.0.1:${actual}\n  数据库: ${dbPath}\n`,
  );

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
