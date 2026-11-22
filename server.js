const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Almacén en memoria de tokens por sesión simple (para pruebas/desarrollo)
const sessions = new Map();

function slugifyRepo(val) {
  return String(val || 'mi-app-lafabricapp')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'mi-app-lafabricapp';
}

function sanitizePackageId(val, repoSlug) {
  const clean = String(val || '')
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');
  if (clean.includes('.')) return clean;
  const base = slugifyRepo(repoSlug || 'app').replace(/-/g, '') || 'app';
  return 'com.lafabricapp.' + base;
}

function getTokenFromReq(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    return sessions.get(t) || t;
  }
  return process.env.GITHUB_TOKEN || '';
}

async function ghFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function ensureRepo(owner, repoName, token, reuseExistingRepo = true) {
  if (reuseExistingRepo) {
    const existing = await ghFetch(`https://api.github.com/repos/${owner}/${repoName}`, token);
    if (existing.ok) return existing.data;
  }
  const created = await ghFetch('https://api.github.com/user/repos', token, {
    method: 'POST',
    body: JSON.stringify({
      name: repoName,
      private: false,
      auto_init: true,
      description: `Repositorio único gestionado por LaFabricApp (${repoName})`
    })
  });
  if (!created.ok) {
    throw new Error(created.data.message || `No se pudo crear el repositorio ${repoName}`);
  }
  // Pequeña pausa para que GitHub inicialice la rama por defecto
  await new Promise(r => setTimeout(r, 1500));
  return created.data;
}

async function upsertFile(owner, repoName, filePath, contentString, token, commitMessage, isBase64 = false) {
  const encodedContent = isBase64
    ? contentString
    : Buffer.from(contentString, 'utf8').toString('base64');

  const getRes = await ghFetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(filePath)}`,
    token
  );
  const sha = getRes.ok && getRes.data && getRes.data.sha ? getRes.data.sha : undefined;

  const putRes = await ghFetch(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(filePath)}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({
        message: commitMessage,
        content: encodedContent,
        ...(sha ? { sha } : {})
      })
    }
  );
  if (!putRes.ok) {
    throw new Error(putRes.data.message || `Error subiendo ${filePath}`);
  }
}

function buildWorkflowYaml({ appName, packageId, versionName, versionCode, hasSigning }) {
  const safeName = String(appName || 'App').replace(/"/g, '');
  const safePkg = String(packageId || 'com.lafabricapp.app').replace(/"/g, '');
  const safeVer = String(versionName || '1.0.0').replace(/"/g, '');
  const vc = Math.max(1, parseInt(versionCode, 10) || 1);

  return `name: Build ${safeName} (Repo Único)

on:
  workflow_dispatch:
  push:
    branches: [ main ]

jobs:
  build-android:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repositorio único
        uses: actions/checkout@v4

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Aplicar applicationId, versionName y versionCode
        run: |
          if [ -f android/app/build.gradle ]; then
            sed -i "s/applicationId \\".*\\"/applicationId \\"${safePkg}\\"/g" android/app/build.gradle
            sed -i "s/versionCode [0-9]*/versionCode ${vc}/g" android/app/build.gradle
            sed -i "s/versionName \\".*\\"/versionName \\"${safeVer}\\"/g" android/app/build.gradle
          fi

      - name: Compilar APK
        run: |
          if [ -f android/gradlew ]; then
            cd android && chmod +x gradlew && ./gradlew ${hasSigning ? 'assembleRelease' : 'assembleDebug'}
          else
            echo "Proyecto listo en el repositorio (${safePkg} · versionCode ${vc})."
          fi
`;
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'FabricApp Backend', versionCodeSupport: true, singleRepoSupport: true });
});

app.get('/api/state', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) return res.json({ github: false });
  const u = await ghFetch('https://api.github.com/user', token);
  if (!u.ok) return res.json({ github: false });
  return res.json({ github: true, login: u.data.login });
});

app.post('/api/token', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: 'Falta el token de GitHub' });
  const u = await ghFetch('https://api.github.com/user', token);
  if (!u.ok) return res.status(401).json({ error: 'Token de GitHub inválido' });
  const sessionToken = 'lf_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(sessionToken, token);
  return res.json({ ok: true, login: u.data.login, token: sessionToken });
});

app.post('/api/build', async (req, res) => {
  try {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: 'Conectá GitHub con token primero' });

    const u = await ghFetch('https://api.github.com/user', token);
    if (!u.ok) return res.status(401).json({ error: 'No se pudo verificar el usuario en GitHub' });
    const owner = u.data.login;

    const body = req.body || {};
    const repoSlug = slugifyRepo(body.repoSlug || body.repoName || body.appName);
    const packageId = sanitizePackageId(body.packageId || body.applicationId, repoSlug);
    const versionName = String(body.versionName || body.version || '1.0.0').replace(/^v/i, '').trim() || '1.0.0';
    const versionCode = Math.max(1, parseInt(body.versionCode, 10) || 1);
    const reuseExistingRepo = body.reuseExistingRepo !== false && body.createNewRepoPerBuild !== true;

    const repoData = await ensureRepo(owner, repoSlug, token, reuseExistingRepo);
    const repoName = repoData.name;
    const fullName = `${owner}/${repoName}`;
    const commitMsg = `Update ${versionName} (versionCode ${versionCode})${body.changelog ? ': ' + body.changelog : ''}`;

    if (body.manualCode) {
      await upsertFile(owner, repoName, 'www/index.html', body.manualCode, token, commitMsg, false);
      await upsertFile(owner, repoName, 'index.html', body.manualCode, token, commitMsg, false);
    }

    const hasSigning = Boolean(body.signing && body.signing.keystoreFiles && Object.keys(body.signing.keystoreFiles).length > 0);
    const yml = buildWorkflowYaml({
      appName: body.appName || repoName,
      packageId,
      versionName,
      versionCode,
      hasSigning
    });
    await upsertFile(owner, repoName, '.github/workflows/build.yml', yml, token, commitMsg, false);

    return res.json({
      ok: true,
      reusedRepo: reuseExistingRepo,
      repo: fullName,
      repoUrl: repoData.html_url,
      packageId,
      versionName,
      versionCode
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error interno en /api/build' });
  }
});

app.get('/api/runs', async (req, res) => {
  try {
    const token = getTokenFromReq(req);
    const repo = String((req.query && req.query.repo) || '').trim();
    if (!token || !repo) return res.json({ none: true });
    const runsRes = await ghFetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=1`, token);
    if (!runsRes.ok || !runsRes.data.workflow_runs || !runsRes.data.workflow_runs.length) {
      return res.json({ none: true });
    }
    const lastRun = runsRes.data.workflow_runs[0];
    return res.json({
      none: false,
      status: lastRun.status,
      conclusion: lastRun.conclusion,
      html_url: lastRun.html_url
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FabricApp backend listening on port ${PORT}`);
});
    
