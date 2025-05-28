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

// 辅助函数：创建错误响应 (如果尚未在外部定义)
function createErrorResponse(message, status) {
    return new Response(JSON.stringify({ success: false, error: message }), {
        status: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
}

// 辅助函数：创建成功响应 (如果尚未在外部定义)
function createSuccessResponse(data, status = 200) {
    return new Response(JSON.stringify({ success: true, ...data }), {
        status: status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
}

// 辅助函数：ArrayBuffer to Base64 (保持不变)
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
// GitHub API 基础 URL
const GITHUB_API_BASE = 'https://api.github.com';

export default {
    async fetch(request, env, ctx) {
        // CORS Preflight (保持不变)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*', 
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, X-User-Identifier', 
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        if (request.method !== 'POST') {
            return createErrorResponse('Only POST requests are allowed', 405);
        }

        const GITHUB_PAT = env.GITHUB_PAT;
        const GITHUB_REPO_OWNER = env.GITHUB_REPO_OWNER;
        const GITHUB_REPO_NAME = env.GITHUB_REPO_NAME;
        const GITHUB_MAIN_BRANCH = env.GITHUB_MAIN_BRANCH || 'main';
        const COMMIT_AUTHOR_NAME = env.COMMIT_AUTHOR_NAME || 'FileUploaderWorker';
        const COMMIT_AUTHOR_EMAIL = env.COMMIT_AUTHOR_EMAIL || 'worker@noreply.localhost';
        const CDN_BASE_URL = env.CDN_BASE_URL || `https://cdn.jsdelivr.net/gh`; // jsDelivr 等

        if (!GITHUB_PAT || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
            console.error("[UPLOADER] Missing critical GitHub configuration in environment variables.");
            return createErrorResponse('Server configuration error: GitHub credentials missing', 500);
        }

        const headers = {
            'Authorization': `token ${GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Cloudflare-Worker-File-Uploader', // 修改 User-Agent
        };

        try {
            const contentType = request.headers.get('content-type');
            if (!contentType || !contentType.includes('multipart/form-data')) {
                return createErrorResponse('Content-Type must be multipart/form-data', 415);
            }

            const formData = await request.formData();
            const file = formData.get('file'); // 将字段名从 'image' 改为更通用的 'file'
            let userIdentifier = request.headers.get('X-User-Identifier') || formData.get('userIdentifier') || env.DEFAULT_USER_IDENTIFIER || 'shared';
            
            userIdentifier = userIdentifier.toString().toLowerCase().replace(/[^a-z0-9_-]/g, '-').substring(0, 50);
            if (!userIdentifier) userIdentifier = 'unknown-user';

            if (!file || !(file instanceof File)) {
                return createErrorResponse('No file found in form data (expected field name "file") or invalid file type', 400);
            }

            const currentMaxFileSize = (env.MAX_FILE_SIZE_MB || MAX_FILE_SIZE_MB_CONFIG) * 1024 * 1024;
            if (file.size > currentMaxFileSize) {
                return createErrorResponse(`File size (${(file.size / 1024 / 1024).toFixed(2)}MB) exceeds ${currentMaxFileSize / 1024 / 1024}MB limit`, 413);
            }

            // 不再检查 MIME 类型
            // if (!ALLOWED_MIME_TYPES.includes(file.type)) {
            //     return createErrorResponse(`Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`, 415);
            // }

            // 文件名处理：保留原始扩展名，对文件名进行清理
            const originalFileName = file.name || 'untitled';
            const cleanedBaseName = originalFileName.substring(0, originalFileName.lastIndexOf('.')).replace(/[^a-zA-Z0-9._-]/g, '_');
            const extension = originalFileName.substring(originalFileName.lastIndexOf('.')); // 包括点号，例如 ".png"
            const uniqueFileNameInRepo = `${Date.now()}-${cleanedBaseName}${extension}`; 
            
            const branchName = `files/${userIdentifier}`; // 例如: files/testuser123 (分支名使用 'files' 前缀)
            const filePathInRepo = uniqueFileNameInRepo; // 文件直接存储在分支的根目录下

            console.log(`[UPLOADER] Preparing to upload: ${filePathInRepo} to branch: ${branchName}`);

            const fileBuffer = await file.arrayBuffer();
            const base64Content = arrayBufferToBase64(fileBuffer); 

            let mainBranchSha = null;
            console.log(`[UPLOADER] Fetching ref for main branch: heads/${GITHUB_MAIN_BRANCH}`);
            try {
                 const getMainBranchRef = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/git/ref/heads/${GITHUB_MAIN_BRANCH}`, { headers });
                 console.log(`[UPLOADER] Get main branch ref status: ${getMainBranchRef.status}`);
                 if (getMainBranchRef.ok) {
                    const mainBranchData = await getMainBranchRef.json();
                    mainBranchSha = mainBranchData.object.sha;
                    console.log(`[UPLOADER] Successfully fetched main branch SHA: ${mainBranchSha}`);
                 } else {
                    const errorText = await getMainBranchRef.text();
                    console.warn(`[UPLOADER] Failed to get main branch ref. Status: ${getMainBranchRef.status}. Response: ${errorText}`);
                 }
            } catch (e) {
                console.error("[UPLOADER] Exception while fetching main branch ref:", e.message);
            }

            const commitMessage = `Upload file: ${filePathInRepo} by user ${userIdentifier}`;
            // GitHub API 的路径中文件名需要 URL 编码
            const contentApiUrl = `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${encodeURIComponent(filePathInRepo)}`;
            
            const payload = {
                message: commitMessage,
                content: base64Content,
                branch: branchName, 
                committer: { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL },
                author: { name: COMMIT_AUTHOR_NAME, email: COMMIT_AUTHOR_EMAIL },
            };

            console.log(`[UPLOADER] Attempting to upload to: ${contentApiUrl} (branch: ${branchName})`);
            let uploadResponse = await fetch(contentApiUrl, {
                method: 'PUT',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!uploadResponse.ok) {
                const errorData = await uploadResponse.json().catch(() => ({ message: `Upload failed with status: ${uploadResponse.status} ${uploadResponse.statusText}` }));
                console.error(`[UPLOADER] GitHub API Error (initial upload attempt): ${uploadResponse.status}`, JSON.stringify(errorData));

                if (errorData.message && errorData.message.toLowerCase().includes("branch") && errorData.message.toLowerCase().includes("not found")) { // 更通用的分支未找到判断
                    if (mainBranchSha) {
                        console.log(`[UPLOADER] Branch ${branchName} not found. Attempting to create it from ${GITHUB_MAIN_BRANCH} (SHA: ${mainBranchSha}).`);
                        const createBranchPayload = { ref: `refs/heads/${branchName}`, sha: mainBranchSha };
                        const createBranchResponse = await fetch(`${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/git/refs`, {
                            method: 'POST',
                            headers: { ...headers, 'Content-Type': 'application/json' },
                            body: JSON.stringify(createBranchPayload),
                        });

                        if (createBranchResponse.ok) {
                            console.log(`[UPLOADER] Branch ${branchName} created successfully. Retrying upload...`);
                            uploadResponse = await fetch(contentApiUrl, {
                                method: 'PUT',
                                headers: { ...headers, 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload), 
                            });
                            if (!uploadResponse.ok) {
                                 const retryErrorData = await uploadResponse.json().catch(() => ({ message: `Retry upload failed with status: ${uploadResponse.status} ${uploadResponse.statusText}` }));
                                 console.error(`[UPLOADER] GitHub API Error (retry upload): ${uploadResponse.status}`, JSON.stringify(retryErrorData));
                                 throw new Error(`Failed to upload file after creating branch: ${retryErrorData.message}`);
                            }
                            console.log("[UPLOADER] File uploaded successfully after branch creation.");
                        } else {
                            const branchErrorData = await createBranchResponse.json().catch(() => ({ message: `Create branch failed with status: ${createBranchResponse.status} ${createBranchResponse.statusText}` }));
                            console.error(`[UPLOADER] GitHub API Error (create branch): ${createBranchResponse.status}`, JSON.stringify(branchErrorData));
                            throw new Error(`Failed to create branch (${branchName}): ${branchErrorData.message}`);
                        }
                    } else {
                        console.warn(`[UPLOADER] Branch ${branchName} not found, and mainBranchSha was not available to create it.`);
                        throw new Error(`Failed to upload file: Branch ${branchName} not found and could not be created (missing main branch SHA).`);
                    }
                } else {
                    throw new Error(`Failed to upload file: ${errorData.message || `Status ${uploadResponse.status}`}`);
                }
            }

            const uploadData = await uploadResponse.json();
            // CDN URL 构建: cdn.jsdelivr.net/gh/owner/repo@branch/file_in_branch_root
            const cdnUrl = `${CDN_BASE_URL}/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}@${branchName}/${encodeURIComponent(filePathInRepo)}`;

            console.log(`[UPLOADER] File successfully uploaded. CDN URL: ${cdnUrl}`);
            return createSuccessResponse({
                message: 'File uploaded successfully!',
                url: cdnUrl,
                github_url: uploadData.content.html_url,
                path_in_repo: filePathInRepo,
                branch: branchName,
                file_type: file.type, // 返回原始文件类型
                file_size: file.size, // 返回原始文件大小
            });

        } catch (error) {
            console.error('[UPLOADER] Critical error in worker fetch handler:', error.message, error.stack);
            return createErrorResponse(error.message || 'An unexpected error occurred during file upload', 500);
        }
    },
};


