import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApiHistoryFromConversation } from './src/services/session-api-history.js';
import {
  readWorktreeSession,
  restoreWorktreeContext,
  writeWorktreeSession,
} from './src/services/worktreeSessionService.js';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const root = await mkdtemp(join(tmpdir(), 'qwen-recovery-probe-'));

try {
  const repo = join(root, 'repo');
  const sidecarPath = join(root, 'session.worktree.json');
  const lostWorktree = join(repo, '.qwen', 'worktrees', 'lost-worktree');

  await writeWorktreeSession(sidecarPath, {
    slug: 'lost-worktree',
    worktreePath: lostWorktree,
    worktreeBranch: 'worktree-lost-worktree',
    originalCwd: repo,
    originalBranch: 'main',
    originalHeadCommit: 'a'.repeat(40),
  });

  const sidecarBefore = await readWorktreeSession(sidecarPath);
  const restoreResult = await restoreWorktreeContext(sidecarPath);
  const sidecarAfter = await readWorktreeSession(sidecarPath);

  const originalUser = {
    uuid: 'u1',
    type: 'user',
    message: { role: 'user', parts: [{ text: 'ORIGINAL_DETAIL' }] },
  };
  const originalModel = {
    uuid: 'a1',
    parentUuid: 'u1',
    type: 'assistant',
    message: { role: 'model', parts: [{ text: 'ORIGINAL_REPLY' }] },
  };
  const compression = {
    uuid: 'c1',
    parentUuid: 'a1',
    type: 'system',
    subtype: 'chat_compression',
    systemPayload: {
      info: {
        originalTokenCount: 100,
        newTokenCount: 40,
        compressionStatus: 'COMPRESSED',
      },
      compressedHistory: [
        {
          role: 'user',
          parts: [{ text: '<state_snapshot>SUMMARY_ONLY</state_snapshot>' }],
        },
        { role: 'model', parts: [{ text: 'Summary acknowledged.' }] },
      ],
    },
  };
  const postCompression = {
    uuid: 'u2',
    parentUuid: 'c1',
    type: 'user',
    message: { role: 'user', parts: [{ text: 'POST_COMPACTION_TAIL' }] },
  };

  const durableRecords = [originalUser, originalModel, compression, postCompression];
  const apiHistory = buildApiHistoryFromConversation({
    messages: durableRecords as never[],
  });
  const expectedApiHistory = [
    {
      role: 'user',
      parts: [{ text: '<state_snapshot>SUMMARY_ONLY</state_snapshot>' }],
    },
    { role: 'model', parts: [{ text: 'Summary acknowledged.' }] },
    { role: 'user', parts: [{ text: 'POST_COMPACTION_TAIL' }] },
  ];
  const apiHistoryText = JSON.stringify(apiHistory);

  const observation = {
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    lostWorktree: {
      worktreeExists: await exists(lostWorktree),
      sidecarExistedBefore: sidecarBefore !== null,
      restoreSession: restoreResult.session,
      restoreContextMessage: restoreResult.contextMessage,
      sidecarExistsAfter: sidecarAfter !== null,
    },
    compressedResumeProjection: {
      durableRecordCount: durableRecords.length,
      apiHistoryCount: apiHistory.length,
      apiHistory,
      preservesSummary: apiHistoryText.includes('SUMMARY_ONLY'),
      preservesPostCompressionTail: apiHistoryText.includes('POST_COMPACTION_TAIL'),
      exposesOriginalDetailToModel: apiHistoryText.includes('ORIGINAL_DETAIL'),
      exposesOriginalReplyToModel: apiHistoryText.includes('ORIGINAL_REPLY'),
    },
  };

  assert.deepEqual(observation.lostWorktree, {
    worktreeExists: false,
    sidecarExistedBefore: true,
    restoreSession: null,
    restoreContextMessage: null,
    sidecarExistsAfter: false,
  });
  assert.deepEqual(apiHistory, expectedApiHistory);
  assert.deepEqual(
    {
      durableRecordCount: observation.compressedResumeProjection.durableRecordCount,
      apiHistoryCount: observation.compressedResumeProjection.apiHistoryCount,
      preservesSummary: observation.compressedResumeProjection.preservesSummary,
      preservesPostCompressionTail:
        observation.compressedResumeProjection.preservesPostCompressionTail,
      exposesOriginalDetailToModel:
        observation.compressedResumeProjection.exposesOriginalDetailToModel,
      exposesOriginalReplyToModel:
        observation.compressedResumeProjection.exposesOriginalReplyToModel,
    },
    {
      durableRecordCount: 4,
      apiHistoryCount: 3,
      preservesSummary: true,
      preservesPostCompressionTail: true,
      exposesOriginalDetailToModel: false,
      exposesOriginalReplyToModel: false,
    },
  );

  console.log(JSON.stringify(observation, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
