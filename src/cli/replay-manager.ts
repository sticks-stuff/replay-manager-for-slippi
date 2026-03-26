#!/usr/bin/env node

import { access, stat } from 'fs/promises';
import path from 'path';
import {
  StartggGame,
  StartggSet,
  Context,
  ContextPlayers,
  ContextScore,
  ContextSlot,
  Player,
  Replay,
  Id,
  Output,
} from '../common/types';
import {
  characterStartggIds,
  characterNames,
  isValidCharacter,
  stageNames,
  stageStartggIds,
  frameMsDivisor,
} from '../common/constants';
import { getReplaysByPaths, writeReplays } from '../main/replay';

function printUsageAndExit(exitCode: number): never {
  // eslint-disable-next-line no-console
  console.error(
    [
      'Usage:',
      '  replay-manager --event <event_id> --set <set_id> --left <disc> --right <disc> --replays <path1;path2;...> [--key <startgg_api_key>] [--out <directory>]',
      '',
      'You can also provide the API key via env var STARTGG_API_KEY.',
      'Writes a .zip to --out (defaults to the current working directory).',
    ].join('\n'),
  );
  process.exit(exitCode);
}

type CliArgs = {
  eventId: number;
  setId: string;
  leftDiscriminator: string;
  rightDiscriminator: string;
  replayPaths: string[];
  startggApiKey: string;
  outDir: string;
};

function getArgValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) {
    return undefined;
  }
  return argv[idx + 1];
}

function parseArgs(argv: string[]): CliArgs {
  const eventRaw = getArgValue(argv, '--event');
  const setId = getArgValue(argv, '--set');
  const leftDiscriminator = getArgValue(argv, '--left');
  const rightDiscriminator = getArgValue(argv, '--right');
  const replaysRaw = getArgValue(argv, '--replays');
  const outDir = getArgValue(argv, '--out') || process.cwd();
  const startggApiKey =
    getArgValue(argv, '--key') || process.env.STARTGG_API_KEY || '';

  if (!eventRaw || !setId || !leftDiscriminator || !rightDiscriminator || !replaysRaw) {
    printUsageAndExit(2);
  }

  const eventId = Number(eventRaw);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error(`--event must be a positive integer`);
  }

  const replayPaths = replaysRaw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  if (replayPaths.length === 0) {
    throw new Error('--replays must contain at least one .slp path');
  }

  return {
    eventId,
    setId,
    leftDiscriminator,
    rightDiscriminator,
    replayPaths,
    startggApiKey,
    outDir,
  };
}

async function wrappedFetch(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  let response: Response | undefined;
  try {
    response = await fetch(input, init);
  } catch {
    throw new Error('***You may not be connected to the internet***');
  }
  if (!response.ok) {
    if ([500, 502, 503, 504].includes(response.status)) {
      await new Promise((r) => setTimeout(r, 1000));
      const retryResponse = await fetch(input, init);
      if (!retryResponse.ok) {
        throw new Error(`${retryResponse.status} - ${retryResponse.statusText}`);
      }
      return retryResponse;
    }
    let keyErr = '';
    if (response.status === 400) {
      keyErr = ' ***start.gg API key invalid!***';
    } else if (response.status === 401) {
      keyErr = ' ***start.gg API key expired!***';
    }
    throw new Error(`${response.status} - ${response.statusText}.${keyErr}`);
  }
  return response;
}

async function fetchGql<TData>(key: string, query: string, variables: any) {
  const response = await wrappedFetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const message = json.errors[0].message as string;
    const retryMsg =
      message.startsWith('Set not found for id: preview') ||
      message.startsWith('An unknown error has occurred')
        ? '. Refresh the pool and try again.'
        : '';
    throw new Error(`${message}${retryMsg}`);
  }
  return json.data as TData;
}

