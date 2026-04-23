import { config, githubOwner, githubRepoName } from "../config.js";

const VERCEL_API = "https://api.vercel.com";

function teamQuery(): string {
  return config.vercelTeamId ? `?teamId=${encodeURIComponent(config.vercelTeamId)}` : "";
}

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
  color: string,
  slug: string
): Promise<{ projectId: string; name: string; productionUrl: string }> {
  const name = projectName(color, slug);

  try {
    const existing = await vercelFetch(`/v9/projects/${encodeURIComponent(name)}`);
    return {
      projectId: existing.id,
      name,
      productionUrl: `https://${name}.vercel.app`,
    };
  } catch (err: any) {
    if (!String(err.message).includes("404")) throw err;
  }

  let created: any;
  try {
    created = await vercelFetch(`/v10/projects`, {
      method: "POST",
      body: JSON.stringify({
        name,
        framework: null,
        rootDirectory: `${color}/${slug}`,
        gitRepository: {
          type: "github",
          repo: `${githubOwner}/${githubRepoName}`,
        },
      }),
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

  return {
    projectId: created.id,
    name,
    productionUrl: `https://${name}.vercel.app`,
  };
}

export async function triggerDeploy(
  projectId: string,
  name: string,
  commitSha?: string
): Promise<{ deploymentUrl: string; state: string }> {
  const body: Record<string, unknown> = {
    name,
    project: projectId,
    target: "production",
    gitSource: {
      type: "github",
      repoId: undefined,
      ref: "main",
      sha: commitSha,
    },
  };

  const deployment = await vercelFetch(`/v13/deployments`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const id = deployment.id as string;
  const deadline = Date.now() + 5 * 60_000;
  let state: string = deployment.readyState ?? deployment.status ?? "QUEUED";
  let url: string = deployment.url ? `https://${deployment.url}` : `https://${name}.vercel.app`;

  while (state !== "READY" && state !== "ERROR" && state !== "CANCELED" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await vercelFetch(`/v13/deployments/${id}`);
    state = poll.readyState ?? poll.status ?? state;
    if (poll.url) url = `https://${poll.url}`;
  }

  return { deploymentUrl: url, state };
}
