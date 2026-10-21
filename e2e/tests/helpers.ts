import { APIRequestContext, expect, Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const FIXTURES = path.join(__dirname, "..", "fixtures");
const API = "/api-gateway";
const MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo" };

export type Clip = { link_id: string; video_id: string; in: number; out: number; speed: number; posicao: number };
export type Output = { formato: string; qualidade: string; largura: number; altura: number; fit: string };
export type Video = {
  _id: string;
  name: string;
  format: string;
  codec: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  url: string | null;
  preview: { state: string };
};

export const clip = (link_id: string, video_id: string, from: number, to: number, posicao: number, speed = 1): Clip => ({
  link_id,
  video_id,
  in: from,
  out: to,
  speed,
  posicao,
});

export const output = (o: Partial<Output> = {}): Output => ({
  formato: "mp4",
  qualidade: "media",
  largura: 320,
  altura: 240,
  fit: "pad",
  ...o,
});

/** Utilizador novo (cada teste cria o seu) e chamadas à API em nome dele. */
export class Account {
  private constructor(
    readonly api: APIRequestContext,
    readonly user: { _id: string; type: string },
    readonly token: string,
  ) {}

  static async create(api: APIRequestContext, type: "free" | "premium" = "free") {
    const email = `e2e-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    const r = await api.post(`${API}/users`, { data: { name: "E2E", email, password: "Passw0rd!x", type } });
    expect(r.status(), await r.text()).toBe(201);
    const body = await r.json();
    return new Account(api, body.user, body.jwt);
  }

  get uid() {
    return this.user._id;
  }

  private get headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  private url(p: string) {
    return `${API}/projects/${this.uid}${p}`;
  }

  async createProject(name = `e2e-${Date.now()}`) {
    const r = await this.api.post(this.url(""), { headers: this.headers, data: { name } });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json())._id as string;
  }

  async upload(pid: string, file: string) {
    const ext = path.extname(file).slice(1);
    const r = await this.api.post(this.url(`/${pid}/videos`), {
      headers: this.headers,
      multipart: { video: { name: file, mimeType: MIME[ext], buffer: readFileSync(path.join(FIXTURES, file)) } },
      timeout: 120_000,
    });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()) as Video;
  }

  /** Envia os vídeos e espera que as pré-visualizações fiquem prontas. */
  async uploadAll(pid: string, ...files: string[]) {
    const videos = [];
    for (const f of files) videos.push(await this.upload(pid, f));
    await expect
      .poll(async () => (await this.videos(pid)).every((v) => v.preview.state === "ready"), { timeout: 180_000 })
      .toBe(true);
    return videos;
  }

  async videos(pid: string) {
    const r = await this.api.get(this.url(`/${pid}/videos`), { headers: this.headers });
    expect(r.ok()).toBeTruthy();
    return (await r.json()) as Video[];
  }

  async putTimeline(pid: string, faixas: { tipo: string; clips: Clip[] }[], out: Output) {
    const t = await (await this.api.get(this.url(`/${pid}/timeline`), { headers: this.headers })).json();
    const r = await this.api.put(this.url(`/${pid}/timeline`), {
      headers: this.headers,
      data: { version: t.version, output: out, faixas },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }

  /** Pede a exportação da timeline tal como está gravada. */
  async exportTimeline(pid: string) {
    const t = await (await this.api.get(this.url(`/${pid}/timeline`), { headers: this.headers })).json();
    return this.api.post(this.url(`/${pid}/timeline/export`), { headers: this.headers, data: { version: t.version } });
  }

  async tasks(pid: string) {
    return this.api.get(this.url(`/${pid}/video-tasks`), { headers: this.headers });
  }

  async cancelTask(pid: string, taskId: string) {
    return this.api.delete(this.url(`/${pid}/video-tasks/${taskId}`), { headers: this.headers });
  }

  async remainingOperations() {
    const r = await this.api.get(`${API}/users/${this.uid}`, { headers: this.headers });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).remaining_operations as number;
  }
}

// ----------------------------------------------------------------- editor

/** Abre o editor de vídeo do projeto com a sessão do utilizador. */
export async function openEditor(page: Page, account: Account, pid: string) {
  const session = JSON.stringify({ user: account.user, token: account.token });
  await page.addInitScript((s) => localStorage.setItem("session", s), session);
  await page.goto(`/dashboard/${pid}/videos`);
  await expect(page.getByRole("heading", { name: /^Video editor/ })).toBeVisible();
}

/** Duração final mostrada no editor ("/ 00:00:08.000"). */
export const totalDuration = (page: Page) => page.getByTestId("timeline-duration");

export const addToTimeline = (page: Page, name: string) =>
  page.getByRole("button", { name: `Add ${name} to the timeline` }).click();

export const videoClip = (page: Page, name: string, from?: string, to?: string) =>
  page.getByRole("button", { name: from ? `Video clip ${name}, from ${from} to ${to}` : new RegExp(`^Video clip ${re(name)},`) });

export const audioClip = (page: Page, name: string, from?: string, to?: string) =>
  page.getByRole("button", { name: from ? `Audio clip ${name}, from ${from} to ${to}` : new RegExp(`^Audio clip ${re(name)},`) });

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function setPlayhead(page: Page, time: string) {
  const field = page.getByLabel("Time (hh:mm:ss.mmm)");
  await field.fill(time);
  await field.press("Enter");
}

/** Divide todas as faixas no instante indicado (sem clip selecionado). */
export async function splitAt(page: Page, time: string) {
  await setPlayhead(page, time);
  await page.keyboard.press("Escape");
  await page.keyboard.press("s");
}

export async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

export const exportTasks = (page: Page) => page.getByTestId("export-task");

/** Toasts (o texto aparece também numa região aria-live; procurar só aqui). */
export const toasts = (page: Page) => page.getByLabel("Notifications (F8)");

/** Carrega em Export e devolve a linha da nova tarefa. */
export async function startExport(page: Page) {
  await page.getByRole("tab", { name: "Export" }).click();
  const before = await exportTasks(page).count();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(exportTasks(page)).toHaveCount(before + 1);
  return exportTasks(page).first();
}

export async function exportAndWait(page: Page): Promise<Locator> {
  const task = await startExport(page);
  await expect(task).toContainText("Done", { timeout: 240_000 });
  return task;
}

/**
 * Luminância média (0-255) de um fotograma de um vídeo da mesma origem: da
 * faixa esquerda (8 % da largura) e do centro. Serve para ver barras pretas.
 */
export async function frameStats(page: Page, url: string, t = 1) {
  return page.evaluate(
    async ([src, at]) => {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = src as string;
      await new Promise((ok, ko) => {
        v.onloadeddata = ok;
        v.onerror = () => ko(new Error(`video error ${v.error?.code}`));
      });
      v.currentTime = at as number;
      await new Promise((ok) => (v.onseeked = ok));
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(v, 0, 0);
      const lum = (x: number, y: number, w: number, h: number) => {
        const d = ctx.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        return s / (d.length / 4);
      };
      const { width: w, height: h } = c;
      return {
        width: w,
        height: h,
        left: lum(0, 0, Math.floor(w * 0.08), h),
        center: lum(Math.floor(w * 0.4), Math.floor(h * 0.4), Math.floor(w * 0.2), Math.floor(h * 0.2)),
      };
    },
    [url, t] as const,
  );
}

// ------------------------------------------------------- stack (docker)

const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT ?? "picturas";
const container = (service: string) => `${COMPOSE_PROJECT}-${service}-1`;

export function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function restartRabbitMQ() {
  docker("restart", container("rabbitmq"));
}

export function serviceLogs(service: string, since = "10m") {
  return execFileSync("docker", ["logs", "--since", since, container(service)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) as string;
}

/** Altera um vídeo no Mongo do projects-ms (para estados que a UI não consegue criar). */
export function updateVideoInDb(videoId: string, update: object) {
  const js =
    "const m=require('mongoose');m.connect('mongodb://projects_mongoDB:27018/project').then(async()=>{" +
    `const r=await m.connection.db.collection('videos').updateOne({_id:new m.Types.ObjectId(${JSON.stringify(videoId)})},${JSON.stringify(update)});` +
    "process.exit(r.matchedCount===1?0:1)}).catch((e)=>{console.error(e);process.exit(1)})";
  docker("exec", container("projects"), "node", "-e", js);
}
