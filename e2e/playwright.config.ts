import { defineConfig, devices } from "@playwright/test";

// Testes de ponta a ponta do editor de vídeo, contra a stack a correr
// (docker compose up). Como correr: ver e2e/REPORT.md.
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./tests",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  // Há um só worker de render e há testes que reiniciam o RabbitMQ: um teste de cada vez
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "https://localhost:8080",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Google Chrome (tem H.264; o Chromium do Playwright não tem)
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport } },
    // No Firefox correm os testes da UI; os do backend não dependem do browser
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport },
      testMatch: /(editor|playback|history)\.spec\.ts/,
    },
  ],
});
