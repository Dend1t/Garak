#!/usr/bin/env node
// GitHub 릴리즈 만들기: npm run release            (맥 dmg·윈도우 설치 파일을 빌드해 올린다)
//                      npm run release -- --skip-build   (이미 빌드한 파일을 올린다)
//                      npm run release -- --draft        (초안으로 만든다)
//
// 순서: 버전·작업 트리 확인 → CHANGELOG.md에서 이 버전 설명 읽기 → 빌드(맥은 Developer ID 서명·Apple 공증) →
//       Gatekeeper 확인 → release/에 알기 쉬운 이름으로 모으고 SHA256SUMS.txt 만들기 → 태그(v<버전>) 붙여 푸시 →
//       gh release create로 올리기.
// GitHub 계정은 origin 주소의 소유자(hanseihee)로 쓴다(gh 활성 계정이 달라도 된다).
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const draft = args.has('--draft');

const fail = (message) => {
  console.error(`\n릴리즈를 멈췄습니다: ${message}`);
  process.exit(1);
};
const run = (cmd, cmdArgs, opts = {}) => String(execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', ...opts }) ?? '').trim();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── 1. 버전 ────────────────────────────────────────────────────────────────
const version = JSON.parse(read('package.json')).version;
const tag = `v${version}`;
const versions = {
  'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'src-tauri/Cargo.toml': (read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m) || [])[1],
  'ios/project.yml': (read('ios/project.yml').match(/MARKETING_VERSION:\s*"([^"]+)"/) || [])[1],
};
for (const [p, v] of Object.entries(versions)) {
  if (v !== version) fail(`${p}의 버전(${v})이 package.json(${version})과 다릅니다. npm run version:set -- ${version}`);
}

// ── 2. git 상태 ────────────────────────────────────────────────────────────
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('main 가지에서만 릴리즈합니다');
if (run('git', ['status', '--porcelain'])) fail('커밋하지 않은 변경이 있습니다');
run('git', ['fetch', '--quiet', 'origin']);
if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) fail('origin/main과 다릅니다. 먼저 푸시하세요');
if (run('git', ['tag', '--list', tag])) fail(`태그 ${tag}가 이미 있습니다. 버전을 올리세요(npm run version:set -- <버전>)`);
if (run('git', ['ls-remote', '--tags', 'origin', tag])) fail(`GitHub에 태그 ${tag}가 이미 있습니다`);

const remote = run('git', ['remote', 'get-url', 'origin']);
const repo = (remote.match(/github\.com[/:]([^/]+\/[^/.]+)(\.git)?$/) || [])[1];
if (!repo) fail(`origin이 GitHub 저장소가 아닙니다: ${remote}`);
const owner = repo.split('/')[0];
let token;
try {
  token = run('gh', ['auth', 'token', '--user', owner]);
} catch {
  fail(`gh에 ${owner} 계정이 로그인되어 있지 않습니다(gh auth login)`);
}
const gh = (ghArgs, opts = {}) => run('gh', ghArgs, { env: { ...process.env, GH_TOKEN: token }, ...opts });

