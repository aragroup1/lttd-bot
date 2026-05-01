import { config } from "../config.js";
import { readClientSite } from "./github.js";

const VERCEL_API = "https://api.vercel.com";

function appendTeam(url: string): string {
  if (!config.vercelTeamId) return url;
  return url.includes("?") ? `${url}&teamId=${encodeURIComponent(config.vercelTeamId)}` : `${url}?teamId=${encodeURIComponent(config.vercelTeamId)}`;
}

async function vercelFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(appendTeam(`${VERCEL_API}${path}`), {
    ...init,
    headers: {
      Authorization: `Bearer ${config.vercelToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Vercel API ${res.status} on ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

function projectName(_color: string, slug: string): string {
  return slug.toLowerCase().slice(0, 100);
}

export async function ensureVercelProject(
  _color: string,
  slug: string
): Promise<{ projectId: string; name: string; productionUrl: string }> {
  const name = projectName(_color, slug);

  let project: any;
  try {
    project = await vercelFetch(`/v9/projects/${encodeURIComponent(name)}`);
  } catch (err: any) {
    if (!String(err.message).includes("404")) throw err;
  }

  if (!project) {
    try {
      project = await vercelFetch(`/v10/projects`, {
        method: "POST",
        body: JSON.stringify({ name, framework: null }),
      });
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (/reserved|forbidden|name_already_exists|already_exists|conflict|taken/i.test(msg)) {
        throw new Error(
          `SLUG_TAKEN: Vercel project name "${name}" is unavailable. Ask the user to resend the same message with an added line:  Slug: <alternative-slug>  (e.g. Slug: ${name}-wedding)`
        );
      }
      throw err;
    }
  }

  return {
    projectId: project.id,
    name,
    productionUrl: `https://${name}.vercel.app`,
  };
}

export async function deploySite(
  color: string,
  slug: string
): Promise<{ deploymentUrl: string; state: string; name: string }> {
  const name = projectName(color, slug);
  const html = await readClientSite(color, slug);
  const body = {
    name,
    project: name,
    target: "production",
    files: [
      {
        file: "index.html",
        data: Buffer.from(html, "utf8").toString("base64"),
        encoding: "base64",
      },
    ],
    projectSettings: { framework: null },
  };

  const deployment = await vercelFetch(`/v13/deployments?forceNew=1`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const id = deployment.id as string;
  const deadline = Date.now() + 5 * 60_000;
  let state: string = deployment.readyState ?? deployment.status ?? "QUEUED";
  let url: string = deployment.url ? `https://${deployment.url}` : `https://${name}.vercel.app`;

  while (state !== "READY" && state !== "ERROR" && state !== "CANCELED" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await vercelFetch(`/v13/deployments/${id}`);
    state = poll.readyState ?? poll.status ?? state;
    if (poll.url) url = `https://${poll.url}`;
  }

  return { deploymentUrl: `https://${name}.vercel.app`, state, name };
}
