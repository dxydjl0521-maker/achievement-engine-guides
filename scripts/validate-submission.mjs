import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gh, ghRepo, ghDownloadToFile, repository, validateSubmission } from './github.mjs';
import { assertAeguideSchema } from '../lib/validate.mjs';
import { inspectAeguideFile } from '../lib/validate-file.mjs';
import { validateImages } from './validate-images.mjs';

const number = Number(process.env.PR_NUMBER);
const head = process.env.PR_HEAD_SHA;
const appVersion = process.env.APP_VERSION;
if (!Number.isSafeInteger(number) || !/^[a-f0-9]{40}$/.test(head || '')
  || !/^\d+\.\d+\.\d+$/.test(appVersion || '')) throw new Error('PR context missing');
const pr = await gh('GET', `/pulls/${number}`);
if (!pr || pr.base.repo.full_name !== repository || pr.head.sha !== head
  || !/^submissions\/[a-f0-9-]{36}$/.test(pr.head.ref || ''))
  throw new Error('Unexpected PR source');
const sourceRepository = pr.head.repo?.full_name;
if (!/^[\w.-]+\/[\w.-]+$/.test(sourceRepository || '')
  || pr.head.repo.name !== repository.split('/')[1])
  throw new Error('PR must come from the official repository or its fork');
const sourceDetails = await ghRepo(sourceRepository, 'GET', '');
if (!sourceDetails || sourceRepository !== repository
  && (!sourceDetails.fork || sourceDetails.parent?.full_name !== repository))
  throw new Error('PR source is not a fork of the official repository');
const files = [];
for (let page = 1; page <= 30; page++) {
  const batch = await gh('GET', `/pulls/${number}/files?per_page=100&page=${page}`);
  if (!Array.isArray(batch)) throw new Error('PR file list unavailable');
  files.push(...batch);
  if (batch.length < 100) break;
}
const metadata = files.find((item) => /^submissions\/[a-f0-9-]{36}\.json$/.test(item.filename));
if (!metadata || metadata.status !== 'added') throw new Error('Submission metadata missing');
const response = await ghRepo(sourceRepository, 'GET', `/contents/${metadata.filename}?ref=${head}`);
if (!response || response.encoding !== 'base64') throw new Error('Submission file unavailable');
const record = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
validateSubmission(record);
assertAeguideSchema('manifest', record.manifest);
if (metadata.filename !== `submissions/${record.submissionId}.json`) throw new Error('Submission ID mismatch');
if (pr.head.ref !== `submissions/${record.submissionId}`
  || pr.user?.login?.toLowerCase() !== record.contributor.githubLogin.toLowerCase()
  || pr.head.repo.owner?.login?.toLowerCase() !== record.contributor.githubLogin.toLowerCase()
  || sourceRepository !== repository && record.assetRepository !== sourceRepository
  || record.assetRepository && record.assetRepository !== sourceRepository)
  throw new Error('Contributor, fork, and asset repository do not match');
const expected = new Set([metadata.filename, ...record.changeFiles.map((item) => item.path)]);
if (files.length !== expected.size || files.some((item) => item.status !== 'added' || !expected.has(item.filename)))
  throw new Error('PR contains unexpected files');
for (const unit of record.changeFiles) {
  const file = await ghRepo(sourceRepository, 'GET', `/contents/${unit.path}?ref=${head}`);
  if (!file || file.encoding !== 'base64') throw new Error('Contribution unit missing');
  const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== unit.sha256) throw new Error('Contribution unit hash mismatch');
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (!['chapter', 'achievement', 'layout', 'notes', 'categories'].includes(parsed.entityType)
    || typeof parsed.entityId !== 'string' || !Array.isArray(parsed.changes) || !parsed.changes.length
    || parsed.changes.some((change) => change.entityType !== parsed.entityType || change.entityId !== parsed.entityId
      || !['add', 'update', 'delete'].includes(change.operation) || typeof change.field !== 'string'))
    throw new Error('Contribution unit invalid');
}
const assetRepository = record.assetRepository || repository;
// A maintainer posting from the official repository keeps the source package
// in a draft Release. The read-only pull_request token cannot read drafts, so
// the publish workflow repeats full package validation with its write token
// before it makes the release or catalog entry public.
const packageValidationDeferred = record.assetRepository?.toLowerCase() === repository.toLowerCase();
if (packageValidationDeferred) {
  console.log('Official-repository draft package will be validated by the publish workflow');
} else {
  const release = await ghRepo(assetRepository, 'GET', `/releases/${record.draftReleaseId}`);
  const asset = release?.assets?.find((item) => item.id === record.assetId);
  const expectedTag = record.assetRepository ? `submission-${record.submissionId}`
    : `guide-${record.guideId}-v${record.version}`;
  const expectedName = record.assetName || `${record.guideId}-v${record.version}.aeguide`;
  if (!release || !asset || release.tag_name !== expectedTag || asset.name !== expectedName
    || record.assetRepository && (release.draft || !release.prerelease))
    throw new Error('Release asset does not match reviewed metadata');
  const directory = await mkdtemp(path.join(tmpdir(), 'ae-validate-'));
  try {
    const filePath = path.join(directory, 'submission.aeguide');
    const downloaded = await ghDownloadToFile(`/releases/assets/${asset.id}`, filePath,
      500_000_000, assetRepository);
    if (downloaded.size !== asset.size || downloaded.sha256 !== record.packageSha256)
      throw new Error('Release asset hash mismatch');
    const parsed = await inspectAeguideFile(filePath, appVersion);
    if (JSON.stringify(parsed.manifest) !== JSON.stringify(record.manifest))
      throw new Error('Release manifest differs from reviewed PR');
    await validateImages(filePath, parsed);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const summary = [
  '### 攻略投稿自动检查通过',
  `- 游戏：${record.manifest.game.title}`,
  `- 攻略：${record.manifest.guide.title} v${record.version}`,
  ...(packageValidationDeferred ? [] : [`- 图片：${record.manifest.assets.length} 张`]),
  `- 包 SHA-256：\`${record.packageSha256}\``,
  '',
  packageValidationDeferred
    ? '只读 PR 工作流无法访问主仓库的未发布草稿；完整攻略包、图片和摘要会在合并后由发布工作流校验，通过后才公开。请维护者继续人工审核。'
    : '工作流已校验包结构、作者身份、许可证、HTML 和完整资源哈希。请维护者人工审核并合并；合并后发布工作流会再次校验。',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}
console.log('Submission metadata passed');

