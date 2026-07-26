import type { Octokit } from "@octokit/core";
import { decode, encode } from "js-base64";
import type { UserInfo } from "@/api/endpoints/type";
import type { FileEntry } from "@/database/assets";
import { shortId } from "@/database/id";
import type {
    AssetKey,
    FileLike,
    FileWithContent,
    StoreStructure,
    Syncer,
} from ".";

const loadOctokit = () =>
    import("@octokit/core").then(({ Octokit }) => {
        return Octokit;
    });

const withRandomT = () => ({
    t: Date.now(), // 添加时间戳参数，使每次请求的 URL 都不同
});

const loadOctokitPaginate = () =>
    import("@octokit/plugin-paginate-rest").then((v) => v.paginateRest);

const treeDateToStructure = (
    tree: {
        path: string;
        mode: string;
        type: string;
        sha: string;
        size?: number;
        url?: string;
    }[],
    entryName: string,
) => {
    const structure = tree.reduce(
        (p, c) => {
            if (c.path === "meta.json") {
                p.meta = c;
            } else if (c.path.startsWith("assets/")) {
                p.assets.push(c);
            } else if (
                c.path.startsWith(`${entryName}-`) &&
                c.path.endsWith(`.json`)
            ) {
                const startIndex = Number(
                    c.path.replace(`${entryName}-`, "").replace(".json", ""),
                );
                p.chunks.push({ ...c, startIndex });
            }
            return p;
        },
        {
            chunks: [],
            assets: [],
            meta: { path: "", sha: "", size: 0 },
        } as StoreStructure,
    );

    // 按照startIndex数字顺序对chunks进行排序
    // GitHub API返回的是字典序（entry-1000, entry-10000, entry-2000）
    // 需要按数字排序（entry-1000, entry-2000, entry-10000）
    structure.chunks.sort((a, b) => a.startIndex - b.startIndex);

    // 对assets按路径排序，保持一致性
    structure.assets.sort((a, b) => a.path.localeCompare(b.path));

    return structure;
};

const pathToName = (path: string) => {
    const splitted = path.split("/");
    return splitted[splitted.length - 1];
};

async function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(",")[1];
            resolve(base64);
        };
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(blob);
    });
}

/**
 * createGithubSyncer
 * args: { auth: ()=>Promise<{ accessToken, refreshToken? }>, repoPrefix?:string, entryName?:string }
 */
