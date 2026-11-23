'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const sodium = require('libsodium-wrappers');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS para permitir acceso desde WebView / Capacitor / navegador
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Servir frontend estático si existe carpeta public/
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://lafabricapp-1-0.onrender.com').replace(/\/+$/, '');

// Almacén en memoria de sesiones y códigos de vinculación móvil
const sessions = new Map();
const linkCodes = new Map();

function crearSessionToken(ghToken, login) {
  const apiToken = 'lf_' + crypto.randomBytes(24).toString('hex');
  sessions.set(apiToken, { ghToken, login, createdAt: Date.now() });
  return apiToken;
}

function resolverAuth(req) {
  const auth = req.headers.authorization || '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.query.token || '').trim();
  if (!raw) return null;
  if (sessions.has(raw)) return sessions.get(raw);
  // También permite pasar un PAT de GitHub directamente si el servidor reinició en Render
  if (/^(ghp_|github_pat_|gho_)/.test(raw)) {
    return { ghToken: raw, login: null };
  }
  return null;
}

async function ghFetch(ghToken, endpoint, opts = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
  const headers = Object.assign({
    'Authorization': `Bearer ${ghToken}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LaFabricApp-Server'
  }, opts.headers || {});
  return fetch(url, Object.assign({}, opts, { headers }));
}

async function obtenerUsuarioGitHub(ghToken) {
  const r = await ghFetch(ghToken, '/user');
  if (!r.ok) throw new Error('Token de GitHub inválido o sin permisos.');
  return r.json();
}

// ---- Seguridad en HTML (respaldo del lado del servidor) ----
function inyectarEscudoSeguridadServidor(html) {
  if (!html || html.includes('id="lf-privacy-shield"')) return html;
  const bloque = [
    '<meta http-equiv="X-Content-Type-Options" content="nosniff">',
    '<meta name="referrer" content="no-referrer">',
    '<script id="lf-privacy-shield">(function(){window.lfSafeText=function(el,v){if(!el)return;el.textContent=v==null?"":String(v);};try{window.eval=function(){throw new Error("eval bloqueado");};window.Function=function(){throw new Error("Function bloqueado");};}catch(e){}document.addEventListener("click",function(ev){var a=ev.target&&ev.target.closest?ev.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(/^https?:\/\//i.test(h)){var rel=new Set((a.getAttribute("rel")||"").toLowerCase().split(/\s+/).filter(Boolean));rel.add("noopener");rel.add("noreferrer");a.setAttribute("rel",Array.from(rel).join(" "));}},true);})();<\/script>'
  ].join('\n');
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + '\n' + bloque;
  return html.slice(0, idx) + bloque + '\n' + html.slice(idx);
}

// ---- GitHub Repo & Archivos ----
async function asegurarRepositorio({ ghToken, owner, repoName, privateRepo = false, description = 'Generado con LaFabricApp' }) {
  const check = await ghFetch(ghToken, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
  if (check.ok) {
    return check.json();
  }
  const create = await ghFetch(ghToken, '/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: repoName,
      description,
      private: Boolean(privateRepo),
      auto_init: false
    })
  });
  if (!create.ok) {
    const err = await create.json().catch(() => ({}));
    throw new Error(err.message || `No se pudo crear el repositorio (${create.status})`);
  }
  return create.json();
}

async function subirArchivoGitHub({ ghToken, owner, repo, filePath, contentBase64, message, branch = 'main' }) {
  const cleanPath = filePath.replace(/^\/+/, '');
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${cleanPath.split('/').map(encodeURIComponent).join('/')}`;

  let sha;
  const existing = await ghFetch(ghToken, `${apiPath}?ref=${encodeURIComponent(branch)}`);
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const body = {
    message: message || `Update ${cleanPath}`,
    content: contentBase64,
    branch
  };
  if (sha) body.sha = sha;

  const putRes = await ghFetch(ghToken, apiPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error(`Error subiendo ${cleanPath}: ${err.message || putRes.status}`);
  }
  return putRes.json();
}

function dataUrlToBase64(dataUrlOrText, isBinary = false) {
  if (!dataUrlOrText) return '';
  if (typeof dataUrlOrText === 'string' && dataUrlOrText.startsWith('data:')) {
    const idx = dataUrlOrText.indexOf(',');
    return idx !== -1 ? dataUrlOrText.slice(idx + 1) : '';
  }
  if (isBinary) return Buffer.from(dataUrlOrText, 'base64').toString('base64');
  return Buffer.from(String(dataUrlOrText), 'utf8').toString('base64');
}

function extraerKeystoreBase64(signing) {
  const files = (signing && signing.keystoreFiles) || {};
  const firstKey = Object.keys(files)[0];
  if (!firstKey) return '';
  return dataUrlToBase64(files[firstKey], true);
}

async function guardarSecretGitHub({ ghToken, owner, repo, secretName, secretValue }) {
  if (!secretValue) return;
  await sodium.ready;

  const keyRes = await ghFetch(
    ghToken,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/public-key`
  );
  if (!keyRes.ok) {
    throw new Error(`No se pudo obtener public-key para secrets (${keyRes.status})`);
  }
  const { key, key_id } = await keyRes.json();

  const binKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binSecret = sodium.from_string(String(secretValue));
  const encryptedBytes = sodium.crypto_box_seal(binSecret, binKey);
  const encrypted_value = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  const putRes = await ghFetch(
    ghToken,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/${encodeURIComponent(secretName)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypted_value, key_id })
    }
  );
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    throw new Error(`Error guardando secret ${secretName}: ${err.message || putRes.status}`);
  }
}

// ---- Activación automática de GitHub Pages en rama `main` ----
async function asegurarGitHubPagesMain({ owner, repo, ghToken, branch = 'main', sitePath = '/' }) {
  const baseUrl = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`;

  // 1) Crear/habilitar Pages apuntando a `main` / `/`
  const createRes = await ghFetch(ghToken, baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { branch, path: sitePath }
    })
  });

  if (createRes.ok) {
    const data = await createRes.json().catch(() => ({}));
    return {
      ok: true,
      action: 'created',
      url: data.html_url || `https://${owner}.github.io/${repo}/`
    };
  }

  // 2) Si ya existía pero quedó en `None` o en otra rama, forzar `PUT` hacia `main`
  const updateRes = await ghFetch(ghToken, baseUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: { branch, path: sitePath }
    })
  });

  if (updateRes.ok) {
    const data = await updateRes.json().catch(() => ({}));
    return {
      ok: true,
      action: 'updated',
      url: data.html_url || `https://${owner}.github.io/${repo}/`
    };
  }

  const errData = await updateRes.json().catch(() => ({}));
  return {
    ok: false,
    status: updateRes.status,
    error: errData.message || 'No se pudo configurar GitHub Pages en main'
  };
}

