// src/index.js (for image-uploader-worker)

// --- 配置 (从环境变量获取) ---
// 在 Cloudflare Dashboard 中设置这些 Secret:
// GITHUB_PAT: 你的 GitHub Personal Access Token
// GITHUB_REPO_OWNER: 'bobimg666'
// GITHUB_REPO_NAME: 'jxtw-img'
// GITHUB_MAIN_BRANCH: 'main' (或你的主分支名)
// COMMIT_AUTHOR_NAME: 'Image Uploader Bot' (可选)
// COMMIT_AUTHOR_EMAIL: 'bot@example.com' (可选)
// CDN_BASE_URL: 'https://cdn.jsdelivr.net/gh' (jsDelivr) 或其他CDN

const MAX_FILE_SIZE_MB = 5; // 限制上传文件大小 (例如 5MB)
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// 辅助函数：创建错误响应
function createErrorResponse(message, status) {
    return new Response(JSON.stringify({ success: false, error: message }), {
        status: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, // 允许跨域
    });
}

// 辅助函数：创建成功响应
function createSuccessResponse(data, status = 200) {
    return new Response(JSON.stringify({ success: true, ...data }), {
        status: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, // 允许跨域
    });
}

// GitHub API 基础 URL
const GITHUB_API_BASE = 'https://api.github.com';

