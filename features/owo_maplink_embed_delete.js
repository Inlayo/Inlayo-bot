const pendingMaps = new Map();

const EXPIRE_TIME = 60 * 1000;
const MAX_PENDING_MAPS_PER_CHANNEL = 10;
const OSU_BOT_ID = "289066747443675143";

const OSU_URL_REGEX =
  /https?:\/\/(?:www\.)?osu\.ppy\.sh\/(?:beatmaps?|beatmapsets|b|s)\/[^\s<>]+/gi;

const OSU_PATH_REGEX =
  /osu\.ppy\.sh\/(beatmaps?|beatmapsets|b|s)\/(\d+)/i;

const OSU_BEATMAP_FRAGMENT_REGEX =
  /#(?:osu|taiko|fruits|mania)\/(\d+)/i;

const SCREENSHOT_REGEX = /^screenshot\d*\.(?:png|jpg|jpeg)$/i;

function parseOsuUrl(url) {
  const match = url.match(OSU_PATH_REGEX);

  if (!match) {
    return {
      beatmapId: null,
      beatmapsetId: null,
    };
  }

  const [, rawType, id] = match;
  const type = rawType.toLowerCase();

  switch (type) {
    case "b":
    case "beatmap":
    case "beatmaps":
      return {
        beatmapId: id,
        beatmapsetId: null,
      };

    case "s":
    case "beatmapset":
    case "beatmapsets": {
      const fragmentMatch = url.match(OSU_BEATMAP_FRAGMENT_REGEX);

      return {
        beatmapId: fragmentMatch?.[1] ?? null,
        beatmapsetId: id,
      };
    }

    default:
      return {
        beatmapId: null,
        beatmapsetId: null,
      };
  }
}

function getEmbedText(embed) {
  const values = [
    embed.title,
    embed.description,
    embed.url,
    embed.author?.name,
    embed.author?.url,
    embed.footer?.text,
    ...(embed.fields ?? []).flatMap((field) => [
      field.name,
      field.value,
    ]),
  ];

  return values.filter(Boolean).join(" ");
}

function isOsuEmbed(message) {
  return (
    message.embeds?.some((embed) => {
      const text = getEmbedText(embed);

      return (
        /osu\.ppy\.sh/i.test(text) ||
        /\bbeatmaps?\b/i.test(text) ||
        /\bbeatmapset\b/i.test(text) ||
        /\bpp\b/i.test(text)
      );
    }) ?? false
  );
}

function getOsuIdsFromEmbed(message) {
  return (message.embeds ?? []).flatMap((embed) => {
    const text = getEmbedText(embed);

    const urls = text.match(OSU_URL_REGEX) ?? [];

    return urls.map(parseOsuUrl);
  });
}

function isScreenshotMessage(message) {
  return (
    message.attachments?.some(({ name = "" }) =>
      SCREENSHOT_REGEX.test(name)
    ) ?? false
  );
}

function cleanupPendingMaps() {
  const now = Date.now();

  for (const [channelId, entries] of pendingMaps) {
    const activeEntries = entries.filter(
      ({ createdAt }) => now - createdAt <= EXPIRE_TIME
    );

    if (activeEntries.length > 0) {
      pendingMaps.set(channelId, activeEntries);
    } else {
      pendingMaps.delete(channelId);
    }
  }
}

function mapsMatch(pending, embedIds) {
  if (pending.type === "screenshot") {
    return true;
  }

  if (embedIds.length === 0) {
    return false;
  }

  return embedIds.some(
    ({ beatmapId, beatmapsetId }) => {
      // 정확한 beatmap ID 매칭
      if (
        pending.beatmapId &&
        beatmapId &&
        pending.beatmapId === beatmapId
      ) {
        return true;
      }

      // beatmapset ID 매칭
      if (
        pending.beatmapsetId &&
        beatmapsetId &&
        pending.beatmapsetId === beatmapsetId
      ) {
        return true;
      }

      return false;
    }
  );
}

function addPendingEntries(channelId, entries) {
  const currentEntries = pendingMaps.get(channelId) ?? [];

  pendingMaps.set(
    channelId,
    [...currentEntries, ...entries].slice(
      -MAX_PENDING_MAPS_PER_CHANNEL
    )
  );
}

function createPendingEntry(message, type, ids = {}) {
  return {
    type,
    beatmapId: ids.beatmapId ?? null,
    beatmapsetId: ids.beatmapsetId ?? null,
    messageId: message.id,
    userId: message.author.id,
    createdAt: Date.now(),
  };
}

function rememberUserMaps(message) {
  const urls = message.content.match(OSU_URL_REGEX) ?? [];
  const entries = [];

  for (const url of urls) {
    const ids = parseOsuUrl(url);

    if (!ids.beatmapId && !ids.beatmapsetId) {
      continue;
    }

    entries.push(
      createPendingEntry(message, "url", ids)
    );
  }

  if (isScreenshotMessage(message)) {
    entries.push(
      createPendingEntry(message, "screenshot")
    );

    console.log(
      `${message.author.tag} uploaded an osu! screenshot.`
    );
  }

  if (entries.length === 0) {
    return false;
  }

  addPendingEntries(message.channel.id, entries);

  if (urls.length > 0) {
    console.log(
      `${message.author.tag} shared ${urls.join(", ")}.`
    );
  }

  return true;
}

function removePendingEntry(channelId, target) {
  const entries = pendingMaps.get(channelId) ?? [];

  const remaining = entries.filter(
    (entry) => entry !== target
  );

  if (remaining.length > 0) {
    pendingMaps.set(channelId, remaining);
  } else {
    pendingMaps.delete(channelId);
  }
}

function findMatchingPendingEntry(entries, embedIds) {
  // 1. 정확한 ID 매칭을 먼저 시도
  const exactMatch = [...entries]
    .reverse()
    .find((entry) => mapsMatch(entry, embedIds));

  if (exactMatch) {
    return exactMatch;
  }

  // 2. ID를 못 찾았거나 ID가 서로 다른 경우
  // 가장 오래된 pending을 fallback으로 사용
  //
  // osu embed가 여러 개 연속으로 생성되는 경우
  // 먼저 들어온 링크부터 처리하기 위한 방식
  return entries[0] ?? null;
}

async function handleOsuBotMessage(message) {
  if (!isOsuEmbed(message)) {
    return;
  }

  const channelId = message.channel.id;
  const entries = pendingMaps.get(channelId) ?? [];

  if (entries.length === 0) {
    console.log(
      `Received an osu! embed without a pending map: ${message.id}.`
    );
    return;
  }

  const embedIds = getOsuIdsFromEmbed(message);

  const pending = findMatchingPendingEntry(
    entries,
    embedIds
  );

  if (!pending) {
    return;
  }

  if (!message.deletable) {
    console.log(
      `Skipped osu! embed because the message is not deletable: ${message.id}.`
    );
    return;
  }

  try {
    await message.delete();

    removePendingEntry(
      channelId,
      pending
    );

    console.log(
      `Deleted osu! embed: ${message.id} (trigger: ${pending.type}).`
    );
  } catch (error) {
    console.error(
      `Failed to delete osu! embed ${message.id}:`,
      error
    );
  }
}

async function handleMessage(message) {
  if (
    !message.guild ||
    message.author.id === message.client.user.id
  ) {
    return;
  }

  cleanupPendingMaps();

  if (!message.author.bot) {
    rememberUserMaps(message);
    return;
  }

  if (message.author.id === OSU_BOT_ID) {
    await handleOsuBotMessage(message);
  }
}

module.exports = {
  handleMessage,
};