// ---- Workflow de GitHub Actions para APK Capacitor (con firma opcional e ícono) ----
function generarWorkflowApk({ appName, packageId, versionName, versionCode, signing }) {
  const firmaActiva = Boolean(signing && signing.enabled && signing.alias && signing.storePassword);
  const storeType = signing && signing.storeType === 'PKCS12' ? 'PKCS12' : 'JKS';

  const pasosFirma = firmaActiva ? `
      - name: Decodificar Keystore
        env:
          KEYSTORE_B64: \${{ secrets.LF_KEYSTORE_B64 }}
        run: |
          if [ -n "$KEYSTORE_B64" ]; then
            echo "$KEYSTORE_B64" | base64 -d > "$RUNNER_TEMP/release.keystore"
          fi

      - name: Compilar APK Release firmado
        env:
          STORE_PASS: \${{ secrets.LF_STORE_PASS }}
          KEY_PASS: \${{ secrets.LF_KEY_PASS }}
          KEY_ALIAS: \${{ secrets.LF_KEY_ALIAS }}
        run: |
          cd android
          chmod +x gradlew
          ./gradlew assembleRelease \\
            -Pandroid.injected.signing.store.file="$RUNNER_TEMP/release.keystore" \\
            -Pandroid.injected.signing.store.password="$STORE_PASS" \\
            -Pandroid.injected.signing.store.type="${storeType}" \\
            -Pandroid.injected.signing.key.alias="$KEY_ALIAS" \\
            -Pandroid.injected.signing.key.password="\${KEY_PASS:-$STORE_PASS}"
` : `
      - name: Compilar APK Debug (sin firma release)
        run: |
          cd android
          chmod +x gradlew
          ./gradlew assembleDebug
`;

  const rutaApk = firmaActiva
    ? 'android/app/build/outputs/apk/release/*.apk'
    : 'android/app/build/outputs/apk/debug/*.apk';

  return `name: Build Android APK

on:
  push:
    branches: [ main ]
  workflow_dispatch:

jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node 20
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Instalar Capacitor y generar proyecto Android
        run: |
          npm init -y
          npm install @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6
          npx cap init "${appName.replace(/"/g, '')}" "${packageId}" --web-dir=www
          npx cap add android
          node -e '
            const fs = require("fs");
            const p = "android/app/build.gradle";
            if (fs.existsSync(p)) {
              let g = fs.readFileSync(p, "utf8");
              g = g.replace(/versionCode\\s+\\d+/, "versionCode ${Number(versionCode) || 1}");
              g = g.replace(/versionName\\s+"[^"]*"/, "versionName \\"${String(versionName || '1.0.0').replace(/"/g, '')}\\"");
              fs.writeFileSync(p, g);
            }
          '
          npx cap sync android
          python3 - << 'PYEOF'
          import os
          try:
              from PIL import Image
              src = "icon.png"
              if os.path.exists(src):
                  img = Image.open(src).convert("RGBA")
                  sizes = {
                      "mipmap-mdpi": 48,
                      "mipmap-hdpi": 72,
                      "mipmap-xhdpi": 96,
                      "mipmap-xxhdpi": 144,
                      "mipmap-xxxhdpi": 192,
                  }
                  res_base = "android/app/src/main/res"
                  for folder, px in sizes.items():
                      out_dir = os.path.join(res_base, folder)
                      if os.path.isdir(out_dir):
                          resized = img.resize((px, px))
                          for name in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
                              resized.save(os.path.join(out_dir, name))
          except Exception as e:
              print("Aviso icono:", e)
          PYEOF
${pasosFirma}
      - name: Subir artefacto APK
        uses: actions/upload-artifact@v4
        with:
          name: app-android-apk
          path: ${rutaApk}
          if-no-files-found: error
`;
}