type ApiSetParticipant = {
  id: number;
  gamerTag: string;
  prefix: string | null;
  player: {
    user: {
      genderPronoun: string | null;
      discriminator: string | null;
    } | null;
  } | null;
};

type ApiSet = {
  id: string | number;
  fullRoundText: string;
  round: number;
  event?: { id: number } | null;
  slots: {
    entrant: {
      id: number;
      name: string;
      participants: ApiSetParticipant[];
    } | null;
  }[];
};

type SetInfo = {
  setId: Id;
  eventId: number | null;
  entrant1Id: number;
  entrant2Id: number;
  entrant1Participants: ApiSetParticipant[];
  entrant2Participants: ApiSetParticipant[];
};

const GET_SET_QUERY = `
  query CliGetSet($setId: ID!) {
    set(id: $setId) {
      id
      fullRoundText
      round
      event { id }
      slots {
        entrant {
          id
          name
          participants {
            id
            gamerTag
            prefix
            player {
              user {
                genderPronoun
                discriminator
              }
            }
          }
        }
      }
    }
  }
`;

async function getSetInfo(key: string, setId: string): Promise<{ apiSet: ApiSet; info: SetInfo }> {
  const data = await fetchGql<{ set: ApiSet | null }>(key, GET_SET_QUERY, {
    setId,
  });
  if (!data.set) {
    throw new Error('Set not found');
  }

  const apiSet = data.set;
  const slots = apiSet.slots.filter((s) => s.entrant);
  if (slots.length !== 2) {
    throw new Error(`Expected exactly 2 populated slots, got ${slots.length}`);
  }
  const entrant1 = slots[0].entrant!;
  const entrant2 = slots[1].entrant!;

  const info: SetInfo = {
    setId: apiSet.id,
    eventId: apiSet.event?.id ?? null,
    entrant1Id: entrant1.id,
    entrant2Id: entrant2.id,
    entrant1Participants: Array.isArray(entrant1.participants) ? entrant1.participants : [],
    entrant2Participants: Array.isArray(entrant2.participants) ? entrant2.participants : [],
  };

  return { apiSet, info };
}

function isRealPlayer(player: Player) {
  return player.playerType === 0 || player.playerType === 1;
}

function minMaxPorts(players: Player[]) {
  const ports = players.filter(isRealPlayer).map((p) => p.port);
  if (ports.length !== 2) {
    throw new Error(`Expected 2 real players, got ${ports.length}`);
  }
  const leftPort = Math.min(...ports);
  const rightPort = Math.max(...ports);
  return { leftPort, rightPort };
}

function roundShortFromFullRoundText(fullRoundText: string): string {
  let roundShort = '';
  const regex = /([A-Z]|[0-9])/g;
  let regexRes = regex.exec(fullRoundText);
  while (regexRes) {
    roundShort += regexRes[0];
    regexRes = regex.exec(fullRoundText);
  }
  return roundShort;
}

function playerDisplayName(player: Player): string {
  return player.playerOverrides.displayName || player.displayName || '';
}

function playerCharName(player: Player): string {
  return characterNames.get(player.externalCharacterId) || '';
}

function singlePlayerCharsLabel(displayName: string, characters: string[]): string {
  const uniqueChars = [...new Set(characters.filter(Boolean))];
  if (uniqueChars.length === 0) {
    return displayName;
  }
  return `${displayName} (${uniqueChars.join(', ')})`;
}

function playersCharsForReplay(replay: Replay): string {
  const { leftPort, rightPort } = minMaxPorts(replay.players);
  const leftPlayer = replay.players[leftPort - 1];
  const rightPlayer = replay.players[rightPort - 1];
  const leftName = playerDisplayName(leftPlayer);
  const rightName = playerDisplayName(rightPlayer);
  const leftChar = playerCharName(leftPlayer);
  const rightChar = playerCharName(rightPlayer);
  return `${singlePlayerCharsLabel(leftName, [leftChar])} vs ${singlePlayerCharsLabel(rightName, [rightChar])}`;
}

