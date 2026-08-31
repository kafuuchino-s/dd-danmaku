// Cloudflare Worker Variables are injected as globals in Service Worker syntax.
/* global APP_ID, APP_SECRET, SENPLAYER_PATH */

// @ts-ignore Cloudflare Worker Variable binding
const appId = APP_ID;
// @ts-ignore Cloudflare Worker Variable binding
const appSecret = APP_SECRET;

const defaultTargetOrigin = 'https://api.dandanplay.net';
const corsPrefix = '/cors/';
// @ts-ignore Cloudflare Worker Variable binding
const configuredSenPlayerPath = typeof SENPLAYER_PATH === 'string' ? SENPLAYER_PATH.trim() : '';
const normalizedSenPlayerPath = configuredSenPlayerPath.replace(/^\/+|\/+$/g, '');
const senPlayerPrefix = normalizedSenPlayerPath ? `/${normalizedSenPlayerPath}` : null;
const hostlist = { 'api.dandanplay.net': null };

function isAllowedRequestPath(pathname) {
    return pathname.startsWith(corsPrefix) || Boolean(senPlayerPrefix && (pathname === senPlayerPrefix || pathname.startsWith(`${senPlayerPrefix}/`)));
}

function normalizeApiPath(path) {
    let normalizedPath = path || '/';
    normalizedPath = normalizedPath.replace(/\/{2,}/g, '/');

    // Accept both the full DandanPlay path and the short paths used by SenPlayer.
    while (normalizedPath === '/api/v2/api/v2' || normalizedPath.startsWith('/api/v2/api/v2/')) {
        normalizedPath = normalizedPath.substring('/api/v2'.length);
    }

    if (normalizedPath === '/api/v2' || normalizedPath.startsWith('/api/v2/')) {
        return normalizedPath;
    }

    if (normalizedPath === '/v2' || normalizedPath.startsWith('/v2/')) {
        return '/api' + normalizedPath;
    }

    if (normalizedPath === '/api' || normalizedPath.startsWith('/api/')) {
        return '/api/v2' + normalizedPath.substring('/api'.length);
    }

    const shortApiPathPattern = /^\/(?:search\/(?:anime|episodes)|match(?:\/batch)?|bangumi(?:\/|$)|comment(?:\/|$)|extcomment(?:\/|$)|related(?:\/|$)|segmentcomment(?:\/|$))/;
    if (shortApiPathPattern.test(normalizedPath)) {
        return '/api/v2' + normalizedPath;
    }

    return normalizedPath;
}

function shouldUseFilenameMatch(body, apiPath) {
    if (apiPath !== '/api/v2/match' || !body || typeof body.fileName !== 'string' || !body.fileName.trim()) {
        return false;
    }

    const hasValidHash = typeof body.fileHash === 'string' && /^[a-f0-9]{32}$/i.test(body.fileHash);
    const fileSize = Number(body.fileSize);
    return !hasValidHash || !Number.isFinite(fileSize) || fileSize <= 0;
}

async function prepareRequestBody(request, apiPath) {
    if (request.method !== 'POST' || apiPath !== '/api/v2/match' || !request.body) {
        return request.body;
    }

    try {
        const bodyText = await request.clone().text();
        const body = JSON.parse(bodyText);
        if (!shouldUseFilenameMatch(body, apiPath)) {
            return request.body;
        }

        // Official match validates hash and size even when only the filename is useful.
        // Supply valid placeholders and explicitly select filename matching for remote files.
        body.fileHash = '00000000000000000000000000000000';
        body.fileSize = 1;
        body.matchMode = 'fileNameOnly';
        return JSON.stringify(body);
    } catch (error) {
        return request.body;
    }
}