// ── 3. 릴리즈 설명(CHANGELOG.md) ───────────────────────────────────────────
const changelog = read('CHANGELOG.md');
const head = new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s.*)?$`, 'm');
const start = changelog.search(head);
if (start < 0) fail(`CHANGELOG.md에 "## ${version}" 칸이 없습니다`);
const rest = changelog.slice(start).split('\n').slice(1).join('\n');
const end = rest.search(/^## /m);
const body = (end < 0 ? rest : rest.slice(0, end)).trim();
if (!body || /^-\s*$/m.test(body)) fail(`CHANGELOG.md의 ${version} 칸이 비어 있습니다`);

// ── 4. 빌드 ────────────────────────────────────────────────────────────────
// 맥: 받은 사람이 경고 없이 바로 열도록 Developer ID로 서명하고 Apple 공증을 받는다.
// 앱은 tauri build가 서명·공증·스테이플하고(APPLE_* 환경 변수), DMG는 여기서 서명·공증·스테이플한다.
// 저장소를 받은 다른 사람의 npm run build:mac은 지금처럼 임시 서명된다(tauri.conf.json signingIdentity "-").
const commitTime = Number(run('git', ['log', '-1', '--format=%ct'])) * 1000;
const macAppRel = 'src-tauri/target/release/bundle/macos/Garak.app';
const macDmgRel = `src-tauri/target/release/bundle/dmg/Garak_${version}_aarch64.dmg`;
if (!skipBuild) {
  const mac = macSigning();
  for (const script of ['build:mac', 'build:win']) {
    console.log(`\n▶ npm run ${script}`);
    const env = script === 'build:mac' ? { ...process.env, ...mac.env } : process.env;
    const r = spawnSync('npm', ['run', script], { cwd: root, stdio: 'inherit', env });
    if (r.status !== 0) fail(`${script} 빌드가 실패했습니다`);
    if (script === 'build:mac') notarizeDmg(mac, path.join(root, macDmgRel));
  }
}

// 맥 앱 번들 서명 확인: 실행 파일에만 링커 서명이 붙은 번들은 내려받으면 "손상되었습니다"로 열리지 않는다(0.2.7까지).
const macApp = path.join(root, macAppRel);
const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', macApp], { encoding: 'utf8' });
if (verify.status !== 0) fail(`맥 앱 서명이 올바르지 않습니다:\n${verify.stderr}`);
checkGatekeeper(macApp, path.join(root, macDmgRel));

// ── 5. 파일 모으기 ─────────────────────────────────────────────────────────
const assets = [
  {
    from: macDmgRel,
    name: `Garak-${version}-mac-arm64.dmg`,
    label: '맥(Apple 실리콘)',
  },
  {
    from: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Garak_${version}_x64-setup.exe`,
    name: `Garak-${version}-windows-x64-setup.exe`,
    label: '윈도우(64비트)',
  },
];
const outDir = path.join(root, 'release', version);
fs.mkdirSync(outDir, { recursive: true });
const sums = [];
for (const a of assets) {
  const src = path.join(root, a.from);
  if (!fs.existsSync(src)) fail(`${a.from}이(가) 없습니다. --skip-build 없이 다시 실행하세요`);
  if (fs.statSync(src).mtimeMs < commitTime) fail(`${a.from}이(가) 마지막 커밋보다 오래됐습니다. --skip-build 없이 다시 실행하세요`);
  const dst = path.join(outDir, a.name);
  fs.copyFileSync(src, dst);
  a.path = dst;
  a.size = fs.statSync(dst).size;
  a.sha = crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
  sums.push(`${a.sha}  ${a.name}`);
}
const sumsPath = path.join(outDir, 'SHA256SUMS.txt');
fs.writeFileSync(sumsPath, `${sums.join('\n')}\n`);
// 예전처럼 배포/ 폴더에도 둔다(저장소에는 올리지 않는 폴더).
const localDir = path.join(root, '배포');
fs.mkdirSync(localDir, { recursive: true });
for (const a of assets) fs.copyFileSync(a.path, path.join(localDir, a.name));

// ── 6. 태그·릴리즈 ─────────────────────────────────────────────────────────
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const notes = `${body}

## 내려받기

| 운영체제 | 파일 | 크기 |
|---|---|---|
${assets.map((a) => `| ${a.label} | \`${a.name}\` | ${mb(a.size)} |`).join('\n')}

- **맥**: Apple Developer ID로 서명하고 Apple 공증을 받았습니다. DMG를 열고 **Garak**을 옆의 **Applications** 폴더로 끌어 놓으면 바로 열립니다.
- **윈도우**: 서명하지 않아 SmartScreen 경고가 뜨면 "추가 정보 → 실행"을 고르세요.

iOS 앱은 TestFlight 공개 테스트로 설치합니다: https://testflight.apple.com/join/g27zcffB (직접 빌드하려면 저장소의 \`ios/\`를 Xcode로, README 참고).

<details><summary>SHA-256</summary>

\`\`\`
${sums.join('\n')}
\`\`\`
</details>
`;
const notesPath = path.join(os.tmpdir(), `ytm-release-${version}.md`);
fs.writeFileSync(notesPath, notes);

console.log(`\n▶ 태그 ${tag}`);
run('git', ['tag', '-a', tag, '-m', `Garak ${version}`]);
run('git', ['push', 'origin', tag], { stdio: 'inherit' });

console.log(`\n▶ GitHub 릴리즈 ${repo} ${tag}`);
const url = gh([
  'release', 'create', tag, ...assets.map((a) => a.path), sumsPath,
  '--repo', repo, '--title', `Garak ${version}`, '--notes-file', notesPath, '--verify-tag',
  ...(draft ? ['--draft'] : []),
]);
console.log(`\n완료: ${url}`);