function buildZipSubdir(apiSet: ApiSet, setInfo: SetInfo, replays: Replay[]): string {
  const roundShort = roundShortFromFullRoundText(apiSet.fullRoundText);

  const entrantIdToName = new Map<Id, string>();
  replays[0].players
    .filter(isRealPlayer)
    .forEach((p) => {
      if (p.playerOverrides.entrantId) {
        entrantIdToName.set(p.playerOverrides.entrantId, playerDisplayName(p));
      }
    });

  const entrantIdToChars = new Map<Id, string[]>();
  [setInfo.entrant1Id, setInfo.entrant2Id].forEach((id) => entrantIdToChars.set(id, []));
  replays.forEach((replay) => {
    replay.players
      .filter((p) => isRealPlayer(p) && p.playerOverrides.entrantId && isValidCharacter(p.externalCharacterId))
      .forEach((p) => {
        const entrantId = p.playerOverrides.entrantId;
        if (!entrantIdToChars.has(entrantId)) {
          entrantIdToChars.set(entrantId, []);
        }
        entrantIdToChars.get(entrantId)!.push(playerCharName(p));
      });
  });

  const entrant1Name = entrantIdToName.get(setInfo.entrant1Id) || `Entrant ${setInfo.entrant1Id}`;
  const entrant2Name = entrantIdToName.get(setInfo.entrant2Id) || `Entrant ${setInfo.entrant2Id}`;
  const entrant1Chars = entrantIdToChars.get(setInfo.entrant1Id) || [];
  const entrant2Chars = entrantIdToChars.get(setInfo.entrant2Id) || [];

  const playersChars = `${singlePlayerCharsLabel(entrant1Name, entrant1Chars)} vs ${singlePlayerCharsLabel(entrant2Name, entrant2Chars)}`;

  // Matches the default GUI folder format roughly: "{phaseOrEvent} {roundShort} - {playersChars}".
  // We don't have phase/event chain here, so omit it.
  const subdir = `${roundShort} - ${playersChars}`.trim();
  return subdir || `Set ${apiSet.id}`;
}

function participantDiscriminator(p: ApiSetParticipant): string {
  const disc = p.player?.user?.discriminator;
  return disc ? String(disc) : '';
}

function findParticipantByDiscriminator(
  participants: ApiSetParticipant[],
  discriminator: string,
): ApiSetParticipant | undefined {
  return participants.find((p) => participantDiscriminator(p) === discriminator);
}

function getScoresAndWinnerId(replays: Replay[]) {
  let gameCount = 0;
  const gameWins = new Map<Id, number>();
  let leaderId: Id = 0;
  let leaderWins = 0;

  replays.forEach((replay) => {
    const winnerEntrantId = replay.players
      .filter(isRealPlayer)
      .find((p) => p.isWinner)?.playerOverrides.entrantId;
    if (!winnerEntrantId) {
      return;
    }

    const n = (gameWins.get(winnerEntrantId) || 0) + 1;
    if (n > leaderWins) {
      leaderWins = n;
      leaderId = winnerEntrantId;
    }
    gameCount += 1;
    gameWins.set(winnerEntrantId, n);
  });

  return {
    scores: gameWins,
    winnerId: gameCount > 0 && leaderWins / gameCount > 0.5 ? leaderId : 0,
  };
}

function applyLeftRightOverrides(
  replay: Replay,
  leftOverride: {
    displayName: string;
    entrantId: number;
    participantId: number;
    prefix: string;
    pronouns: string;
  },
  rightOverride: {
    displayName: string;
    entrantId: number;
    participantId: number;
    prefix: string;
    pronouns: string;
  },
) {
  const { leftPort, rightPort } = minMaxPorts(replay.players);
  replay.players[leftPort - 1].playerOverrides = { ...leftOverride };
  replay.players[rightPort - 1].playerOverrides = { ...rightOverride };
}