export const createGithubSyncer = (config: {
    auth: any;
    repoPrefix: string;
    entryName: string;
    /** Gitea / self-hosted Git server URL, e.g. https://git.example.com */
    serverUrl?: string;
}): Syncer => {
    const {
        auth,
        repoPrefix = "gitray-db",
        entryName = "entry",
        serverUrl,
    } = config || {};

    const isGitea = Boolean(serverUrl);

    const getOctokit = (() => {
        let oc: Octokit | undefined;
        return async () => {
            if (!oc) {
                const Octokit = await loadOctokit();
                const { accessToken } = await auth();
                oc = new Octokit({
                    auth: accessToken,
                    ...(serverUrl
                        ? { baseUrl: `${serverUrl.replace(/\/$/, "")}/api/v1` }
                        : {}),
                });
            }
            return oc;
        };
    })();

    // fetch repo tree -> structure
    const fetchStructure = async (storeFullName: string) => {
        const [owner, repo] = storeFullName.split("/");
        if ([owner, repo].some((v) => v.length === 0))
            throw new Error(`invalid store name: ${storeFullName}`);

        if (isGitea) {
            // Gitea: use Contents API — Git data API paths are incompatible
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;

            // Get repo info for default branch
            let branch = "main";
            try {
                const repoRes = await fetch(
                    `${apiBase}/repos/${owner}/${repo}`,
                    {
                        headers: { Authorization: `token ${accessToken}` },
                    },
                );
                if (repoRes.ok) {
                    const info = await repoRes.json();
                    branch = info.default_branch || "main";
                }
            } catch {
                // Repo might not exist or is empty
                return {
                    chunks: [],
                    assets: [],
                    meta: { path: "", sha: "", size: 0 },
                } as StoreStructure;
            }

            // List root contents
            let rootFiles: any[] = [];
            let hasAssetsDir = false;
            try {
                const rootRes = await fetch(
                    `${apiBase}/repos/${owner}/${repo}/contents?ref=${branch}`,
                    {
                        headers: { Authorization: `token ${accessToken}` },
                    },
                );
                if (rootRes.ok) {
                    rootFiles = (await rootRes.json()) || [];
                    if (!Array.isArray(rootFiles)) rootFiles = [rootFiles];
                    hasAssetsDir = rootFiles.some(
                        (f: any) => f.type === "dir" && f.path === "assets",
                    );
                }
            } catch {
                rootFiles = [];
            }

            // Only list assets dir if it exists (avoid pointless 404)
            let assetsFiles: any[] = [];
            if (hasAssetsDir) {
                try {
                    const assetsRes = await fetch(
                        `${apiBase}/repos/${owner}/${repo}/contents/assets?ref=${branch}`,
                        {
                            headers: {
                                Authorization: `token ${accessToken}`,
                            },
                        },
                    );
                    if (assetsRes.ok) {
                        assetsFiles = (await assetsRes.json()) || [];
                        if (!Array.isArray(assetsFiles))
                            assetsFiles = [assetsFiles];
                    }
                } catch {
                    // ignore
                }
            }

            const combined = [...rootFiles, ...assetsFiles].map(
                (f: any) => ({
                    path: f.path,
                    mode: "100644",
                    type: f.type === "dir" ? "tree" : "blob",
                    sha: f.sha,
                    size: f.size,
                }),
            );

            return treeDateToStructure(combined, entryName);
        }

        // GitHub: use Git data API
        const octokit = await getOctokit();

        try {
            const { data: repoData } = await octokit.request(
                "GET /repos/{owner}/{repo}",
                { owner, repo, ...withRandomT() },
            );
            const { data: refData } = await octokit.request(
                "GET /repos/{owner}/{repo}/git/ref/{ref}",
                {
                    owner,
                    repo,
                    ref: `heads/${repoData.default_branch}`,
                    ...withRandomT(),
                },
            );
            const latestCommitSha = refData.object.sha;

            const { data: commitData } = await octokit.request(
                "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
                { owner, repo, commit_sha: latestCommitSha, ...withRandomT() },
            );
            const treeSha = commitData.tree.sha;

            const { data: treeData } = await octokit.request(
                "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
                {
                    owner,
                    repo,
                    tree_sha: treeSha,
                    recursive: "true",
                    ...withRandomT(),
                },
            );

            const structure = treeDateToStructure(treeData.tree, entryName);
            return structure;
        } catch (e: any) {
            // Empty repo (no commits / no default branch) — return empty structure
            if (e?.status === 404 || e?.status === 409) {
                return {
                    chunks: [],
                    assets: [],
                    meta: { path: "", sha: "", size: 0 },
                } as StoreStructure;
            }
            throw e;
        }
    };

    // fetch blobs by sha and decode content (base64)
    const fetchContent = async (storeFullName: string, files: FileLike[]) => {
        const [owner, repo] = storeFullName.split("/");
        if ([owner, repo].some((v) => v.length === 0))
            throw new Error(`invalid store name: ${storeFullName}`);

        if (isGitea) {
            // Gitea: use Contents API to fetch file content by path
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;

            return Promise.all(
                files.map(async (f) => {
                    const res = await fetch(
                        `${apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}`,
                        {
                            headers: {
                                Authorization: `token ${accessToken}`,
                            },
                        },
                    );
                    if (!res.ok) {
                        return {
                            path: f.path,
                            sha: f.sha,
                            content: undefined,
                        } as FileWithContent;
                    }
                    const data = await res.json();
                    const content = JSON.parse(decode(data.content));
                    return {
                        path: f.path,
                        sha: data.sha,
                        content,
                    } as FileWithContent;
                }),
            );
        }

        // GitHub: use Git data API (fetch blob by SHA)
        const octokit = await getOctokit();
        return Promise.all(
            files.map(async (f) => {
                const { data: content } = await octokit.request(
                    "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
                    { owner, repo, file_sha: f.sha, ...withRandomT() },
                );
                return {
                    path: f.path,
                    sha: f.sha,
                    content: JSON.parse(decode(content.content)),
                } as FileWithContent;
            }),
        );
    };

    // upload (array of FileWithContent) -> create blobs + tree + commit + update ref
    const uploadContent = async (
        storeFullName: string,
        files: { path: string; content: any }[],
        signal?: AbortSignal,
    ) => {
        const [owner, repo] = storeFullName.split("/");
        if ([owner, repo].some((v) => v.length === 0))
            throw new Error(`invalid store name: ${storeFullName}`);

        if (isGitea) {
            // Gitea: use Contents API (one file per request) — Gitea lacks Git data write endpoints
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;

            const repoRes = await fetch(
                `${apiBase}/repos/${owner}/${repo}`,
                {
                    headers: { Authorization: `token ${accessToken}` },
                    signal,
                },
            );
            const repoInfo = await repoRes.json();
            const branch = repoInfo.default_branch || "main";

            for (const f of files) {
                let existingSha: string | null = null;
                try {
                    const getRes = await fetch(
                        `${apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${branch}`,
                        {
                            headers: { Authorization: `token ${accessToken}` },
                            signal,
                        },
                    );
                    if (getRes.ok) {
                        const data = await getRes.json();
                        existingSha = data.sha ?? null;
                    }
                } catch {
                    // File doesn't exist yet
                }

                if (f.content === null || f.content === undefined) {
                    if (existingSha) {
                        await fetch(
                            `${apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}`,
                            {
                                method: "DELETE",
                                headers: {
                                    Authorization: `token ${accessToken}`,
                                    "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                    message: `[Tidal] Delete ${f.path}`,
                                    sha: existingSha,
                                    branch,
                                }),
                                signal,
                            },
                        );
                    }
                    continue;
                }

                let base64Content: string;
                if (f.content instanceof File || f.content instanceof Blob) {
                    base64Content = await blobToBase64(f.content as Blob);
                } else {
                    const contentStr =
                        typeof f.content === "string"
                            ? f.content
                            : JSON.stringify(f.content, null, 2);
                    base64Content = btoa(
                        new TextEncoder().encode(contentStr).reduce(
                            (data, byte) => data + String.fromCharCode(byte),
                            "",
                        ),
                    );
                }

                const body: any = {
                    message: `[Tidal] Update ${storeFullName}`,
                    content: base64Content,
                    branch,
                };
                if (existingSha) {
                    body.sha = existingSha;
                }

                const method = existingSha ? "PUT" : "POST";
                await fetch(
                    `${apiBase}/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}`,
                    {
                        method,
                        headers: {
                            Authorization: `token ${accessToken}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify(body),
                        signal,
                    },
                );
            }

            // After changes, return fresh structure
            return await fetchStructure(storeFullName);
        }

        // GitHub: use Git data API for atomic batch commit
        const octokit = await getOctokit();

        // create blobs for each file, if content is null -> mark sha null (deletion)
        const treePayload: any[] = await Promise.all(
            files.map(async (f) => {
                if (f.content === null || f.content === undefined) {
                    return {
                        path: f.path,
                        mode: "100644",
                        type: "blob",
                        sha: null,
                    };
                }
                const contentFile = await (async () => {
                    if (f.content instanceof File) {
                        return f.content;
                    }
                    const contentStr =
                        typeof f.content === "string"
                            ? f.content
                            : JSON.stringify(f.content, null, 2);
                    return new File(
                        [new Blob([contentStr])],
                        pathToName(f.path),
                    );
                })();
                const base64Content = await blobToBase64(contentFile);
                const { data: blob } = await octokit.request(
                    "POST /repos/{owner}/{repo}/git/blobs",
                    {
                        owner,
                        repo,
                        content: base64Content,
                        encoding: "base64",
                        request: {
                            signal,
                        },
                    },
                );
                return {
                    path: f.path,
                    mode: "100644",
                    type: "blob",
                    sha: blob.sha,
                };
            }),
        );

        // get base tree
        const { data: repoData } = await octokit.request(
            "GET /repos/{owner}/{repo}",
            {
                owner,
                repo,
                request: {
                    signal,
                },
                ...withRandomT(),
            },
        );
        const { data: refData } = await octokit.request(
            "GET /repos/{owner}/{repo}/git/ref/{ref}",
            {
                owner,
                repo,
                ref: `heads/${repoData.default_branch}`,
                request: {
                    signal,
                },
                ...withRandomT(),
            },
        );
        const { data: commitData } = await octokit.request(
            "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
            {
                owner,
                repo,
                commit_sha: refData.object.sha,
                request: {
                    signal,
                },
                ...withRandomT(),
            },
        );
        const baseTreeSha = commitData.tree.sha;
        const latestCommitSha = refData.object.sha;

        const { data: newTree } = await octokit.request(
            "POST /repos/{owner}/{repo}/git/trees",
            {
                owner,
                repo,
                tree: treePayload,
                base_tree: baseTreeSha,
                request: {
                    signal,
                },
            },
        );

        const { data: newCommit } = await octokit.request(
            "POST /repos/{owner}/{repo}/git/commits",
            {
                owner,
                repo,
                message: `[Tidal] update for ${storeFullName}`,
                tree: newTree.sha,
                parents: [latestCommitSha],
                request: {
                    signal,
                },
            },
        );

        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
            owner,
            repo,
            ref: `heads/${repoData.default_branch}`,
            sha: newCommit.sha,
            request: {
                signal,
            },
        });
        return treeDateToStructure(newTree.tree, config.entryName);
    };

    const transformAsset = (file: File, storeFullName: string) => {
        // produce a raw file URL that points to assets/<name>
        const [owner, repo] = storeFullName.split("/");
        if (isGitea) {
            // Gitea raw URL: https://<server>/<owner>/<repo>/raw/branch/main/assets/...
            const base = serverUrl!.replace(/\/$/, "");
            const key = `${base}/${owner}/${repo}/raw/branch/main/assets/${shortId()}-${file.name}`;
            return key;
        }
        const key = `https://raw.githubusercontent.com/${owner}/${repo}/main/assets/${shortId()}-${file.name}`;
        return key;
    };

    const getAsset = async (fileKey: AssetKey, storeFullName: string) => {
        const { accessToken } = await auth();

        if (isGitea) {
            // Gitea raw URL: https://<server>/<owner>/<repo>/raw/branch/<path>
            // Extract the API path from the raw URL
            const base = serverUrl!.replace(/\/$/, "");
            const rawPrefix = `${base}/`;
            if (!fileKey.startsWith(rawPrefix)) {
                throw new Error("Unsupported asset key for Gitea");
            }
            const afterBase = fileKey.replace(rawPrefix, "");
            const parts = afterBase.split("/");
            const owner = parts[0];
            const repo = parts[1];
            // parts[2]="raw", parts[3]="branch", parts[4]=branch name (e.g. "main")
            const apiPath = parts.slice(5).join("/");
            // Use Gitea API to fetch raw content
            const res = await fetch(
                `${base}/api/v1/repos/${owner}/${repo}/raw/${apiPath}`,
                {
                    headers: {
                        Authorization: `token ${accessToken}`,
                    },
                },
            );
            if (!res.ok) throw new Error(`Failed to fetch asset: ${res.status}`);
            return await res.blob();
        }

        // GitHub: raw.githubusercontent.com URL
        if (!fileKey.startsWith("https://raw.githubusercontent.com")) {
            throw new Error("Unsupported asset key");
        }
        const [owner, repo, ref, ...paths] = fileKey
            .replace("https://raw.githubusercontent.com/", "")
            .replace("HEAD/", "")
            .split("/");
        const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${paths.join("/")}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3.raw",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            },
        );
        const blob = await res.blob();
        return blob;
    };

    const assetEntryToPath = (a: FileEntry<string>) => {
        if (isGitea) {
            // Gitea raw URL: https://<server>/<owner>/<repo>/raw/branch/<path>
            const base = serverUrl!.replace(/\/$/, "");
            const path = a.formattedValue.replace(`${base}/`, "");
            const idx = path.indexOf("/raw/branch/");
            const assetPath =
                idx !== -1 ? path.slice(idx + "/raw/branch/".length) : path;
            // Remove the "main/" prefix from assetPath
            return assetPath.replace(/^main\//, "");
        }
        // GitHub: https://raw.githubusercontent.com/<owner>/<repo>/main/<path>
        const path = a.formattedValue.replace(
            `https://raw.githubusercontent.com/`,
            "",
        );
        const idx = path.indexOf("/main/");
        const assetPath = idx !== -1 ? path.slice(idx + "/main/".length) : path;
        return assetPath;
    };

    // optional createStore implementation (used by createTidal.create)
    const createStore = async (name: string) => {
        const octokit = await getOctokit();

        const { data: me } = await octokit.request("GET /user");
        const owner = me.login;
        const storeName = `${repoPrefix}-${name}`;

        if (isGitea) {
            // Gitea: use fetch directly to avoid Octokit compat issues
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;

            // 1. Create repo (try auto_init)
            const createRes = await fetch(`${apiBase}/user/repos`, {
                method: "POST",
                headers: {
                    Authorization: `token ${accessToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: storeName,
                    private: true,
                    auto_init: true,
                }),
            });
            if (!createRes.ok) {
                throw new Error(
                    `Failed to create repo: ${createRes.status} ${await createRes.text()}`,
                );
            }

            // 2. Wait for repo to be ready, then add meta.json
            let retries = 5;
            while (retries > 0) {
                await new Promise((res) => setTimeout(res, 2000));
                const getRes = await fetch(
                    `${apiBase}/repos/${owner}/${storeName}`,
                    {
                        headers: { Authorization: `token ${accessToken}` },
                    },
                );
                if (!getRes.ok) {
                    retries--;
                    continue;
                }
                const repoInfo = await getRes.json();
                const defaultBranch = repoInfo.default_branch;

                // Repo is ready — push meta.json
                if (defaultBranch) {
                    const putRes = await fetch(
                        `${apiBase}/repos/${owner}/${storeName}/contents/meta.json`,
                        {
                            method: "POST",
                            headers: {
                                Authorization: `token ${accessToken}`,
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                message: "Initial commit by Tidal",
                                content: btoa(JSON.stringify({})),
                                branch: defaultBranch,
                            }),
                        },
                    );
                    if (putRes.ok) {
                        return {
                            id: `${owner}/${storeName}`,
                            name: storeName,
                        };
                    }
                }
                retries--;
            }
            throw new Error(
                `Repo ${storeName} created but could not initialize. Please check Gitea repo settings.`,
            );
        }

        // GitHub: auto_init + contents API
        await octokit.request("POST /user/repos", {
            name: storeName,
            private: true,
            auto_init: true,
        });
        let retries = 3;
        while (retries > 0) {
            try {
                await octokit.request(
                    "PUT /repos/{owner}/{repo}/contents/{path}",
                    {
                        owner,
                        repo: storeName,
                        path: "meta.json",
                        message: "Initial commit by Tidal",
                        content: encode(JSON.stringify({})),
                    },
                );
                break;
            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                await new Promise((res) =>
                    setTimeout(res, 1000 * (2 - retries)),
                );
            }
        }
        return { id: `${owner}/${storeName}`, name: storeName };
    };

    const getUserInfo = async (id?: string) => {
        if (isGitea) {
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;
            // Gitea: GET /user for self, GET /users/{username} for specific user
            const path = id ? `/users/${id}` : "/user";
            const res = await fetch(`${apiBase}${path}`, {
                headers: { Authorization: `token ${accessToken}` },
            });
            if (!res.ok) {
                return {
                    avatar_url: undefined,
                    name: id || "unknown-user",
                    id: id || "",
                } as UserInfo;
            }
            const data = await res.json();
            return {
                avatar_url: data.avatar_url,
                name: data.login,
                id: String(data.id),
            } as UserInfo;
        }

        // GitHub
        const octokit = await getOctokit();
        if (id) {
            const { data } = await octokit.request("GET /user/{account_id}", {
                account_id: id as unknown as number,
            });
            return {
                avatar_url: data.avatar_url,
                name: data.login,
                id: data.id as unknown as string,
            };
        }
        const { data } = await octokit.request("GET /user");
        return {
            avatar_url: data.avatar_url,
            name: data.login,
            id: data.id as unknown as string,
        };
    };
    const getCollaborators = async (id: string) => {
        if (isGitea) {
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;
            const [owner, repo] = id.split("/");

            // Gitea collaborators API doesn't return the repo owner.
            // Always include both current user AND repo owner so both sides see each other.
            const me = await getUserInfo();
            const seen = new Set([me.id]);
            const list: UserInfo[] = [me];

            // Also fetch repo owner info (needed when a collaborator views owner's bills)
            if (owner !== me.name) {
                try {
                    const ownerInfo = await getUserInfo(owner);
                    if (!seen.has(ownerInfo.id)) {
                        seen.add(ownerInfo.id);
                        list.push(ownerInfo);
                    }
                } catch {
                    // ignore
                }
            }

            try {
                const res = await fetch(
                    `${apiBase}/repos/${owner}/${repo}/collaborators`,
                    {
                        headers: { Authorization: `token ${accessToken}` },
                    },
                );
                if (res.ok) {
                    const data = await res.json();
                    for (const v of Array.isArray(data) ? data : []) {
                        const uid = String(v.id);
                        if (!seen.has(uid)) {
                            seen.add(uid);
                            list.push({
                                avatar_url: v.avatar_url,
                                name: v.login,
                                id: uid,
                            });
                        }
                    }
                }
            } catch {
                // ignore
            }
            return list as UserInfo[];
        }

        // GitHub
        const octokit = await getOctokit();
        const [owner, repo] = id.split("/");
        const { data } = await octokit.request(
            "GET /repos/{owner}/{repo}/collaborators",
            { owner, repo },
        );
        return data.map((v) => ({
            avatar_url: v.avatar_url,
            name: v.login,
            id: v.id as unknown as string,
        })) as UserInfo[];
    };

    const fetchAllStore = async () => {
        if (isGitea) {
            const { accessToken } = await auth();
            const base = serverUrl!.replace(/\/$/, "");
            const apiBase = `${base}/api/v1`;

            // Gitea: manually paginate /user/repos
            const allRepos: any[] = [];
            let page = 1;
            while (true) {
                const res = await fetch(
                    `${apiBase}/user/repos?page=${page}&limit=50`,
                    {
                        headers: { Authorization: `token ${accessToken}` },
                    },
                );
                if (!res.ok) break;
                const repos = await res.json();
                if (!Array.isArray(repos) || repos.length === 0) break;
                allRepos.push(...repos);
                page++;
            }
            return allRepos
                .filter((repo: any) =>
                    repo.name?.startsWith(config.repoPrefix),
                )
                .map((repo: any) => repo.full_name);
        }

        // GitHub: use Octokit pagination
        const paginatePlugin = loadOctokitPaginate();
        const octokit = await getOctokit();
        const repos = await (await paginatePlugin)(octokit).paginate(
            "GET /user/repos",
            {
                type: "all",
                ...withRandomT(),
            },
        );
        return repos
            .filter((repo) => repo.name.startsWith(config.repoPrefix))
            .map((repo) => repo.full_name);
    };

    return {
        fetchAllStore,
        fetchStructure,
        fetchContent,
        uploadContent,

        transformAsset,
        getAsset,
        assetEntryToPath,

        createStore,
        getUserInfo,
        getCollaborators,
    };
};