// ── 맥 서명·공증 ───────────────────────────────────────────────────────────

/**
 * 맥 서명·공증 정보. 키체인의 Developer ID 인증서로 서명하고 App Store Connect API 키로 공증한다.
 * API 키: 환경 변수 APPLE_API_KEY·APPLE_API_ISSUER(·APPLE_API_KEY_PATH), 없으면 ~/.appstoreconnect/garak-notary.json의
 * {"keyId": "…", "issuerId": "…"}. 키 파일은 ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8(Apple 도구가 찾는 자리).
 * 빌드 전에 불러, 빠진 것이 있으면 빌드에 시간을 쓰기 전에 멈춘다.
 */
function macSigning() {
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const identity = process.env.APPLE_SIGNING_IDENTITY || (identities.match(/"(Developer ID Application: [^"]+)"/) || [])[1];
  if (!identity) fail('키체인에 "Developer ID Application" 인증서가 없습니다(애플 개발자 사이트 → Certificates에서 만들어 설치)');
  const asc = path.join(os.homedir(), '.appstoreconnect');
  const config = path.join(asc, 'garak-notary.json');
  let keyId = process.env.APPLE_API_KEY;
  let issuer = process.env.APPLE_API_ISSUER;
  if (!keyId || !issuer) {
    if (!fs.existsSync(config)) fail(`공증에 쓸 App Store Connect API 키 정보가 없습니다. ${config}에 {"keyId": "…", "issuerId": "…"}를 적거나 APPLE_API_KEY·APPLE_API_ISSUER를 주세요`);
    ({ keyId, issuerId: issuer } = JSON.parse(fs.readFileSync(config, 'utf8')));
  }
  const keyPath = process.env.APPLE_API_KEY_PATH || path.join(asc, 'private_keys', `AuthKey_${keyId}.p8`);
  if (!fs.existsSync(keyPath)) fail(`공증 API 키 파일이 없습니다: ${keyPath}`);
  return {
    identity,
    keyId,
    issuer,
    keyPath,
    env: { APPLE_SIGNING_IDENTITY: identity, APPLE_API_KEY: keyId, APPLE_API_ISSUER: issuer, APPLE_API_KEY_PATH: keyPath },
  };
}

/** DMG를 서명·공증·스테이플한다. 받은 DMG를 열 때도, 인터넷이 없을 때도 경고 없이 열린다. */
function notarizeDmg(mac, dmg) {
  console.log('\n▶ DMG 서명·공증(Apple 확인에 몇 분 걸립니다)');
  run('codesign', ['--force', '--sign', mac.identity, '--timestamp', dmg], { stdio: 'inherit' });
  const submit = spawnSync(
    'xcrun',
    ['notarytool', 'submit', dmg, '--key', mac.keyPath, '--key-id', mac.keyId, '--issuer', mac.issuer, '--wait', '--output-format', 'json'],
    { encoding: 'utf8' },
  );
  let result = {};
  try {
    result = JSON.parse(submit.stdout);
  } catch {
    fail(`DMG 공증 요청이 실패했습니다:\n${submit.stdout}${submit.stderr}`);
  }
  if (result.status !== 'Accepted') {
    fail(`DMG 공증이 받아들여지지 않았습니다(${result.status}). 이유: xcrun notarytool log ${result.id} --key ${mac.keyPath} --key-id ${mac.keyId} --issuer ${mac.issuer}`);
  }
  run('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
}

/** 올리기 전에 Gatekeeper가 앱과 DMG를 "공증된 Developer ID"로 받아들이는지 본다. */
function checkGatekeeper(app, dmg) {
  const checks = [
    ['맥 앱', ['--assess', '--type', 'execute', '-vv', app]],
    ['맥 DMG', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg]],
  ];
  for (const [what, spctlArgs] of checks) {
    const r = spawnSync('spctl', spctlArgs, { encoding: 'utf8' });
    if (r.status !== 0 || !/source=Notarized Developer ID/.test(r.stderr)) fail(`${what}이 공증된 Developer ID로 확인되지 않습니다:\n${r.stderr}`);
  }
  const staple = spawnSync('xcrun', ['stapler', 'validate', dmg], { encoding: 'utf8' });
  if (staple.status !== 0) fail(`DMG에 공증 표가 붙지 않았습니다:\n${staple.stdout}${staple.stderr}`);
}