// ---- Endpoints API ----
app.get('/api/state', async (req, res) => {
  const auth = resolverAuth(req);
  if (!auth) return res.json({ ok: true, github: false });
  try {
    const user = auth.login ? { login: auth.login } : await obtenerUsuarioGitHub(auth.ghToken);
    auth.login = user.login;
    res.json({ ok: true, github: true, login: user.login });
  } catch (e) {
    res.json({ ok: true, github: false });
  }
});

app.post('/api/token', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Falta el token de GitHub.' });
    const user = await obtenerUsuarioGitHub(token);
    const apiToken = crearSessionToken(token, user.login);
    res.json({ ok: true, login: user.login, token: apiToken });
  } catch (e) {
    res.status(401).json({ error: e.message || 'Token inválido.' });
  }
});

// OAuth estándar y flujo móvil por código
app.get('/api/link/start', (req, res) => {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  linkCodes.set(code, { ok: false, createdAt: Date.now() });
  res.json({ ok: true, code });
});

app.get('/api/link/status', (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const entry = linkCodes.get(code);
  if (!entry) return res.json({ ok: false });
  res.json(entry);
});

app.get('/auth/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).send('Falta configurar GITHUB_CLIENT_ID en Render.');
  }
  const state = String(req.query.state || '');
  const redirectUri = `${PUBLIC_BASE_URL}/auth/github/callback`;
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('repo workflow')}&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

