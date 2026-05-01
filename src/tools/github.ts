import { Octokit } from "@octokit/rest";
import { config, githubOwner, githubRepoName } from "../config.js";

const octokit = new Octokit({ auth: config.githubToken });

let cachedBranch: string | null = null;
async function defaultBranch(): Promise<string> {
  if (cachedBranch) return cachedBranch;
  const res = await octokit.repos.get({ owner: githubOwner, repo: githubRepoName });
  cachedBranch = res.data.default_branch;
  console.log(`[github] default branch for ${githubOwner}/${githubRepoName} = ${cachedBranch}`);
  return cachedBranch;
}

async function getFile(path: string): Promise<{ content: string; sha: string } | null> {
  try {
    const ref = await defaultBranch();
    const res = await octokit.repos.getContent({
      owner: githubOwner,
      repo: githubRepoName,
      path,
      ref,
    });
    const data = res.data as { type: string; content?: string; encoding?: string; sha: string };
    if (Array.isArray(res.data) || data.type !== "file" || !data.content) return null;
    const content = Buffer.from(data.content, (data.encoding ?? "base64") as BufferEncoding).toString("utf8");
    return { content, sha: data.sha };
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function readTemplate(color: string): Promise<string> {
  const file = await getFile(`${color}/index.html`);
  if (!file) throw new Error(`Template not found: ${color}/index.html`);
  return file.content;
}

export async function readClientSite(color: string, slug: string): Promise<string> {
  const file = await getFile(`${color}/${slug}/index.html`);
  if (!file) throw new Error(`Client site not found: ${color}/${slug}/index.html`);
  return file.content;
}

export type Edit = { find: string; replace: string };

function applyEdits(source: string, edits: Edit[]): { html: string; applied: number } {
  let html = source;
  let applied = 0;
  for (const [i, edit] of edits.entries()) {
    if (!edit.find) throw new Error(`Edit ${i}: 'find' is empty`);
    const idx = html.indexOf(edit.find);
    if (idx === -1) {
      throw new Error(
        `Edit ${i}: 'find' string not found in source (first 80 chars: ${edit.find.slice(0, 80)})`
      );
    }
    if (html.indexOf(edit.find, idx + 1) !== -1) {
      throw new Error(
        `Edit ${i}: 'find' string matches multiple times — add more surrounding context to make it unique`
      );
    }
    html = html.slice(0, idx) + edit.replace + html.slice(idx + edit.find.length);
    applied++;
  }
  return { html, applied };
}

async function writeFile(
  path: string,
  html: string,
  commitMessage: string
): Promise<{ commitSha: string; path: string }> {
  const existing = await getFile(path);
  const branch = await defaultBranch();
  const res = await octokit.repos.createOrUpdateFileContents({
    owner: githubOwner,
    repo: githubRepoName,
    path,
    message: commitMessage,
    content: Buffer.from(html, "utf8").toString("base64"),
    branch,
    sha: existing?.sha,
  });
  return { commitSha: res.data.commit.sha ?? "", path };
}

export async function createFromTemplate(
  color: string,
  slug: string,
  edits: Edit[],
  commitMessage: string
): Promise<{ commitSha: string; path: string; editsApplied: number }> {
  const template = await readTemplate(color);
  const { html, applied } = applyEdits(template, edits);
  const path = `${color}/${slug}/index.html`;
  const res = await writeFile(path, html, commitMessage);
  return { ...res, editsApplied: applied };
}

export async function editClientSite(
  color: string,
  slug: string,
  edits: Edit[],
  commitMessage: string
): Promise<{ commitSha: string; path: string; editsApplied: number }> {
  const current = await readClientSite(color, slug);
  const { html, applied } = applyEdits(current, edits);
  const path = `${color}/${slug}/index.html`;
  const res = await writeFile(path, html, commitMessage);
  return { ...res, editsApplied: applied };
}

export type RepoFile = { path: string; data: Buffer };

async function getFileBinary(path: string): Promise<RepoFile | null> {
  try {
    const ref = await defaultBranch();
    const res = await octokit.repos.getContent({
      owner: githubOwner,
      repo: githubRepoName,
      path,
      ref,
    });
    if (Array.isArray(res.data)) return null;
    const data = res.data as { type: string; content?: string; encoding?: string; size?: number };
    if (data.type !== "file") return null;
    if (data.content) {
      return { path, data: Buffer.from(data.content, (data.encoding ?? "base64") as BufferEncoding) };
    }
    if ((data as any).download_url) {
      const dl = await fetch((data as any).download_url);
      return { path, data: Buffer.from(await dl.arrayBuffer()) };
    }
    return null;
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function listFolderRecursive(path: string): Promise<string[]> {
  const ref = await defaultBranch();
  const out: string[] = [];
  let res;
  try {
    res = await octokit.repos.getContent({
      owner: githubOwner,
      repo: githubRepoName,
      path,
      ref,
    });
  } catch (err: any) {
    if (err.status === 404) return [];
    throw err;
  }
  if (!Array.isArray(res.data)) return [];
  for (const entry of res.data) {
    if (entry.type === "file") out.push(entry.path);
    else if (entry.type === "dir") out.push(...(await listFolderRecursive(entry.path)));
  }
  return out;
}

export async function collectDeployFiles(
  color: string,
  slug: string
): Promise<RepoFile[]> {
  const clientPaths = await listFolderRecursive(`${color}/${slug}`);
  const files: RepoFile[] = [];

  for (const p of clientPaths) {
    const f = await getFileBinary(p);
    if (f) files.push({ path: p.slice(`${color}/${slug}/`.length), data: f.data });
  }

  const ref = await defaultBranch();
  const tplRes = await octokit.repos.getContent({
    owner: githubOwner,
    repo: githubRepoName,
    path: color,
    ref,
  });
  if (Array.isArray(tplRes.data)) {
    const haveAtRoot = new Set(files.filter((f) => !f.path.includes("/")).map((f) => f.path));
    for (const entry of tplRes.data) {
      if (entry.type !== "file") continue;
      if (entry.name === "index.html") continue;
      if (haveAtRoot.has(entry.name)) continue;
      const f = await getFileBinary(entry.path);
      if (f) files.push({ path: entry.name, data: f.data });
    }
  }

  return files;
}

export async function deleteClientFolder(
  color: string,
  slug: string,
  commitMessage: string
): Promise<{ deleted: number }> {
  const ref = await defaultBranch();
  const branch = ref;
  const paths = await listFolderRecursive(`${color}/${slug}`);
  let deleted = 0;
  for (const path of paths) {
    const cur = await getFile(path);
    if (!cur) continue;
    await octokit.repos.deleteFile({
      owner: githubOwner,
      repo: githubRepoName,
      path,
      message: commitMessage,
      branch,
      sha: cur.sha,
    });
    deleted++;
  }
  return { deleted };
}

export async function listClients(): Promise<{ color: string; slug: string }[]> {
  const templates = ["como", "orange", "pink", "purple", "red", "white"];
  const ref = await defaultBranch();
  const results: { color: string; slug: string }[] = [];
  for (const color of templates) {
    try {
      const res = await octokit.repos.getContent({
        owner: githubOwner,
        repo: githubRepoName,
        path: color,
        ref,
      });
      if (!Array.isArray(res.data)) continue;
      for (const entry of res.data) {
        if (entry.type === "dir") results.push({ color, slug: entry.name });
      }
    } catch {
      // skip missing template folders
    }
  }
  return results;
}
