import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gh, ghDownloadToFile, validateSubmission } from './github.mjs';
import { assertAeguideSchema } from '../lib/validate.mjs';
import { inspectAeguideFile } from '../lib/validate-file.mjs';

const sha = process.env.GH_SHA;
const before = process.env.GH_BEFORE;
const appVersion = process.env.APP_VERSION;
let submissionId = process.env.SUBMISSION_ID;
const workflowRunId = process.env.WORKFLOW_RUN_ID;
// The merge closed this exact owner-contributed PR before independent approval could be recorded.
const recoveryReason = (process.env.RECOVERY_REASON || '').replace(/\s+/g, ' ').trim();
const recoveryActor = (process.env.WORKFLOW_ACTOR || '').toLowerCase();
const recoveryRequestValid = process.env.WORKFLOW_EVENT_NAME === 'workflow_dispatch'
  && submissionId === '3658cd45-359b-4757-b553-acbb2640e950'
  && recoveryActor === 'dxydjl0521-maker'
  && recoveryReason.length >= 20 && recoveryReason.length <= 500;
if (recoveryReason && !recoveryRequestValid)
  throw new Error('Recovery override is restricted to the designated owner and submission');
if (!/^\d+\.\d+\.\d+$/.test(appVersion || '') || !/^[a-f0-9]{40}$/.test(sha || ''))
  throw new Error('GUIDE_APP_VERSION or commit SHA missing');

if (workflowRunId) {
  if (!/^\d+$/.test(workflowRunId)) throw new Error('Invalid validation workflow run ID');
  const run = await gh('GET', `/actions/runs/${workflowRunId}`);
  if (!run || run.name !== 'Validate guide submission' || run.event !== 'pull_request' || run.conclusion !== 'success')
    throw new Error('Submission validation workflow did not succeed');
  const match = /^submissions\/([a-f0-9-]{36})$/.exec(run.head_branch || '');
  if (!match) throw new Error('Validation run is not linked to a submission PR');
  submissionId = match[1];
}