function buildStartggSet(
  setInfo: SetInfo,
  replays: Replay[],
): StartggSet {
  const gameData: StartggGame[] = [];

  replays.forEach((replay, i) => {
    const realPlayers = replay.players.filter(isRealPlayer);
    if (realPlayers.length !== 2) {
      throw new Error(`Game ${i + 1} does not have 2 real players`);
    }

    const winner = realPlayers.find((p) => p.isWinner);
    if (!winner && !replay.timeout) {
      throw new Error(`Game ${i + 1} does not have a winner`);
    }
    if (!realPlayers.every((p) => p.playerOverrides.entrantId && p.playerOverrides.participantId)) {
      throw new Error(`Game ${i + 1} does not have all players assigned`);
    }

    const participantIdToSelection = new Map<Id, { characterId: number; entrantId: Id }>();
    const validPlayers = replay.players.filter(
      (p) => isRealPlayer(p) && isValidCharacter(p.externalCharacterId),
    );

    validPlayers.forEach((player) => {
      participantIdToSelection.set(player.playerOverrides.participantId, {
        characterId: characterStartggIds.get(player.externalCharacterId)!,
        entrantId: player.playerOverrides.entrantId,
      });
    });

    const entrant1Participant = setInfo.entrant1Participants[0];
    const entrant2Participant = setInfo.entrant2Participants[0];
    if (!entrant1Participant || !entrant2Participant) {
      throw new Error('Set participants missing (expected singles)');
    }

    const smuggleCostumeIndex = true;
    const entrant1Player = realPlayers.find(
      (p) => p.playerOverrides.entrantId === setInfo.entrant1Id,
    );
    const entrant2Player = realPlayers.find(
      (p) => p.playerOverrides.entrantId === setInfo.entrant2Id,
    );
    if (!entrant1Player || !entrant2Player) {
      throw new Error(`Game ${i + 1} does not have both entrants assigned`);
    }

    const encodeScore = (p: Player) => {
      const stocks = p.stocksRemaining >= 0 ? p.stocksRemaining : 0;
      const costumeOffset = smuggleCostumeIndex ? (p.costumeIndex + 1) * 100 : 0;
      return Math.max(0, costumeOffset + stocks);
    };

    const entrant1Score = encodeScore(entrant1Player);
    const entrant2Score = encodeScore(entrant2Player);

    gameData.push({
      entrant1Score,
      entrant2Score,
      gameNum: i + 1,
      stageId: stageStartggIds.get(replay.stageId),
      selections: [
        participantIdToSelection.get(entrant1Participant.id)!,
        participantIdToSelection.get(entrant2Participant.id)!,
      ],
      winnerId: (winner?.playerOverrides.entrantId as number) || 0,
    });
  });

  const { winnerId } = getScoresAndWinnerId(replays);

  return {
    setId: setInfo.setId,
    winnerId,
    isDQ: false,
    gameData,
  };
}

const GQL_SET_INNER = `
  id
`;

const REPORT_BRACKET_SET_MUTATION = `
  mutation CliReportBracketSet($setId: ID!, $winnerId: ID, $isDQ: Boolean, $gameData: [BracketSetGameDataInput]) {
    reportBracketSet(setId: $setId, isDQ: $isDQ, winnerId: $winnerId, gameData: $gameData) {${GQL_SET_INNER}}
  }
`;

const UPDATE_BRACKET_SET_MUTATION = `
  mutation CliUpdateBracketSet($setId: ID!, $winnerId: ID, $isDQ: Boolean, $gameData: [BracketSetGameDataInput]) {
    updateBracketSet(setId: $setId, isDQ: $isDQ, winnerId: $winnerId, gameData: $gameData) {${GQL_SET_INNER}}
  }
`;

