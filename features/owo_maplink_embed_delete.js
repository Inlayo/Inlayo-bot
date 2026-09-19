const pendingMaps = new Map();

const EXPIRE_TIME = 30 * 1000;
const MAX_PENDING_MAPS_PER_CHANNEL = 10;
const OSU_BOT_ID = "289066747443675143";

const OSU_URL_REGEX =
  /https?:\/\/(?:www\.)?osu\.ppy\.sh\/(?:beatmaps?|beatmapsets)\/[^\s<>]+/gi;

const OSU_PATH_REGEX =
  /osu\.ppy\.sh\/(beatmaps?|beatmapsets)\/(\d+)/i;

const SCREENSHOT_REGEX =
  /^screenshot\d*\.(?:png|jpg|jpeg)$/i;

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

  if (type === "beatmap" || type === "beatmaps") {
    return {
      beatmapId: id,
      beatmapsetId: null,
    };
  }

  if (type === "beatmapsets") {
    return {
      beatmapId: null,
      beatmapsetId: id,
    };
  }

  return {
    beatmapId: null,
    beatmapsetId: null,
  };
}

function getEmbedText(embed) {
  const values = [
    embed.title,
    embed.description,
    embed.url,
    embed.author?.name,
    embed.author?.url,
    embed.footer?.text,
  ];

  for (const field of embed.fields ?? []) {
    values.push(field.name, field.value);
  }

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

function cleanupPendingMaps() {
  const now = Date.now();

  for (const [channelId, entries] of pendingMaps) {
    const active = entries.filter(
      (entry) => now - entry.createdAt <= EXPIRE_TIME,
    );

    if (active.length === 0) {
      pendingMaps.delete(channelId);
      continue;
    }

    pendingMaps.set(channelId, active);
  }
}

function mapsMatch(pending, embedIds) {
  // 스크린샷은 embed에 URL이 없을 수도 있으므로
  // 별도의 screenshot 타입으로 바로 매칭한다.
  if (pending.type === "screenshot") {
    return true;
  }

  // URL이 embed 안에 없는 경우
  if (embedIds.length === 0) {
    return true;
  }

  return embedIds.some(({ beatmapId, beatmapsetId }) => {
    return (
      (pending.beatmapId &&
        beatmapId &&
        pending.beatmapId === beatmapId) ||
      (pending.beatmapsetId &&
        beatmapsetId &&
        pending.beatmapsetId === beatmapsetId)
    );
  });
}

function isScreenshotMessage(message) {
  return message.attachments?.some((attachment) => {
    const filename = attachment.name ?? "";

    return SCREENSHOT_REGEX.test(filename);
  }) ?? false;
}

function rememberUserMaps(message) {
  const urls = message.content.match(OSU_URL_REGEX) ?? [];

  const entries = [];

  // -----------------------------------------
  // 1. 일반 osu! beatmap URL
  // -----------------------------------------
  for (const url of urls) {
    const parsed = parseOsuUrl(url);

    if (!parsed.beatmapId && !parsed.beatmapsetId) {
      continue;
    }

    entries.push({
      type: "url",
      ...parsed,
      messageId: message.id,
      userId: message.author.id,
      createdAt: Date.now(),
    });
  }

  // -----------------------------------------
  // 2. osu! screenshot
  // -----------------------------------------
  if (isScreenshotMessage(message)) {
    entries.push({
      type: "screenshot",
      beatmapId: null,
      beatmapsetId: null,
      messageId: message.id,
      userId: message.author.id,
      createdAt: Date.now(),
    });

    console.log(
      `${message.author.tag} uploaded an osu! screenshot.`,
    );
  }

  if (entries.length === 0) {
    return false;
  }

  const channelEntries =
    pendingMaps.get(message.channel.id) ?? [];

  const combined = [
    ...channelEntries,
    ...entries,
  ].slice(-MAX_PENDING_MAPS_PER_CHANNEL);

  pendingMaps.set(message.channel.id, combined);

  if (urls.length > 0) {
    console.log(
      `${message.author.tag} shared ${urls.join(", ")}.`,
    );
  }

  return true;
}

function removePendingEntry(channelId, entry) {
  const entries = pendingMaps.get(channelId) ?? [];

  const remaining = entries.filter(
    (item) => item !== entry,
  );

  if (remaining.length === 0) {
    pendingMaps.delete(channelId);
  } else {
    pendingMaps.set(channelId, remaining);
  }
}

async function handleOsuBotMessage(message) {
  if (!isOsuEmbed(message)) {
    return;
  }

  const channelId = message.channel.id;
  const entries = pendingMaps.get(channelId) ?? [];

  if (entries.length === 0) {
    console.log(
      `Received an osu! embed without a pending map: ${message.id}.`,
    );
    return;
  }

  const embedIds = getOsuIdsFromEmbed(message);

  /*
   * 가장 최근 pending부터 확인한다.
   *
   * screenshot은 embed에 URL이 없어도
   * 가장 최근 screenshot 요청으로 매칭된다.
   */
  const pending = [...entries]
    .reverse()
    .find((entry) => mapsMatch(entry, embedIds));

  if (!pending) {
    console.log(
      `Skipped osu! embed for an unmatched map: ${message.id}.`,
    );
    return;
  }

  if (!message.deletable) {
    console.log(
      `Skipped osu! embed because the message is not deletable: ${message.id}.`,
    );
    return;
  }

  try {
    await message.delete();

    removePendingEntry(channelId, pending);

    console.log(
      `Deleted osu! embed: ${message.id} ` +
      `(trigger: ${pending.type}).`,
    );
  } catch (error) {
    console.error(
      `Failed to delete osu! embed ${message.id}:`,
      error,
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

  // 일반 사용자 메시지
  if (!message.author.bot) {
    rememberUserMaps(message);
    return;
  }

  // owo/osu 봇 메시지
  if (message.author.id === OSU_BOT_ID) {
    await handleOsuBotMessage(message);
  }
}

module.exports = {
  handleMessage,
};