let changedFiles;
if (submissionId) {
  if (!/^[a-f0-9-]{36}$/.test(submissionId)) throw new Error('Invalid submission ID');
  changedFiles = [`submissions/${submissionId}.json`];
} else {
  if (!/^[a-f0-9]{40}$/.test(before || '')) throw new Error('Previous commit SHA missing');
  changedFiles = execFileSync('git', ['diff', '--name-only', before, sha, '--', 'submissions'], { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
}
const files = changedFiles.filter((name) => /^submissions\/[a-f0-9-]{36}\.json$/.test(name));
if (!files.length)
  throw new Error('No valid submission metadata to publish');
const expectedUnits = new Set();

const records = files.map((filename) => ({ filename, record: JSON.parse(readFileSync(filename, 'utf8')) }));
for (const { filename, record } of records) {
  validateSubmission(record);
  assertAeguideSchema('manifest', record.manifest);
  if (filename !== `submissions/${record.submissionId}.json`) throw new Error('Submission ID mismatch');
  for (const unit of record.changeFiles) {
    expectedUnits.add(unit.path);
    const bytes = readFileSync(unit.path);
    if (createHash('sha256').update(bytes).digest('hex') !== unit.sha256)
      throw new Error(`Contribution unit hash mismatch: ${unit.path}`);
  }
}
if (!submissionId && changedFiles.some((name) => !files.includes(name) && !expectedUnits.has(name)))
  throw new Error('Merge changed an unexpected submission file');

for (const { filename, record } of records) {
  const fileCommit = execFileSync('git', ['log', '-1', '--format=%H', '--', filename], { encoding: 'utf8' }).trim();
  const linked = await gh('GET', `/commits/${fileCommit}/pulls`);
  const pr = linked?.find((item) => item.merged_at && item.base.ref === 'main' && item.head.ref === `submissions/${record.submissionId}`);
  if (!pr) throw new Error('Submission was not merged from its validated PR');
  const validation = await gh('GET', `/actions/workflows/validate-guide.yml/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&per_page=100`);
  if (!validation?.workflow_runs?.some((run) => run.name === 'Validate guide submission'
    && run.event === 'pull_request' && run.conclusion === 'success'
    && run.head_branch === pr.head.ref && run.head_sha === pr.head.sha))
    throw new Error('Final PR revision has no successful validation run');
  const maintainers = new Set((process.env.GUIDE_MAINTAINERS || '').split(',').map((login) => login.trim().toLowerCase()).filter(Boolean));
  if (!maintainers.size) throw new Error('GUIDE_MAINTAINERS must list authorized reviewers');
  const reviews = await gh('GET', `/pulls/${pr.number}/reviews?per_page=100`);
  if (!Array.isArray(reviews)) throw new Error('PR reviews unavailable');
  const latestReviewByUser = new Map();
  for (const review of reviews) if (review.user?.login) latestReviewByUser.set(review.user.login.toLowerCase(), review);
  const approved = [...latestReviewByUser].some(([login, review]) => maintainers.has(login)
    && login !== record.contributor.githubLogin.toLowerCase()
    && review.state === 'APPROVED' && review.commit_id === pr.head.sha);
  // Pin the exception to immutable PR refs, the owner identity, and the reviewed package digest.
  const ownerRecovery = recoveryRequestValid && records.length === 1
    && record.submissionId === '3658cd45-359b-4757-b553-acbb2640e950'
    && record.guideId === '877ad385-1c9e-4f3b-929a-2c915a193df9'
    && record.version === '1.0.0'
    && record.packageSha256 === 'e584629c51c5551e36446989d1a579c1f4a9db54a19eec60d65113587075267c'
    && record.contributor.githubLogin.toLowerCase() === 'dxydjl0521-maker'
    && pr.number === 18
    && pr.head.sha === 'b3e66436173c41f0e4ad3a71957c3ea379f2a2bc'
    && pr.merge_commit_sha === '06a32a0fded9e2b1f9e0f3e1ffdfd9e4a995774b';
  if (recoveryRequestValid && !ownerRecovery)
    throw new Error('Recovery request does not match the fixed incident record');
  if (!approved && !ownerRecovery)
    throw new Error('A separate authorized maintainer must approve the contribution');
  if (ownerRecovery) {
    const audit = {
      event: 'one-time-owner-recovery',
      actor: recoveryActor,
      submissionId: record.submissionId,
      guideId: record.guideId,
      version: record.version,
      packageSha256: record.packageSha256,
      reason: recoveryReason,
    };
    console.log(JSON.stringify(audit));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### One-time owner recovery\n- Actor: ${recoveryActor}\n- Submission: ${record.submissionId}\n- Package SHA-256: ${record.packageSha256}\n- Reason: ${recoveryReason}\n\n`);
    }
  }

  const release = await gh('GET', `/releases/${record.draftReleaseId}`);
  const asset = release?.assets?.find((item) => item.id === record.assetId);
  if (!release || !asset || release.tag_name !== `guide-${record.guideId}-v${record.version}`
    || asset.name !== `${record.guideId}-v${record.version}.aeguide`) throw new Error('Draft release asset mismatch');
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'ae-publish-'));
  try {
    const packagePath = path.join(tempDirectory, 'submission.aeguide');
    const downloaded = await ghDownloadToFile(`/releases/assets/${record.assetId}`, packagePath, 500_000_000);
    if (downloaded.size !== asset.size || downloaded.sha256 !== record.packageSha256)
      throw new Error('Release asset SHA-256 mismatch');
    const parsed = await inspectAeguideFile(packagePath, appVersion);
    if (JSON.stringify(parsed.manifest) !== JSON.stringify(record.manifest))
      throw new Error('Manifest differs from reviewed PR');
  } finally { await rm(tempDirectory, { recursive: true, force: true }); }

  const catalogFile = await gh('GET', '/contents/catalog/index.json?ref=main');
  if (!catalogFile || catalogFile.encoding !== 'base64') throw new Error('Catalog unavailable');
  const catalog = JSON.parse(Buffer.from(catalogFile.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) throw new Error('Catalog schema invalid');
  const sameScope = catalog.entries.filter((item) => item.game.platform === record.manifest.game.platform
    && item.game.platformGameId === record.manifest.game.platformGameId
    && item.guide.language === record.manifest.guide.language);
  // Separate guide IDs are independent series and may coexist for one game and language.
  const versions = sameScope.filter((item) => item.guideId === record.guideId)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const prior = catalog.entries.find((item) => item.guideId === record.guideId && item.version === record.version);
  if (prior && prior.sha256 !== record.packageSha256) throw new Error('Catalog version conflict');
  if (!prior && versions.length && versions[0].sha256 !== record.baseRevision)
    throw new Error('Community guide advanced after this PR was reviewed');
  if (!prior && !versions.length && record.baseRevision !== null)
    throw new Error('Community base revision is not published');
  if (release.draft) await gh('PATCH', `/releases/${release.id}`, { draft: false, prerelease: false, make_latest: 'false' });
  if (!prior) {
    catalog.entries.push({
      guideId: record.guideId, version: record.version, game: record.manifest.game,
      guide: record.manifest.guide, author: record.manifest.author, license: record.manifest.license,
      minAppVersion: record.manifest.compatibility.minAppVersion,
      sha256: record.packageSha256, releaseId: release.id, assetId: asset.id,
      publishedAt: new Date().toISOString(),
    });
    await gh('PUT', '/contents/catalog/index.json', {
      message: `Publish guide ${record.guideId} v${record.version}`,
      content: Buffer.from(JSON.stringify(catalog, null, 2) + '\n').toString('base64'),
      sha: catalogFile.sha, branch: 'main',
    });
  }
  console.log(`Published ${record.guideId} v${record.version}`);
}
