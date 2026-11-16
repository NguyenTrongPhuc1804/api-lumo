import express from "express";

// Dung server that tren cong ngau nhien de test qua HTTP, khong can supertest.
export async function startTestServer(router, path = "/api") {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
