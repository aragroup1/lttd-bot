import { Octokit } from "@octokit/rest";
import { config, githubOwner, githubRepoName } from "../config.js";

const octokit = new Octokit({ auth: config.githubToken });

async function getFile(path: string): Promise<{ content: string; sha: string } | null> {
  try {
    const res = await octokit.repos.getContent({
      owner: githubOwner,
      repo: githubRepoName,
      path,
      ref: "main",
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

export async function writeClientSite(
  color: string,
  slug: string,
  html: string,
  commitMessage: string
): Promise<{ commitSha: string; path: string }> {
  const path = `${color}/${slug}/index.html`;
  const existing = await getFile(path);

  const res = await octokit.repos.createOrUpdateFileContents({
    owner: githubOwner,
    repo: githubRepoName,
    path,
    message: commitMessage,
    content: Buffer.from(html, "utf8").toString("base64"),
    branch: "main",
    sha: existing?.sha,
  });

  return { commitSha: res.data.commit.sha ?? "", path };
}

export async function listClients(): Promise<{ color: string; slug: string }[]> {
  const templates = ["como", "orange", "pink", "purple", "red", "white"];
  const results: { color: string; slug: string }[] = [];
  for (const color of templates) {
    try {
      const res = await octokit.repos.getContent({
        owner: githubOwner,
        repo: githubRepoName,
        path: color,
        ref: "main",
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
