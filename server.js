/**
 * PIX Proxy Server
 * Intermediário entre Make.com e Inter API
 * Make chama este endpoint (sem mTLS), ele faz mTLS com Inter
 *
 * Deploy: Render.com (free tier)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Certificados Inter (carregados como variáveis de ambiente no Render)
// Em produção: usa base64 das env vars. Local: lê arquivo direto
const CERT = process.env.INTER_CERT_B64
  ? Buffer.from(process.env.INTER_CERT_B64, 'base64').toString('utf8')
  : fs.readFileSync('C:/certificados-inter/extraido/Inter API_Certificado.crt', 'utf8');
const KEY = process.env.INTER_KEY_B64
  ? Buffer.from(process.env.INTER_KEY_B64, 'base64').toString('utf8')
  : fs.readFileSync('C:/certificados-inter/extraido/Inter_RSA_Traditional.key', 'utf8');
const CLIENT_ID     = process.env.INTER_CLIENT_ID     || '97508004-c0d9-4bf3-b923-f0b851c9268c';
const CLIENT_SECRET = process.env.INTER_CLIENT_SECRET || '3f0ce3bf-51a2-49f9-94c4-c49efc814039';
const API_SECRET    = process.env.API_SECRET           || 'pix-sudario-2026'; // chave pra autenticar chamadas do Make

const PORT = process.env.PORT || 3000;
const TOKEN_BASE_URL = 'cdpj.partners.bancointer.com.br';
const PIX_BASE_URL   = 'cdpj.partners.bancointer.com.br';

// Cache do token
let tokenCache = { token: null, expiresAt: 0 };

function requestInter(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      ...options,
      cert: CERT,
      key: KEY,
      rejectUnauthorized: false
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const agora = Date.now();
  if (tokenCache.token && agora < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'pagamento-pix.write',
    grant_type: 'client_credentials'
  }).toString();

  const result = await requestInter({
    hostname: TOKEN_BASE_URL,
    path: '/oauth/v2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  if (result.status !== 200) throw new Error('Token error: ' + JSON.stringify(result.body));

  tokenCache.token = result.body.access_token;
  tokenCache.expiresAt = agora + (result.body.expires_in * 1000);
  console.log('Token gerado, expira em ' + result.body.expires_in + 's');
  return tokenCache.token;
}

async function enviarPix({ chave, valor, descricao }) {
  const token = await getToken();
  const pixBody = JSON.stringify({
    valor: parseFloat(valor),
    descricao: descricao || 'E aí curtiu? ass: Wesley Dantas rs',
    destinatario: { tipo: 'CHAVE', chave: chave }
  });

  return await requestInter({
    hostname: PIX_BASE_URL,
    path: '/banking/v2/pix',
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(pixBody)
    }
  }, pixBody);
}

// Servidor HTTP simples
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'pix-proxy-sudario' }));
    return;
  }

  // Endpoint PIX
  if (req.method === 'POST' && req.url === '/pix') {
    // Verifica API secret
    const secret = req.headers['x-api-secret'];
    if (secret !== API_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { chave, valor, descricao } = data;

        if (!chave || !valor) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'chave e valor são obrigatórios' }));
          return;
        }

        console.log('Enviando PIX para: ' + chave + ' valor: ' + valor);
        const result = await enviarPix({ chave, valor, descricao });
        console.log('PIX resultado: ' + result.status);

        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (e) {
        console.error('Erro:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log('PIX Proxy rodando na porta ' + PORT);
  console.log('Endpoint: POST /pix');
  console.log('Header obrigatório: x-api-secret: ' + API_SECRET);
});
