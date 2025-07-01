import http from 'http';
import https from 'https';
import { URL } from 'url';

export const handleHttpProxy = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<boolean> => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  let targetUrl = url.searchParams.get('target');
  
  if (!targetUrl) {
    return false; // 不是代理请求，让其他处理器处理
  }

  // 去除可能存在的引号
  targetUrl = targetUrl.replace(/^["']|["']$/g, '');

  try {
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';
    const httpModule = isHttps ? https : http;
    
    // 设置CORS头
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', '*');
    }

    // 处理OPTIONS预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // 复制并清理请求头
    const cleanHeaders: http.OutgoingHttpHeaders = {};
    Object.entries(req.headers).forEach(([key, value]) => {
      // 跳过可能导致问题的头
      if (!['host', 'origin', 'referer'].includes(key.toLowerCase())) {
        cleanHeaders[key] = value;
      }
    });

    // 准备代理请求的选项
    const proxyOptions: http.RequestOptions = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: {
        ...cleanHeaders,
        host: target.host, // 设置正确的host头
      },
    };

    console.log(`[http-proxy] Proxying ${req.method} ${req.url} -> ${targetUrl}`);

    // 创建代理请求
    const proxyReq = httpModule.request(proxyOptions, (proxyRes) => {
      // 复制响应头
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        if (key.toLowerCase() !== 'transfer-encoding') {
          res.setHeader(key, value!);
        }
      });

      // 设置状态码
      res.writeHead(proxyRes.statusCode || 200);

      // 流式转发响应数据
      proxyRes.pipe(res);
    });

    // 错误处理
    proxyReq.on('error', (error) => {
      console.error(`[http-proxy] Error proxying request to ${targetUrl}:`, error);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Bad Gateway',
          message: `Failed to proxy request to ${targetUrl}`,
          details: error.message
        }));
      }
    });

    // 处理请求超时
    proxyReq.setTimeout(30000, () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Gateway Timeout',
          message: `Request to ${targetUrl} timed out`
        }));
      }
    });

    // 转发请求体（对于POST、PUT等请求）
    req.pipe(proxyReq);

    // 处理客户端断开连接
    req.on('close', () => {
      proxyReq.destroy();
    });

    return true;
  } catch (error) {
    console.error(`[http-proxy] Invalid target URL ${targetUrl}:`, error);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Bad Request',
      message: 'Invalid target URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    }));
    return true;
  }
};