async function reportToStartgg(key: string, startggSet: StartggSet) {
  try {
    await fetchGql<any>(key, REPORT_BRACKET_SET_MUTATION, startggSet);
  } catch (e: any) {
    if (e instanceof Error && e.message === 'Cannot report completed set via API.') {
      if (startggSet.gameData.length > 0) {
        await fetchGql<any>(key, UPDATE_BRACKET_SET_MUTATION, startggSet);
        return;
      }
    }
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await Promise.all(
    args.replayPaths.map(async (p) => {
      try {
        await access(p);
      } catch {
        throw new Error(`Replay not found: ${p}`);
      }
    }),
  );

  try {
    const st = await stat(args.outDir);
    if (!st.isDirectory()) {
      throw new Error();
    }
  } catch {
    throw new Error(`--out must be an existing directory: ${args.outDir}`);
  }

  if (!args.startggApiKey) {
    throw new Error('Missing start.gg API key: pass --key or set STARTGG_API_KEY');
  }

  const { replays, invalidReplays } = await getReplaysByPaths(args.replayPaths);
  if (invalidReplays.length > 0) {
    const msg = invalidReplays
      .map((r) => `${r.fileName}: ${(r as any).invalidReason}`)
      .join('\n');
    throw new Error(`Some replays failed to parse:\n${msg}`);
  }

  const { apiSet, info: setInfo } = await getSetInfo(args.startggApiKey, args.setId);
  if (setInfo.eventId && setInfo.eventId !== args.eventId) {
    // eslint-disable-next-line no-console
    console.warn(
      `Warning: --event ${args.eventId} does not match set's event ${setInfo.eventId}`,
    );
  }

  // only singles rn
  if (setInfo.entrant1Participants.length !== 1 || setInfo.entrant2Participants.length !== 1) {
    throw new Error(
      `Expected singles (1 participant per entrant). Got entrant1=${setInfo.entrant1Participants.length}, entrant2=${setInfo.entrant2Participants.length}`,
    );
  }

  const allParticipants = [
    ...setInfo.entrant1Participants.map((p) => ({ entrantId: setInfo.entrant1Id, p })),
    ...setInfo.entrant2Participants.map((p) => ({ entrantId: setInfo.entrant2Id, p })),
  ];

  const leftMatch = allParticipants.find(
    ({ p }) => participantDiscriminator(p) === args.leftDiscriminator,
  );
  const rightMatch = allParticipants.find(
    ({ p }) => participantDiscriminator(p) === args.rightDiscriminator,
  );

  if (!leftMatch) {
    throw new Error(`Could not find left discriminator in set participants: ${args.leftDiscriminator}`);
  }
  if (!rightMatch) {
    throw new Error(`Could not find right discriminator in set participants: ${args.rightDiscriminator}`);
  }

  const leftOverride = {
    displayName: leftMatch.p.gamerTag,
    entrantId: leftMatch.entrantId,
    participantId: leftMatch.p.id,
    prefix: leftMatch.p.prefix || '',
    pronouns: leftMatch.p.player?.user?.genderPronoun || '',
  };
  const rightOverride = {
    displayName: rightMatch.p.gamerTag,
    entrantId: rightMatch.entrantId,
    participantId: rightMatch.p.id,
    prefix: rightMatch.p.prefix || '',
    pronouns: rightMatch.p.player?.user?.genderPronoun || '',
  };

  replays.forEach((replay) => {
    applyLeftRightOverrides(replay, leftOverride, rightOverride);
  });

  const writeDir = args.outDir;
  const subdir = buildZipSubdir(apiSet, setInfo, replays);
  const fileNameFormat = ' - {playersChars} - {stage}';
  const fileNames = replays.map((replay, i) => {
    let fileName = `{ordinal}${fileNameFormat}`;
    fileName = fileName.replace('{playersChars}', playersCharsForReplay(replay));
    fileName = fileName.replace('{stage}', stageNames.get(replay.stageId) || '');
    fileName = fileName.replace('{ordinal}', (i + 1).toString(10));
    return `${fileName}.slp`;
  });

  const context = (() => {
    const gameScores = [0, 0];
    const scores: ContextScore[] = [];
    const { leftPort, rightPort } = minMaxPorts(replays[0].players);
    replays.forEach((replay) => {
      const left = replay.players[leftPort - 1];
      const right = replay.players[rightPort - 1];
      const slots: [ContextSlot, ContextSlot] = [
        {
          displayNames: [playerDisplayName(left)],
          ports: [left.port],
          prefixes: [left.playerOverrides.prefix],
          pronouns: [left.playerOverrides.pronouns],
          score: gameScores[0],
        },
        {
          displayNames: [playerDisplayName(right)],
          ports: [right.port],
          prefixes: [right.playerOverrides.prefix],
          pronouns: [right.playerOverrides.pronouns],
          score: gameScores[1],
        },
      ];

      if (left.isWinner) {
        gameScores[0] += 1;
      } else if (right.isWinner) {
        gameScores[1] += 1;
      }
      scores.push({ slots });
    });

    const lastScore = scores[scores.length - 1];
    if (!lastScore) {
      return undefined;
    }

    const finalScore: ContextScore = {
      slots: [
        {
          ...lastScore.slots[0],
          score: gameScores[0],
        },
        {
          ...lastScore.slots[1],
          score: gameScores[1],
        },
      ],
    };

    const entrantIdToName = new Map<Id, string>();
    replays[0].players
      .filter(isRealPlayer)
      .forEach((p) => {
        if (p.playerOverrides.entrantId) {
          entrantIdToName.set(p.playerOverrides.entrantId, playerDisplayName(p));
        }
      });

    const entrantIdToChars = new Map<Id, string[]>();
    [setInfo.entrant1Id, setInfo.entrant2Id].forEach((id) => entrantIdToChars.set(id, []));
    replays.forEach((replay) => {
      replay.players
        .filter((p) => isRealPlayer(p) && p.playerOverrides.entrantId && isValidCharacter(p.externalCharacterId))
        .forEach((p) => {
          const entrantId = p.playerOverrides.entrantId;
          if (!entrantIdToChars.has(entrantId)) {
            entrantIdToChars.set(entrantId, []);
          }
          entrantIdToChars.get(entrantId)!.push(playerCharName(p));
        });
    });

    const contextPlayers: ContextPlayers = {
      entrant1: [
        {
          name: entrantIdToName.get(setInfo.entrant1Id) || `Entrant ${setInfo.entrant1Id}`,
          characters: [...new Set((entrantIdToChars.get(setInfo.entrant1Id) || []).filter(Boolean))],
        },
      ],
      entrant2: [
        {
          name: entrantIdToName.get(setInfo.entrant2Id) || `Entrant ${setInfo.entrant2Id}`,
          characters: [...new Set((entrantIdToChars.get(setInfo.entrant2Id) || []).filter(Boolean))],
        },
      ],
    };

    const durationMs = replays
      .map((replay) => Math.ceil((replay.lastFrame + 124) / frameMsDivisor))
      .reduce((prev, curr) => prev + curr, 0);

    const contextObj: Context = {
      bestOf: Math.max(gameScores[0], gameScores[1]) * 2 - 1,
      durationMs,
      scores,
      finalScore,
      players: contextPlayers,
      startMs: replays[0].startAt.getTime(),
    };
    return contextObj;
  })();

  await writeReplays(
    writeDir,
    { address: '', name: '' },
    fileNames,
    Output.ZIP,
    replays,
    [],
    subdir,
    true,
    context,
  );

  const startggSet = buildStartggSet(setInfo, replays);
  await reportToStartgg(args.startggApiKey, startggSet);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        setId: startggSet.setId,
        winnerId: startggSet.winnerId,
        games: startggSet.gameData.length,
        replayFiles: replays.map((r) => path.basename(r.filePath)),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