app.get('/auth/github/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No se recibió access_token de GitHub.');
    const user = await obtenerUsuarioGitHub(tokenData.access_token);
    const apiToken = crearSessionToken(tokenData.access_token, user.login);

    if (state.startsWith('link-')) {
      const linkCode = state.slice(5).toUpperCase();
      linkCodes.set(linkCode, { ok: true, login: user.login, token: apiToken });
      return res.send('<h2>¡Conectado a GitHub!</h2><p>Ya podés volver a LaFabricApp.</p>');
    }
    res.redirect(`/?token=${encodeURIComponent(apiToken)}`);
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(e.message || 'Error OAuth')}`);
  }
});

// ---- Ruta principal de construcción ----
app.post('/api/build', async (req, res) => {
  const auth = resolverAuth(req);
  if (!auth) return res.status(401).json({ error: 'No conectado a GitHub.' });

  try {
    const user = auth.login ? { login: auth.login } : await obtenerUsuarioGitHub(auth.ghToken);
    auth.login = user.login;
    const owner = user.login;

    const body = req.body || {};
    const type = body.type || 'web'; // 'web' | 'pwa' | 'apk'
    const kind = body.kind || 'web';
    const appName = String(body.appName || 'Mi App').trim();
    const repoName = String(body.repoSlug || body.repoName || 'mi-app')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mi-app';
    const packageId = String(body.packageId || body.applicationId || `com.lafabricapp.${repoName.replace(/-/g, '')}`);
    const versionName = String(body.versionName || '1.0.0');
    const versionCode = Number(body.versionCode) || 1;
    const changelog = String(body.changelog || `Build ${versionName}`);
    const privateRepo = Boolean(body.privateRepo);
    const signing = (body.signing && body.signing.enabled) ? body.signing : null;

    // 1. Crear o recuperar repositorio (público por defecto para GitHub Pages gratuito)
    const repoInfo = await asegurarRepositorio({
      ghToken: auth.ghToken,
      owner,
      repoName,
      privateRepo,
      description: `${appName} (${versionName})`
    });

    const defaultBranch = repoInfo.default_branch || 'main';

    // 2. Preparar HTML (aplicando escudo si viene pedido)
    let htmlFinal = String(body.manualCode || '<!DOCTYPE html><html><body><h1>Hola</h1></body></html>');
    if (body.includeSecurityShield) {
      htmlFinal = inyectarEscudoSeguridadServidor(htmlFinal);
    }

    // 3. Subir index.html en raíz (para GitHub Pages) y en www/index.html (para Capacitor APK)
    const htmlB64 = dataUrlToBase64(htmlFinal, false);
    await subirArchivoGitHub({
      ghToken: auth.ghToken,
      owner,
      repo: repoName,
      filePath: 'index.html',
      contentBase64: htmlB64,
      message: `${changelog} - index.html`,
      branch: defaultBranch
    });

    if (type === 'apk' || type === 'pwa') {
      await subirArchivoGitHub({
        ghToken: auth.ghToken,
        owner,
        repo: repoName,
        filePath: 'www/index.html',
        contentBase64: htmlB64,
        message: `${changelog} - www/index.html`,
        branch: defaultBranch
      });
    }

    // 4. Subir assets multimedia / manifest / íconos
    const assets = body.assets || {};
    for (const [assetPath, dataUrl] of Object.entries(assets)) {
      const b64 = dataUrlToBase64(dataUrl, true);
      if (!b64) continue;
      await subirArchivoGitHub({
        ghToken: auth.ghToken,
        owner,
        repo: repoName,
        filePath: assetPath,
        contentBase64: b64,
        message: `Asset ${assetPath}`,
        branch: defaultBranch
      });
      if (type === 'apk' || type === 'pwa') {
        await subirArchivoGitHub({
          ghToken: auth.ghToken,
          owner,
          repo: repoName,
          filePath: `www/${assetPath.replace(/^\/+/, '')}`,
          contentBase64: b64,
          message: `Asset www/${assetPath}`,
          branch: defaultBranch
        });
      }
    }

    // 5. Subir logo si viene
    if (body.logo) {
      const logoB64 = dataUrlToBase64(body.logo, true);
      if (logoB64) {
        await subirArchivoGitHub({
          ghToken: auth.ghToken,
          owner,
          repo: repoName,
          filePath: 'icon.png',
          contentBase64: logoB64,
          message: 'Logo app',
          branch: defaultBranch
        });
      }
    }

    // 6. Guardar secrets de firma y subir workflow de GitHub Actions si es APK o PWA
    if (type === 'apk' || type === 'pwa') {
      if (signing) {
        const ksB64 = extraerKeystoreBase64(signing);
        if (!ksB64) {
          throw new Error('Activaste la firma pero no se recibió ningún archivo de keystore.');
        }
        await guardarSecretGitHub({ ghToken: auth.ghToken, owner, repo: repoName, secretName: 'LF_KEYSTORE_B64', secretValue: ksB64 });
        await guardarSecretGitHub({ ghToken: auth.ghToken, owner, repo: repoName, secretName: 'LF_STORE_PASS', secretValue: signing.storePassword });
        await guardarSecretGitHub({ ghToken: auth.ghToken, owner, repo: repoName, secretName: 'LF_KEY_PASS', secretValue: signing.keyPassword || signing.storePassword });
        await guardarSecretGitHub({ ghToken: auth.ghToken, owner, repo: repoName, secretName: 'LF_KEY_ALIAS', secretValue: signing.alias });
      }

      const workflowYaml = generarWorkflowApk({
        appName,
        packageId,
        versionName,
        versionCode,
        signing
      });
      await subirArchivoGitHub({
        ghToken: auth.ghToken,
        owner,
        repo: repoName,
        filePath: '.github/workflows/build.yml',
        contentBase64: dataUrlToBase64(workflowYaml, false),
        message: `Workflow APK ${versionName} (vc ${versionCode})`,
        branch: defaultBranch
      });
    }

    // 7. Activar GitHub Pages en la rama `main` (o rama por defecto) para Web y PWA
    let siteUrl = '';
    let pagesWarning = null;
    if (type === 'web' || type === 'pwa') {
      const pagesRes = await asegurarGitHubPagesMain({
        owner,
        repo: repoName,
        ghToken: auth.ghToken,
        branch: defaultBranch,
        sitePath: '/'
      });
      if (pagesRes.ok) {
        siteUrl = pagesRes.url;
      } else {
        pagesWarning = pagesRes.error;
        siteUrl = `https://${owner}.github.io/${repoName}/`;
        console.warn('Aviso GitHub Pages:', pagesRes.status, pagesRes.error);
      }
    }

    res.json({
      ok: true,
      repo: `${owner}/${repoName}`,
      repoUrl: repoInfo.html_url || `https://github.com/${owner}/${repoName}`,
      siteUrl,
      pagesWarning
    });
  } catch (e) {
    console.error('Error en /api/build:', e);
    res.status(500).json({ error: e.message || 'Error interno al construir.' });
  }
});

// ---- Consultar estado del workflow en GitHub Actions ----
app.get('/api/runs', async (req, res) => {
  const auth = resolverAuth(req);
  if (!auth) return res.status(401).json({ error: 'No autorizado.' });

  const fullRepo = String(req.query.repo || '').trim();
  if (!fullRepo.includes('/')) return res.status(400).json({ error: 'Falta parámetro repo.' });

  try {
    const r = await ghFetch(auth.ghToken, `/repos/${fullRepo}/actions/runs?per_page=1`);
    if (!r.ok) return res.json({ none: true });
    const data = await r.json();
    const run = data.workflow_runs && data.workflow_runs[0];
    if (!run) return res.json({ none: true });
    res.json({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url
    });
  } catch (e) {
    res.json({ none: true });
  }
});

app.listen(PORT, () => {
  console.log(`LaFabricApp backend escuchando en puerto ${PORT}`);
});