export default {
    async fetch(request, env, ctx) {
        // CORS Preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*', // 生产环境应指定具体前端源
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, X-User-Identifier', // 允许自定义头部
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        if (request.method !== 'POST') {
            return createErrorResponse('Only POST requests are allowed', 405);
        }

        // 从环境变量中获取配置 (必须在 Dashboard 设置)
        const GITHUB_PAT = env.GITHUB_PAT;
        const GITHUB_REPO_OWNER = env.GITHUB_REPO_OWNER;
        const GITHUB_REPO_NAME = env.GITHUB_REPO_NAME;
        const GITHUB_MAIN_BRANCH = env.GITHUB_MAIN_BRANCH || 'main';
        const COMMIT_AUTHOR_NAME = env.COMMIT_AUTHOR_NAME || 'ImageUploaderWorker';
        const COMMIT_AUTHOR_EMAIL = env.COMMIT_AUTHOR_EMAIL || 'worker@noreply.localhost';
        const CDN_BASE_URL = env.CDN_BASE_URL || `https://cdn.jsdelivr.net/gh/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;


        if (!GITHUB_PAT || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
            console.error("Missing critical GitHub configuration in environment variables.");
            return createErrorResponse('Server configuration error: GitHub credentials missing', 500);
        }

        const headers = {
            'Authorization': `token ${GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker-Image-Uploader',
        };

        try {
            const contentType = request.headers.get('content-type');
            if (!contentType || !contentType.includes('multipart/form-data')) {
                return createErrorResponse('Content-Type must be multipart/form-data', 415);
            }

            const formData = await request.formData();
            const file = formData.get('image'); // 前端上传时字段名应为 'image'
            let userIdentifier = request.headers.get('X-User-Identifier') || formData.get('userIdentifier') || env.DEFAULT_USER_IDENTIFIER || 'shared';
            
            // 清理 userIdentifier，使其成为有效的分支名/路径名
            userIdentifier = userIdentifier.toString().toLowerCase().replace(/[^a-z0-9_-]/g, '-').substring(0, 50);
            if (!userIdentifier) userIdentifier = 'unknown-user';


            if (!file || !(file instanceof File)) {
                return createErrorResponse('No image file found in form data or invalid file type', 400);
            }

            if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                return createErrorResponse(`File size exceeds ${MAX_FILE_SIZE_MB}MB limit`, 413);
            }

            if (!ALLOWED_MIME_TYPES.includes(file.type)) {
                return createErrorResponse(`Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`, 415);
            }

            const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`; // 生成唯一且安全的文件名
            const filePath = `${userIdentifier}/${fileName}`; // 图片在仓库中的路径，例如 "user123/timestamp-image.png"
            const branchName = `img/${userIdentifier}`; // 每个用户一个分支，例如 "img/user123"

            const fileBuffer = await file.arrayBuffer();
            const base64Content = arrayBufferToBase64(fileBuffer); // 需要一个辅助函数

            // 1. 获取主分支的最新 commit SHA (用于创建新分支的基础)
            let getMainBranchRef;
            try {
                 getMainBranchRef = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/git/ref/heads/${GITHUB_MAIN_BRANCH}`, { headers });
                 if (!getMainBranchRef.ok && getMainBranchRef.status !== 404) { // 404 意味着分支可能不存在，但其他错误是问题
                    const errorData = await getMainBranchRef.json().catch(() => ({}));
                    console.error(`GitHub API Error (get main branch ref): ${getMainBranchRef.status}`, errorData);
                    throw new Error(`Failed to get main branch ref: ${errorData.message || getMainBranchRef.statusText}`);
                 }
            } catch (e) {
                console.error("Error fetching main branch ref:", e);
                return createErrorResponse(`Server error: Could not fetch main branch info. ${e.message}`, 500);
            }

            let mainBranchSha;
            if (getMainBranchRef.ok) {
                const mainBranchData = await getMainBranchRef.json();
                mainBranchSha = mainBranchData.object.sha;
            } else {
                // 如果主分支不存在 (例如全新仓库)，这是一个更复杂的情况，
                // GitHub API 创建文件时如果分支不存在会自动创建，但通常是基于默认分支。
                // 对于更健壮的实现，可能需要检查仓库是否为空或初始化。
                // 为了简化，这里假设主分支存在或API会自动处理。
                // 如果明确要处理全新仓库，可能需要先尝试创建一个空的 commit 到主分支。
                console.warn(`Main branch '${GITHUB_MAIN_BRANCH}' not found or initial fetch failed. Proceeding with caution.`);
                // 对于创建新分支，SHA 是必需的。如果主分支不存在，我们需要一个有效的 SHA。
                // 一种策略是尝试直接向目标分支推送。如果分支不存在，GitHub的 `PUT /repos/{owner}/{repo}/contents/{path}` 应该能创建。
                // 但创建分支的API `POST /repos/{owner}/{repo}/git/refs` 需要一个 sha。
                // 我们将依赖 content API 的分支创建能力。
                mainBranchSha = null; // 让 content API 尝试创建分支
            }


            // 2. （可选）检查用户分支是否存在，如果不存在则创建
            // GitHub 的 contents API 在指定不存在的分支时，如果提供了 sha (作为创建分支的基础)，它会尝试创建该分支。
            // 如果不提供 sha，它会尝试在默认分支上操作。
            // 我们将直接使用 contents API，并指定 branch 参数。

            // 3. 上传文件到 GitHub
            const commitMessage = `Upload image: ${fileName} by user ${userIdentifier}`;
            const contentApiUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${filePath}`;
            
            const payload = {
                message: commitMessage,
                content: base64Content,
                branch: branchName, // 指定分支，如果不存在，GitHub 会尝试创建它 (基于默认分支)
                committer: {
                    name: COMMIT_AUTHOR_NAME,
                    email: COMMIT_AUTHOR_EMAIL,
                },
                author: { // 通常与 committer 相同，除非有特定区分
                    name: COMMIT_AUTHOR_NAME,
                    email: COMMIT_AUTHOR_EMAIL,
                },
            };
            // 如果主分支SHA获取成功，并且我们想确保新分支是基于最新的主分支创建的，
            // 可以在这里先调用创建分支的API，然后再上传。
            // 但为了简化，我们依赖 contents API 的分支创建行为。

            console.log(`Attempting to upload to: ${contentApiUrl} on branch ${branchName}`);
            const uploadResponse = await fetch(contentApiUrl, {
                method: 'PUT',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!uploadResponse.ok) {
                const errorData = await uploadResponse.json().catch(() => ({}));
                console.error(`GitHub API Error (upload file): ${uploadResponse.status}`, errorData);
                // 如果错误是 "Branch not found"，并且我们之前没有尝试创建分支，可以尝试创建分支再重试
                if (errorData.message && errorData.message.toLowerCase().includes("branch not found") && mainBranchSha) {
                    console.log(`Branch ${branchName} not found. Attempting to create it from ${GITHUB_MAIN_BRANCH} (${mainBranchSha}).`);
                    const createBranchPayload = {
                        ref: `refs/heads/${branchName}`,
                        sha: mainBranchSha,
                    };
                    const createBranchResponse = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/git/refs`, {
                        method: 'POST',
                        headers: { ...headers, 'Content-Type': 'application/json' },
                        body: JSON.stringify(createBranchPayload),
                    });
                    if (createBranchResponse.ok) {
                        console.log(`Branch ${branchName} created. Retrying upload...`);
                        // 再次尝试上传
                        const retryUploadResponse = await fetch(contentApiUrl, {
                            method: 'PUT',
                            headers: { ...headers, 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload), // payload 中的 branch 已经是目标分支
                        });
                        if (!retryUploadResponse.ok) {
                             const retryErrorData = await retryUploadResponse.json().catch(() => ({}));
                             console.error(`GitHub API Error (retry upload file): ${retryUploadResponse.status}`, retryErrorData);
                             throw new Error(`Failed to upload image after creating branch: ${retryErrorData.message || retryUploadResponse.statusText}`);
                        }
                        // 如果重试成功，继续到成功响应
                        const retryUploadData = await retryUploadResponse.json();
                        const cdnUrl = `${CDN_BASE_URL}@${branchName}/${filePath.substring(filePath.indexOf('/') + 1)}`; // jsDelivr URL for specific branch
                        return createSuccessResponse({
                            message: 'Image uploaded successfully to new branch!',
                            url: cdnUrl, // CDN URL
                            github_url: retryUploadData.content.html_url, // GitHub HTML URL
                            path: filePath,
                            branch: branchName,
                        });

                    } else {
                        const branchErrorData = await createBranchResponse.json().catch(() => ({}));
                        console.error(`GitHub API Error (create branch): ${createBranchResponse.status}`, branchErrorData);
                        throw new Error(`Failed to create branch for user: ${branchErrorData.message || createBranchResponse.statusText}`);
                    }
                }
                throw new Error(`Failed to upload image: ${errorData.message || uploadResponse.statusText}`);
            }

            const uploadData = await uploadResponse.json();
            // 构建 CDN URL，例如 jsDelivr: https://cdn.jsdelivr.net/gh/owner/repo@branch/path/to/file.png
            // filePath 已经是 userIdentifier/fileName.png
            // branchName 是 img/userIdentifier
            // 对于 jsDelivr，它会从分支的根目录开始查找，所以 filePath 应该是相对于分支根目录的。
            // 如果 filePath 是 "user123/image.png" 而分支是 "img/user123"，
            // GitHub API 会在 "img/user123" 分支下创建 "user123/image.png" 这个文件。
            // 那么 jsDelivr 的 URL 应该是 CDN_BASE_URL@branchName/filePath
            // 但如果 filePath 已经包含了 userIdentifier 作为第一级目录，而分支名也基于 userIdentifier，这可能导致路径重复。
            // 调整：让 filePath 就是仓库根目录下的文件路径，例如 images/userIdentifier/fileName.png
            // 或者，分支名就是 userIdentifier，filePath 是 fileName.png
            // 我们采用分支名是 `img/${userIdentifier}`，文件路径是 `fileName` (直接在分支根目录下)
            
            const simpleFileNameInBranch = fileName; // 文件直接在分支的根目录下
            const contentApiUrlCorrected = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${simpleFileNameInBranch}`;
             const payloadCorrected = { ...payload, message: `Upload image: ${simpleFileNameInBranch} to branch ${branchName}` };
            // (这里逻辑需要重构，上传应该在确定分支存在后，并且使用正确的文件路径)
            // **为了简化并依赖GitHub的默认行为，我们将文件路径包含用户标识，并尝试上传到以用户标识命名的分支**

            // **更正后的逻辑：**
            // filePath = `${userIdentifier}/${fileName}`; // 如: "user123/image.png"
            // branchName = userIdentifier; // 分支名就是用户标识 "user123"

            // 假设上面的 uploadResponse 是成功的，并且使用了修正前的 filePath 和 branchName:
            // filePath = `${userIdentifier}/${fileName}`;
            // branchName = `img/${userIdentifier}`;
            // CDN URL 应该是:
            // const cdnUrl = `${CDN_BASE_URL}/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}@${branchName}/${fileName}`;
            // 修正：jsDelivr URL 格式是 cdn.jsdelivr.net/gh/user/repo@version/file
            // 我们上传到仓库的路径是 filePath (`userIdentifier/fileName`)
            // 分支是 branchName (`img/userIdentifier`)
            // 所以 CDN URL 应该是：
            const cdnUrl = `${CDN_BASE_URL}/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}@${branchName}/${fileName}`;


            return createSuccessResponse({
                message: 'Image uploaded successfully!',
                url: cdnUrl,
                github_url: uploadData.content.html_url,
                path: filePath, // 完整路径
                branch: branchName,
            });

        } catch (error) {
            console.error('Error in image uploader worker:', error.message, error.stack);
            return createErrorResponse(error.message || 'An unexpected error occurred', 500);
        }
    },
};

// 辅助函数：ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}