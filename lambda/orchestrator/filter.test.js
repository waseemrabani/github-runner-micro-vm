'use strict';

// Run with `node --test` from lambda/orchestrator. Not packaged into the
// Lambda zip (scripts/02-package-lambdas.sh lists files explicitly).

const test = require('node:test');
const assert = require('node:assert/strict');
const { profileLabel, resolveProfile, elapsedMs } = require('./filter');
const { dimensionSets } = require('./metrics');

const PREFIX = 'mvm';
const PROFILES = ['arm64-medium', 'x64-medium', 'arm64-docker-medium', 'x64-docker-medium'];
const route = (labels) => resolveProfile(labels, PREFIX, PROFILES);

// GitHub gives a queued job to any idle runner whose labels include all of the
// job's labels. The worker registers every runner as [self-hosted, <label>].
const runnerLabels = (profile) => ['self-hosted', profileLabel(PREFIX, profile)];
const canTake = (runner, jobLabels) => jobLabels.every((l) => runner.includes(l.toLowerCase()));

test('a job with one profile label routes to that profile', () => {
  const r = route(['self-hosted', 'mvm-x64-docker-medium']);
  assert.deepEqual([r.ours, r.ok, r.profile, r.label], [true, true, 'x64-docker-medium', 'mvm-x64-docker-medium']);
  assert.equal(route(['mvm-arm64-medium']).profile, 'arm64-medium'); // self-hosted is optional
});

test('labels match case-insensitively, like GitHub', () => {
  assert.equal(route(['Self-Hosted', 'MVM-X64-Medium']).profile, 'x64-medium');
});

test('a profile is not confused with a longer one that shares its prefix', () => {
  assert.equal(route(['mvm-arm64-docker-medium']).profile, 'arm64-docker-medium');
});

test('jobs without any mvm-* label are not ours and are ignored', () => {
  assert.deepEqual(route(['ubuntu-latest']), { ours: false });
  assert.deepEqual(route(['self-hosted', 'linux']), { ours: false });
});

test('legacy lambda-microvms labels are rejected with a pointer to the new label', () => {
  for (const labels of [['self-hosted', 'lambda-microvms'], ['self-hosted', 'lambda-microvms', 'arm64-medium']]) {
    const r = route(labels);
    assert.deepEqual([r.ours, r.ok], [true, false]);
    assert.match(r.reason, /no longer used/);
    assert.match(r.reason, /mvm-arm64-medium/);
  }
});

test('bare prefix, unknown or undeployed profiles are rejected', () => {
  for (const labels of [['mvm'], ['mvm-x64-docker-large'], ['mvm-arm64-medum']]) {
    const r = route(labels);
    assert.deepEqual([r.ours, r.ok], [true, false]);
    assert.match(r.reason, /not a deployed runner profile/);
  }
});

test('two profile labels are rejected', () => {
  const r = route(['mvm-arm64-medium', 'mvm-x64-medium']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /more than one/);
});

test('any extra label besides self-hosted is rejected - no runner would carry it', () => {
  for (const extra of ['linux', 'docker', 'lambda-microvms', 'gpu']) {
    const r = route(['self-hosted', 'mvm-x64-medium', extra]);
    assert.equal(r.ok, false, extra);
    assert.match(r.reason, /not allowed/);
  }
});

test('every accepted job can only be taken by runners of its own profile', () => {
  for (const jobProfile of PROFILES) {
    const jobLabels = ['self-hosted', profileLabel(PREFIX, jobProfile)];
    assert.equal(route(jobLabels).ok, true);
    for (const runnerProfile of PROFILES) {
      assert.equal(canTake(runnerLabels(runnerProfile), jobLabels), runnerProfile === jobProfile, `${jobProfile} on ${runnerProfile}`);
    }
  }
});

test('regression: a bare [self-hosted, lambda-microvms] job can no longer take a runner', () => {
  // This job took the arm64-docker runner launched for another job when runners
  // were registered with the job's own labels (which included lambda-microvms).
  const bare = ['self-hosted', 'lambda-microvms'];
  for (const p of PROFILES) assert.equal(canTake(runnerLabels(p), bare), false, p);
});

test('elapsedMs handles missing, unparseable and negative intervals', () => {
  assert.equal(elapsedMs('2026-11-08T10:00:00Z', '2026-11-08T10:00:42Z'), 42_000);
  assert.equal(elapsedMs(undefined, '2026-11-08T10:00:42Z'), undefined);
  assert.equal(elapsedMs('garbage', '2026-11-08T10:00:42Z'), undefined);
  assert.equal(elapsedMs('2026-11-08T10:00:42Z', '2026-11-08T10:00:00Z'), undefined);
});

test('dimensionSets adds per-dimension and fleet-wide rollups', () => {
  assert.deepEqual(dimensionSets([]), [[]]);
  assert.deepEqual(dimensionSets(['Profile']), [['Profile'], []]);
  assert.deepEqual(dimensionSets(['Profile', 'Conclusion']), [['Profile', 'Conclusion'], ['Profile'], ['Conclusion'], []]);
});
