const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '60mb' }));

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

function escapeShell(str) {
  return String(str || '').replace(/'/g, `'\\''`);
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

function cleanBase64(val) {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.replace(/^data:[^;]+;base64,/, '').trim();
  return trimmed.length > 20 ? trimmed : null;
}

function extractKeystoreBase64(signing) {
  if (!signing || typeof signing !== 'object') return null;

  const direct = cleanBase64(signing.keystoreBase64);
  if (direct) return direct;

  if (signing.keystoreFiles && typeof signing.keystoreFiles === 'object') {
    const entries = Object.entries(signing.keystoreFiles);
    for (const [fname, val] of entries) {
      const lower = String(fname || '').toLowerCase();
      if (
        lower.endsWith('.jks') ||
        lower.endsWith('.keystore') ||
        lower.endsWith('.p12') ||
        lower.endsWith('.pfx') ||
        lower.endsWith('.zip')
      ) {
        if (typeof val === 'string') {
          const b = cleanBase64(val);
          if (b) return b;
        }
        if (val && typeof val === 'object' && typeof val.base64 === 'string') {
          const b = cleanBase64(val.base64);
          if (b) return b;
        }
      }
    }
  }
  return null;
}

function extractLogoBase64(body) {
  if (!body || typeof body !== 'object') return null;

  const candidates = [
    body.logo,
    body.logoBase64,
    body.iconBase64,
    body.logoDataUrl,
    body.iconDataUrl,
    body.icon,
    body.assets && body.assets.logoBase64,
    body.assets && body.assets.logo,
    body.assets && body.assets.icon
  ];

  for (const item of candidates) {
    if (typeof item === 'string') {
      const b = cleanBase64(item);
      if (b) return b;
    } else if (item && typeof item === 'object') {
      const b = cleanBase64(item.base64 || item.dataUrl || item.content);
      if (b) return b;
    }
  }
  return null;
}

function buildApplyLogoScript() {
  return `const fs = require('fs');
const path = require('path');

const srcCandidates = [
  path.join(process.cwd(), 'assets', 'logo.png'),
  path.join(process.cwd(), 'www', 'logo.png')
];
const srcLogo = srcCandidates.find(p => fs.existsSync(p));
if (!srcLogo) {
  console.log('Sin logo para aplicar a mipmap.');
  process.exit(0);
}

const resDir = path.join(process.cwd(), 'android', 'app', 'src', 'main', 'res');
if (!fs.existsSync(resDir)) {
  console.log('No existe carpeta res de Android todavía.');
  process.exit(0);
}

const anydpiDir = path.join(resDir, 'mipmap-anydpi-v26');
if (fs.existsSync(anydpiDir)) {
  fs.rmSync(anydpiDir, { recursive: true, force: true });
}

const entries = fs.readdirSync(resDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory() && entry.name.startsWith('mipmap-')) {
    const dirPath = path.join(resDir, entry.name);
    for (const fn of fs.readdirSync(dirPath)) {
      if (fn.endsWith('.xml') || fn.endsWith('.webp')) {
        fs.rmSync(path.join(dirPath, fn), { force: true });
      }
    }
    for (const targetName of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      fs.copyFileSync(srcLogo, path.join(dirPath, targetName));
    }
  }
}

console.log('Logo aplicado a carpetas mipmap desde:', srcLogo);
`;
}

function buildConfigureScript({ packageId, versionName, versionCode, hasReleaseSigning }) {
  return `const fs = require('fs');
const path = require('path');

const gradlePath = path.join(process.cwd(), 'android', 'app', 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');

gradle = gradle.replace(/applicationId\\s+["'][^"']+["']/g, 'applicationId "${packageId}"');
gradle = gradle.replace(/versionCode\\s+\\d+/g, 'versionCode ${versionCode}');
gradle = gradle.replace(/versionName\\s+["'][^"']+["']/g, 'versionName "${versionName}"');

if (${hasReleaseSigning ? 'true' : 'false'}) {
  const signingBlock = [
    '    signingConfigs {',
    '        release {',
    '            def ksFile = file("release-key.keystore")',
    '            if (ksFile.exists()) {',
    '                storeFile ksFile',
    '            }',
    '            def sPass = System.getenv("STORE_PASS")',
    '            def kPass = System.getenv("KEY_PASS")',
    '            def kAlias = System.getenv("KEY_ALIAS")',
    '            def sType = System.getenv("STORE_TYPE")',
    '            if (sPass) storePassword sPass',
    '            if (kPass) keyPassword kPass',
    '            if (kAlias) keyAlias kAlias',
    '            if (sType) storeType sType',
    '        }',
    '    }',
    ''
  ].join('\\n');

  if (!gradle.includes('signingConfigs {') && gradle.includes('buildTypes {')) {
    gradle = gradle.replace('buildTypes {', signingBlock + '    buildTypes {');
  }

  const btIdx = gradle.indexOf('buildTypes {');
  if (btIdx !== -1) {
    const relIdx = gradle.indexOf('release {', btIdx);
    if (relIdx !== -1) {
      const openBrace = gradle.indexOf('{', relIdx);
      let depth = 0;
      let endBrace = -1;
      for (let i = openBrace; i < gradle.length; i++) {
        if (gradle[i] === '{') depth++;
        else if (gradle[i] === '}') {
          depth--;
          if (depth === 0) {
            endBrace = i;
            break;
          }
        }
      }
      if (endBrace !== -1) {
        const newRelease = [
          'release {',
          '            signingConfig signingConfigs.release',
          '            minifyEnabled false',
          '            shrinkResources false',
          '        }'
        ].join('\\n');
        gradle = gradle.slice(0, releaseIdx) + newRelease + gradle.slice(endBrace + 1);
      }
    }
  }
}

fs.writeFileSync(gradlePath, gradle, 'utf8');
console.log('Configurado build.gradle -> packageId=${packageId}, versionCode=${versionCode}, versionName=${versionName}');
`;
}

function buildWorkflowYaml({ appName, packageId, versionName, versionCode, signing }) {
  const safeName = String(appName || 'App').replace(/[^a-zA-Z0-9 _.-]/g, '').trim() || 'App';
  const safePkg = String(packageId || 'com.lafabricapp.app').trim();
  const safeVer = String(versionName || '1.0.0').replace(/^v/i, '').trim() || '1.0.0';
  const vc = Math.max(1, parseInt(versionCode, 10) || 1);

  const keystoreB64 = extractKeystoreBase64(signing);
  const alias = String((signing && (signing.alias || signing.keyAlias)) || '').trim();
  const storePassword = String((signing && (signing.storePassword || signing.keystorePassword || signing.password)) || '').trim();
  const keyPassword = String((signing && (signing.keyPassword || signing.storePassword || signing.password)) || '').trim();
  const storeType = String((signing && (signing.storeType || signing.keystoreType)) || 'JKS').toUpperCase().includes('PKCS')
    ? 'PKCS12'
    : 'JKS';

  const hasReleaseSigning = Boolean(keystoreB64 && alias && storePassword);

  const signingStep = hasReleaseSigning
    ? `
      - name: Preparar Keystore
        env:
          KEYSTORE_B64: '${escapeShell(keystoreB64)}'
        run: |
          mkdir -p "$RUNNER_TEMP/ks"
          echo "$KEYSTORE_B64" | base64 -d > "$RUNNER_TEMP/ks/blob"
          if unzip -tq "$RUNNER_TEMP/ks/blob" >/dev/null 2>&1; then
            mkdir -p "$RUNNER_TEMP/ks/out"
            unzip -o "$RUNNER_TEMP/ks/blob" -d "$RUNNER_TEMP/ks/out"
            KS_FILE=$(find "$RUNNER_TEMP/ks/out" -type f \\( -iname "*.jks" -o -iname "*.keystore" -o -iname "*.p12" -o -iname "*.pfx" \\) | head -n 1)
          else
            KS_FILE="$RUNNER_TEMP/ks/blob"
          fi
          if [ -z "$KS_FILE" ] || [ ! -f "$KS_FILE" ]; then
            echo "No se encontro un keystore valido"
            exit 1
          fi
          cp "$KS_FILE" android/app/release-key.keystore
`
    : '';

  const gradleTask = hasReleaseSigning ? 'assembleRelease' : 'assembleDebug';
  const apkGlob = hasReleaseSigning
    ? 'android/app/build/outputs/apk/release/*.apk'
    : 'android/app/build/outputs/apk/debug/*.apk';

  const envBlock = hasReleaseSigning
    ? `
        env:
          STORE_PASS: '${escapeShell(storePassword)}'
          KEY_PASS: '${escapeShell(keyPassword || storePassword)}'
          KEY_ALIAS: '${escapeShell(alias)}'
          STORE_TYPE: '${escapeShell(storeType)}'`
    : '';

  return `name: Build ${safeName}

on:
  workflow_dispatch:
  push:
    branches:
      - main

jobs:
  build-android:
    runs-on: ubuntu-latest
    env:
      ANDROID_HOME: /usr/local/lib/android/sdk
      ANDROID_SDK_ROOT: /usr/local/lib/android/sdk
    steps:
      - name: Checkout repositorio
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Setup Java 17
        uses: actions/setup-java@v4
        with:
          distribution: "temurin"
          java-version: "17"

      - name: Preparar entorno Android SDK
        run: |
          export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/cmdline-tools/16.0/bin:$ANDROID_HOME/platform-tools:$PATH"
          echo "ANDROID_HOME=$ANDROID_HOME"
          yes | sdkmanager --licenses >/dev/null 2>&1 || true

      - name: Preparar proyecto Capacitor
        run: |
          mkdir -p www
          if [ -f index.html ]; then
            cp index.html www/index.html
          fi
          if [ -f assets/logo.png ]; then
            cp assets/logo.png www/logo.png
          fi
          cat > package.json << 'EOF'
          {
            "name": "lafabricapp-android-wrapper",
            "version": "${safeVer}",
            "private": true,
            "dependencies": {
              "@capacitor/core": "^6.1.2",
              "@capacitor/cli": "^6.1.2",
              "@capacitor/android": "^6.1.2"
            }
          }
          EOF
          cat > capacitor.config.json << 'EOF'
          {
            "appId": "${safePkg}",
            "appName": "${safeName}",
            "webDir": "www"
          }
          EOF
          npm install --no-audit --no-fund
          npx cap add android
          npx cap copy android
          node scripts/apply-logo.js
${signingStep}
      - name: Configurar Gradle y firma${envBlock}
        run: node scripts/configure-android.js

      - name: Compilar APK${envBlock}
        run: |
          cd android
          chmod +x gradlew
          ./gradlew ${gradleTask} --no-daemon

      - name: Subir APK Artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${slugifyRepo(safeName)}-v${safeVer}-vc${vc}
          path: ${apkGlob}
          if-no-files-found: error
`;
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'FabricApp Backend v2.6 (Clean YAML + Logo Script + Capacitor + Signing)',
    versionCodeSupport: true,
    singleRepoSupport: true
  });
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

    const htmlCode = body.manualCode || body.htmlCode || body.html || '';
    if (htmlCode) {
      await upsertFile(owner, repoName, 'index.html', htmlCode, token, commitMsg, false);
      await upsertFile(owner, repoName, 'www/index.html', htmlCode, token, commitMsg, false);
    }

    const logoB64 = extractLogoBase64(body);
    if (logoB64) {
      await upsertFile(owner, repoName, 'assets/logo.png', logoB64, token, commitMsg, true);
      await upsertFile(owner, repoName, 'www/logo.png', logoB64, token, commitMsg, true);
    }

    const applyLogoScript = buildApplyLogoScript();
    await upsertFile(owner, repoName, 'scripts/apply-logo.js', applyLogoScript, token, commitMsg, false);

    const signingObj = body.signing || null;
    const keystoreB64 = extractKeystoreBase64(signingObj);
    const alias = String((signingObj && (signingObj.alias || signingObj.keyAlias)) || '').trim();
    const storePassword = String((signingObj && (signingObj.storePassword || signingObj.keystorePassword || signingObj.password)) || '').trim();
    const hasReleaseSigning = Boolean(keystoreB64 && alias && storePassword);

    const configureScript = buildConfigureScript({
      packageId,
      versionName,
      versionCode,
      hasReleaseSigning
    });
    await upsertFile(owner, repoName, 'scripts/configure-android.js', configureScript, token, commitMsg, false);

    const yml = buildWorkflowYaml({
      appName: body.appName || repoName,
      packageId,
      versionName,
      versionCode,
      signing: signingObj
    });
    await upsertFile(owner, repoName, '.github/workflows/build.yml', yml, token, commitMsg, false);

    return res.json({
      ok: true,
      reusedRepo: reuseExistingRepo,
      repo: fullName,
      repoUrl: repoData.html_url,
      actionsUrl: `${repoData.html_url}/actions`,
      packageId,
      versionName,
      versionCode,
      logoIncluded: Boolean(logoB64)
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
  console.log(`FabricApp backend v2.6 listening on port ${PORT}`);
});
        