function resolveTargetUrl(requestUrl) {
    const requestUrlObj = new URL(requestUrl);
    let targetUrl;

    if (requestUrlObj.pathname.startsWith(corsPrefix)) {
        let target = `${requestUrlObj.pathname.substring(corsPrefix.length)}${requestUrlObj.search}`.trim();
        if (target.startsWith('https:/') && !target.startsWith('https://')) {
            target = target.replace('https:/', 'https://');
        } else if (target.startsWith('http:/') && !target.startsWith('http://')) {
            target = target.replace('http:/', 'http://');
        }
        targetUrl = new URL(target);
    } else if (senPlayerPrefix && (requestUrlObj.pathname === senPlayerPrefix || requestUrlObj.pathname.startsWith(`${senPlayerPrefix}/`))) {
        // Keep SenPlayer on a dedicated public path instead of exposing the API at the root.
        const apiPath = requestUrlObj.pathname.substring(senPlayerPrefix.length) || '/';
        targetUrl = new URL(`${defaultTargetOrigin}${apiPath}${requestUrlObj.search}`);
    } else {
        throw new Error('Unsupported public path');
    }

    targetUrl.pathname = normalizeApiPath(targetUrl.pathname);
    if (targetUrl.pathname === '/api/v2/comment' && targetUrl.searchParams.has('url')) {
        // Some SenPlayer-compatible servers expose URL comments under /comment.
        // DandanPlay names the equivalent official endpoint /extcomment.
        targetUrl.pathname = '/api/v2/extcomment';
    }
    return targetUrl;
}

function withCorsHeaders(response) {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, User-Agent, Accept');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function notFoundResponse() {
    return withCorsHeaders(new Response(JSON.stringify({ errorCode: 404, success: false, errorMessage: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
}

async function handleRequest(request) {
    const requestPathname = new URL(request.url).pathname;
    if (!isAllowedRequestPath(requestPathname)) {
        return notFoundResponse();
    }

    if (request.method === 'OPTIONS') {
        return withCorsHeaders(new Response(null, { status: 204 }));
    }

    let targetUrl;
    try {
        targetUrl = resolveTargetUrl(request.url);
    } catch (error) {
        return withCorsHeaders(new Response(JSON.stringify({ errorCode: 400, success: false, errorMessage: 'Invalid proxy URL' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }));
    }

    if (targetUrl.protocol !== 'https:' || !(targetUrl.hostname in hostlist)) {
        return Forbidden(targetUrl);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const apiPath = targetUrl.pathname;
    const signature = await generateSignature(appId, timestamp, apiPath, appSecret);
    console.log('X-AppId: ' + appId);
    console.log('X-Signature: ' + signature);
    console.log('X-Timestamp: ' + timestamp);
    console.log('ApiPath: ' + apiPath);

    // Preserve SenPlayer's request headers while replacing the upstream auth headers.
    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
        if (key !== 'host' && key !== 'content-length') {
            headers.set(key, value);
        }
    }
    headers.set('X-AppId', appId);
    headers.set('X-Signature', signature);
    headers.set('X-Timestamp', timestamp.toString());
    headers.set('X-Auth', '1');

    const requestInit = {
        headers,
        method: request.method,
        redirect: 'follow',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        requestInit.body = await prepareRequestBody(request, apiPath);
    }

    const response = await fetch(targetUrl.href, requestInit);
    return withCorsHeaders(response);
}

/**
 *
 * @param {String} appId
 * @param {Number} timestamp 使用当前的 UTC 时间生成 Unix 时间戳，单位为秒
 * @param {String} path 此处的 API 路径是指 API 地址后的路径部分，以/开头，不包括前面的协议、域名和?后面的查询参数
 * @param {String} appSecret
 * @returns signature String
 */
async function generateSignature(appId, timestamp, path, appSecret) {
    const data = appId + timestamp + path + appSecret;
    const dataUint8 = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(hashArray.map((byte) => String.fromCharCode(byte)).join(''));
    return hashBase64;
}

function Forbidden(url) {
    return new Response(`Hostname ${url.hostname} not allowed.`, {
        status: 403,
    });
}

addEventListener('fetch', (event) => {
    return event.respondWith(handleRequest(event.request));
});
