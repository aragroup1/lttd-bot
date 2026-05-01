import { config } from "../config.js";
import { collectDeployFiles } from "./github.js";

const VERCEL_API = "https://api.vercel.com";

function appendTeam(url: string): string {
  if (!config.vercelTeamId) return url;
  return url.includes("?")
    ? `${url}&teamId=${encodeURIComponent(config.vercelTeamId)}`
    : `${url}?teamId=${encodeURIComponent(config.vercelTeamId)}`;
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

function projectName(slug: string): string {
  return slug.toLowerCase().slice(0, 100);
}

async function tryGetProject(name: string): Promise<any | null> {
  try {
    return await vercelFetch(`/v9/projects/${encodeURIComponent(name)}`);
  } catch (err: any) {
    if (String(err.message).includes("404")) return null;
    throw err;
  }
}

export async function ensureVercelProject(
  _color: string,
  slug: string
): Promise<{ projectId: string; name: string; productionUrl: string; slug: string }> {
  let candidate = projectName(slug);
  const original = candidate;

  let existing = await tryGetProject(candidate);
  if (existing) {
    return {
      projectId: existing.id,
      name: candidate,
      productionUrl: `https://${candidate}.vercel.app`,
      slug: candidate,
    };
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const created = await vercelFetch(`/v10/projects`, {
        method: "POST",
        body: JSON.stringify({ name: candidate, framework: null }),
      });
      return {
        projectId: created.id,
        name: candidate,
        productionUrl: `https://${candidate}.vercel.app`,
        slug: candidate,
      };
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (/reserved|forbidden|name_already_exists|already_exists|conflict|taken/i.test(msg)) {
        candidate = `${original}-${attempt + 2}`;
        const next = await tryGetProject(candidate);
        if (next) {
          return {
            projectId: next.id,
            name: candidate,
            productionUrl: `https://${candidate}.vercel.app`,
            slug: candidate,
          };
        }
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `SLUG_TAKEN: Tried "${original}" through "${original}-10", all unavailable. Ask the user to resend with an added line:  Slug: <alternative-slug>`
  );
}

export async function deploySite(
  color: string,
  slug: string
): Promise<{ deploymentUrl: string; state: string; name: string; fileCount: number }> {
  const name = projectName(slug);
  const files = await collectDeployFiles(color, slug);
  if (!files.find((f) => f.path === "index.html")) {
    throw new Error(`No index.html found in ${color}/${slug}/ — site cannot be deployed.`);
  }

  const body = {
    name,
    project: name,
    target: "production",
    files: files.map((f) => ({
      file: f.path,
      data: f.data.toString("base64"),
      encoding: "base64",
    })),
    projectSettings: { framework: null },
  };

  const deployment = await vercelFetch(`/v13/deployments?forceNew=1`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const id = deployment.id as string;
  const deadline = Date.now() + 5 * 60_000;
  let state: string = deployment.readyState ?? deployment.status ?? "QUEUED";

  while (state !== "READY" && state !== "ERROR" && state !== "CANCELED" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await vercelFetch(`/v13/deployments/${id}`);
    state = poll.readyState ?? poll.status ?? state;
  }

  return {
    deploymentUrl: `https://${name}.vercel.app`,
    state,
    name,
    fileCount: files.length,
  };
}

export async function attachDomain(
  slug: string,
  domain: string
): Promise<{ domain: string; verified: boolean; dnsHints: string[] }> {
  const name = projectName(slug);
  const project = await tryGetProject(name);
  if (!project) throw new Error(`No Vercel project named "${name}".`);

  let result: any;
  try {
    result = await vercelFetch(`/v10/projects/${encodeURIComponent(name)}/domains`, {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    });
  } catch (err: any) {
    if (/already_exists|domain_already_in_use/i.test(String(err.message))) {
      result = { name: domain, verified: false };
    } else {
      throw err;
    }
  }

  const dnsHints = domain.split(".").length === 2
    ? [
        `A @ 76.76.21.21`,
        `CNAME www cname.vercel-dns.com`,
      ]
    : [
        `CNAME ${domain.split(".").slice(0, -2).join(".")} cname.vercel-dns.com`,
      ];

  return { domain, verified: !!result.verified, dnsHints };
}

export async function deleteVercelProject(slug: string): Promise<{ deleted: boolean }> {
  const name = projectName(slug);
  try {
    await vercelFetch(`/v9/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
    return { deleted: true };
  } catch (err: any) {
    if (String(err.message).includes("404")) return { deleted: false };
    throw err;
  }
}
